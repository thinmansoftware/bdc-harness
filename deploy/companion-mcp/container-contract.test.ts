/**
 * Container contract for the companion MCP image
 * (WO-HARNESS-COMPANION-MCP-MAILBOX-01). Static checks always run. The
 * fresh-volume scenario executes only when a local docker daemon answers;
 * otherwise it fails with docker_unavailable.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';

const dir = import.meta.dir;
const repoRoot = join(dir, '../..');
const dockerfile = await Bun.file(join(dir, 'Dockerfile')).text();
const rootDockerfile = await Bun.file(join(repoRoot, 'Dockerfile')).text();
const composeRaw = await Bun.file(join(dir, 'docker-compose.example.yml')).text();

const WORKSPACE_MANIFESTS = [
  'packages/adapters/package.json',
  'packages/canary-suite/package.json',
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/security-watchdog/package.json',
  'packages/docs-web/package.json',
  'packages/fusion/package.json',
  'packages/git/package.json',
  'packages/isolation/package.json',
  'packages/overseer/package.json',
  'packages/paths/package.json',
  'packages/providers/package.json',
  'packages/server/package.json',
  'packages/smart-cauldron/package.json',
  'packages/web/package.json',
  'packages/workflows/package.json',
  'packages/persona-context-loader/package.json',
  'packages/companion-mcp/package.json',
];

const COMPANION_MANIFEST_COPY =
  'COPY packages/companion-mcp/package.json ./packages/companion-mcp/';

interface ComposeService {
  container_name?: string;
  user?: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  build?: { args?: Record<string, string> };
}

const compose = parse(composeRaw) as { services: Record<string, ComposeService> };
const service = compose.services['bdc-companion-mcp'];

describe('companion-mcp Dockerfile contract', () => {
  test('runs as a named non-root user', () => {
    expect(dockerfile).toMatch(/^USER companion$/m);
    expect(dockerfile).toMatch(/--uid 10001/);
    expect(dockerfile).not.toMatch(/^USER root$/m);
  });

  test('BUILD_SHA is required and has no placeholder default', () => {
    expect(dockerfile).toMatch(/^ARG BUILD_SHA$/m);
    expect(dockerfile).not.toMatch(/^ARG BUILD_SHA=/m);
    expect(dockerfile).toMatch(/test -n "\$\{BUILD_SHA\}"/);
  });

  test('prepares a private audit directory and installs git before the service user', () => {
    expect(dockerfile).toContain('/var/lib/companion-mcp');
    expect(dockerfile).toContain('chown -R companion:companion /app /var/lib/companion-mcp');
    expect(dockerfile).toContain('chmod 0750 /var/lib/companion-mcp');
    expect(dockerfile).not.toContain('0777');
    expect(dockerfile).not.toContain('chmod a+rwx');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends git');
    expect(dockerfile).toContain('rm -rf /var/lib/apt/lists/*');
    const userAt = dockerfile.indexOf('\nUSER companion\n');
    const auditAt = dockerfile.indexOf('chmod 0750 /var/lib/companion-mcp');
    const gitAt = dockerfile.indexOf('apt-get install -y --no-install-recommends git');
    expect(auditAt).toBeGreaterThan(-1);
    expect(gitAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(auditAt);
    expect(userAt).toBeGreaterThan(gitAt);
  });

  test('copies every workspace manifest before the frozen install and only companion source after', () => {
    const installAt = dockerfile.indexOf('bun install --frozen-lockfile');
    expect(installAt).toBeGreaterThan(-1);
    let previous = -1;
    for (const manifest of WORKSPACE_MANIFESTS) {
      const at = dockerfile.indexOf(`COPY ${manifest} ./`);
      expect(at).toBeGreaterThan(previous);
      expect(at).toBeLessThan(installAt);
      previous = at;
    }
    const sourceAt = dockerfile.indexOf('COPY packages/companion-mcp ./packages/companion-mcp');
    expect(sourceAt).toBeGreaterThan(installAt);
    expect(dockerfile).not.toContain('COPY packages/core/ ./');
    expect(dockerfile).not.toContain('COPY packages/server/ ./');
  });
});

describe('root image manifest packaging', () => {
  test('copies the companion workspace manifest in both install stages only', () => {
    const lines = rootDockerfile
      .split('\n')
      .filter(line => line.includes('packages/companion-mcp'));
    expect(lines).toEqual([COMPANION_MANIFEST_COPY, COMPANION_MANIFEST_COPY]);
    expect(rootDockerfile).not.toContain('COPY packages/companion-mcp/ ./');
    expect(rootDockerfile).not.toContain('COPY packages/companion-mcp ./');
  });
});

describe('companion-mcp compose contract', () => {
  test('publishes only a tailnet-bound port', () => {
    expect(service).toBeDefined();
    expect(service?.container_name).toBe('bdc-companion-mcp');
    expect(composeRaw).toContain('COMPANION_MCP_TAILNET_IP:?');
    expect(composeRaw).toContain(':3095:3095');
    expect(composeRaw).not.toContain('0.0.0.0:3095');
    expect(composeRaw).not.toMatch(/["']3095:3095["']/);
    expect(service?.ports).toHaveLength(1);
  });

  test('requires BUILD_SHA and a non-wildcard bind address', () => {
    expect(composeRaw).toContain('BUILD_SHA:?');
    expect(composeRaw).not.toContain('BUILD_SHA:-');
    expect(service?.environment?.COMPANION_MCP_BIND_ADDR).toContain('COMPANION_MCP_BIND_ADDR:?');
    expect(service?.environment?.DISPATCH_BASE_URL).toBe('http://archon-app-1:3090');
  });

  test('has no env file and no archon secret or operator token mount', () => {
    expect(composeRaw).not.toMatch(/^env_file:/m);
    expect(composeRaw).not.toMatch(/\n\s+env_file:/);
    expect(composeRaw).not.toContain('/opt/bdc/archon');
    expect(composeRaw).not.toContain('archon-secrets');
    expect(composeRaw).not.toContain('operator-token');
    expect(composeRaw).not.toContain('operator_token');
  });

  test('credential mounts are read-only and only the audit volume is writable', () => {
    const volumes = service?.volumes ?? [];
    const readOnly = volumes.filter(volume => volume.endsWith(':ro'));
    expect(readOnly.some(volume => volume.includes('/var/lib/companion-wiki'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('companions.json'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('/run/companion-mcp/digests'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('/run/companion-mcp/dispatch'))).toBe(true);
    expect(readOnly.some(volume => volume.includes('github-token'))).toBe(true);
    const writable = volumes.filter(volume => !volume.endsWith(':ro'));
    expect(writable).toEqual(['companion-mcp-audit:/var/lib/companion-mcp']);
  });
});

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCommand(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function dockerAvailable(): Promise<boolean> {
  try {
    const result = await runCommand(['docker', 'info']);
    return result.code === 0;
  } catch {
    return false;
  }
}

function listenStub(): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  const hits = { count: 0 };
  const server: Server = createServer((req, res) => {
    hits.count += 1;
    req.resume();
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('stub_bind_failed'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits: () => hits.count,
        close: async (): Promise<void> => {
          await new Promise<void>((done, fail) => {
            server.close(error => {
              if (error) {
                fail(error);
                return;
              }
              done();
            });
          });
        },
      });
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('port_failed');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function waitHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = 'none';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch_failed';
    }
    await new Promise(resolve => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`companion_not_ready:${last}`);
}

const PAGE = [
  'ordinary tracked page',
  '-----BEGIN PRIVATE KEY-----',
  'not-a-real-key',
  '-----END PRIVATE KEY-----',
].join('\n');

describe('companion image fresh audit volume', () => {
  test('refused and permitted calls write scrubbed audit lines', async () => {
    if (!(await dockerAvailable())) {
      throw new Error('docker_unavailable');
    }
    const suffix = randomUUID().slice(0, 8);
    const image = 'bdc-companion-mcp:repair';
    const container = `bdc-companion-mcp-repair-${suffix}`;
    const volume = `bdc-companion-mcp-audit-${suffix}`;
    const token = 'synthetic-bearer-token-value';
    const fixture = await mkdtemp(join(tmpdir(), 'companion-mcp-image-'));
    const wiki = join(fixture, 'wiki');
    const oracle = await listenStub();
    const dispatch = await listenStub();
    let port = 0;
    try {
      await mkdir(join(wiki, 'xo-wiki/wiki'), { recursive: true });
      await writeFile(join(wiki, 'xo-wiki/wiki/page.md'), `${PAGE}\n`, 'utf8');
      await runCommand(['git', '-C', wiki, 'init', '-b', 'main']);
      await runCommand([
        'git',
        '-C',
        wiki,
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        'add',
        '--',
        'xo-wiki/wiki/page.md',
      ]);
      const committed = await runCommand([
        'git',
        '-C',
        wiki,
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-m',
        'init',
      ]);
      expect(committed.code).toBe(0);
      await runCommand(['chmod', '-R', 'a+rX', wiki]);
      const digest = createHash('sha256').update(token).digest('hex');
      await writeFile(join(fixture, 'grokbot.sha256'), `${digest}\n`, 'utf8');
      await writeFile(join(fixture, 'grokbot.token'), 'synthetic-dispatch-credential\n', 'utf8');
      await writeFile(join(fixture, 'revoked.json'), '[]\n', 'utf8');
      await writeFile(join(fixture, 'github-token'), 'synthetic-github-token\n', 'utf8');
      const config = {
        slots: [
          {
            companion_id: 'grokbot',
            enabled: true,
            dispatch_principal_id: 'grokbot',
            token_sha256_file: '/run/companion-mcp/digests/grokbot.sha256',
            token_expires_at: '2099-01-01T00:00:00.000Z',
            dispatch_credential_file: '/run/companion-mcp/dispatch/grokbot',
            tools: ['wiki_read'],
            allowed_recipients: ['xo'],
            board_secretary: false,
            board_seat_recipients: ['astra'],
          },
        ],
      };
      await writeFile(join(fixture, 'companions.json'), JSON.stringify(config), 'utf8');
      const built = await runCommand([
        'docker',
        'build',
        '-f',
        'deploy/companion-mcp/Dockerfile',
        '--build-arg',
        'BUILD_SHA=repair',
        '-t',
        image,
        repoRoot,
      ]);
      if (built.code !== 0) {
        throw new Error(built.stderr.slice(-2000));
      }
      const created = await runCommand(['docker', 'volume', 'create', volume]);
      expect(created.code).toBe(0);
      port = await freePort();
      const started = await runCommand([
        'docker',
        'run',
        '-d',
        '--name',
        container,
        '--user',
        '10001:10001',
        '--network',
        'host',
        '-e',
        'COMPANION_MCP_BIND_ADDR=127.0.0.1',
        '-e',
        `COMPANION_MCP_PORT=${port}`,
        '-e',
        'COMPANION_MCP_CONFIG=/run/companion-mcp/companions.json',
        '-e',
        'COMPANION_MCP_AUDIT_LOG=/var/lib/companion-mcp/audit.log',
        '-e',
        'COMPANION_MCP_REVOKED_FILE=/run/companion-mcp/revoked.json',
        '-e',
        'COMPANION_WIKI_ROOT=/wiki',
        '-e',
        `ORACLE_URL=${oracle.url}`,
        '-e',
        `DISPATCH_BASE_URL=${dispatch.url}`,
        '-e',
        'COMPANION_BOARD_REPO=thinmansoftware/bdc-xo',
        '-e',
        'COMPANION_BOARD_BASE=main',
        '-e',
        'COMPANION_GITHUB_TOKEN_FILE=/run/companion-mcp/github-token',
        '-e',
        'GIT_CONFIG_COUNT=1',
        '-e',
        'GIT_CONFIG_KEY_0=safe.directory',
        '-e',
        'GIT_CONFIG_VALUE_0=*',
        '-v',
        `${join(fixture, 'companions.json')}:/run/companion-mcp/companions.json:ro`,
        '-v',
        `${wiki}:/wiki:ro`,
        '-v',
        `${join(fixture, 'grokbot.sha256')}:/run/companion-mcp/digests/grokbot.sha256:ro`,
        '-v',
        `${join(fixture, 'grokbot.token')}:/run/companion-mcp/dispatch/grokbot:ro`,
        '-v',
        `${join(fixture, 'revoked.json')}:/run/companion-mcp/revoked.json:ro`,
        '-v',
        `${join(fixture, 'github-token')}:/run/companion-mcp/github-token:ro`,
        '-v',
        `${volume}:/var/lib/companion-mcp`,
        image,
      ]);
      if (started.code !== 0) {
        throw new Error(started.stderr.slice(-2000));
      }
      try {
        await waitHealth(port);
      } catch (error) {
        const logs = await runCommand(['docker', 'logs', container]);
        const detail = error instanceof Error ? error.message : 'not_ready';
        throw new Error(`${detail}\n${logs.stderr.slice(-2000)}\n${logs.stdout.slice(-2000)}`);
      }
      const denied = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(denied.status).toBe(401);
      const client = new Client({ name: 'companion-contract', version: '0.0.1' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      try {
        const result = await client.callTool({
          name: 'wiki_read',
          arguments: { path: 'xo-wiki/wiki/page.md' },
        });
        const content = 'content' in result && Array.isArray(result.content) ? result.content : [];
        const textItem = content.find(item => item.type === 'text');
        const text = textItem !== undefined && textItem.type === 'text' ? textItem.text : '';
        expect(text).toContain('ordinary tracked page');
        expect(text).toContain('[REDACTED]');
        expect(text).not.toContain('not-a-real-key');
        expect(text).not.toContain('BEGIN PRIVATE KEY');
      } finally {
        await client.close();
      }
      expect(oracle.hits()).toBe(0);
      expect(dispatch.hits()).toBe(0);
      const inspected = await runCommand([
        'docker',
        'run',
        '--rm',
        '--user',
        '10001:10001',
        '--network',
        'none',
        '-v',
        `${volume}:/var/lib/companion-mcp:ro`,
        '--entrypoint',
        'bun',
        image,
        '-e',
        [
          'import { readFileSync, statSync } from "node:fs";',
          'const st = statSync("/var/lib/companion-mcp");',
          'const log = readFileSync("/var/lib/companion-mcp/audit.log", "utf8");',
          'process.stdout.write(JSON.stringify({ mode: st.mode & 511, uid: st.uid, log }));',
        ].join(' '),
      ]);
      if (inspected.code !== 0) {
        throw new Error(inspected.stderr.slice(-2000));
      }
      const evidence = JSON.parse(inspected.stdout) as { mode: number; uid: number; log: string };
      expect(evidence.uid).toBe(10001);
      expect(evidence.mode).toBe(0o750);
      expect(evidence.mode & 0o002).toBe(0);
      const lines = evidence.log
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as { outcome?: string });
      expect(lines.map(line => line.outcome).sort()).toEqual(['ok', 'refused']);
      expect(evidence.log).not.toContain(token);
      expect(evidence.log).not.toContain('not-a-real-key');
      expect(evidence.log).not.toContain('BEGIN PRIVATE KEY');
      expect(evidence.log).not.toContain('synthetic-dispatch-credential');
      expect(evidence.log).not.toContain('synthetic-github-token');
    } finally {
      await runCommand(['docker', 'rm', '-f', container]);
      await runCommand(['docker', 'volume', 'rm', '-f', volume]);
      await oracle.close();
      await dispatch.close();
      await rm(fixture, { recursive: true, force: true });
    }
  }, 900000);
});
