import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { BASE_TOOL_NAMES, BOARD_TOOL_NAMES, secretaryLabel } from './constants';
import { startCompanionMcp, type RunningCompanionServer } from './server';

export interface CompanionTokens {
  grokbot: string;
  dot: string;
  muse: string;
  duet: string;
}

export interface Harness {
  dir: string;
  wikiRoot: string;
  configPath: string;
  auditLog: string;
  revokedFile: string;
  githubTokenFile: string;
  tokens: CompanionTokens;
  dispatchToken: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

export interface RecordedHttpRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface RecordingServer {
  url: string;
  requests: RecordedHttpRequest[];
  close: () => Promise<void>;
}

export const SECRET_PAGE = [
  'keep-me',
  'prefix ghp_abcdefghijklmnopqrstuvwxyz012345 suffix',
  'prefix sk-ant-abcdefghijklmnopqrstuvwxyz suffix',
  'prefix sk_live_abcdefghijklmnopqrst suffix',
  'prefix rk_live_abcdefghijklmnopqrst suffix',
  'prefix sk_test_abcdefghijklmnopqrst suffix',
  'prefix github_pat_abcdefghijklmnop suffix',
  'prefix xoxb-abcdefghijklmnopqrstuvwxyz suffix',
  'prefix AKIAIOSFODNN7EXAMPLE suffix',
  'Authorization: Bearer abcdefghijklmnop',
  '-----BEGIN PRIVATE KEY-----',
  'not-a-real-key',
  '-----END PRIVATE KEY-----',
  'prefix eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signatureok suffix',
  'prefix https://user:pass@example.com/resource suffix',
  'prefix https://gho_tokensecret@github.com/thinmansoftware/bdc-xo suffix',
].join('\n');

export const BASE_REGISTER = [
  '# Motion register',
  '',
  '| id | status | note |',
  '| --- | --- | --- |',
  '| M-1 | RATIFIED | historical |',
  '| M-2 | CARRIED | historical |',
  '',
].join('\n');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== 'GIT_DIR' &&
      key !== 'GIT_WORK_TREE' &&
      key !== 'GIT_INDEX_FILE'
    ) {
      env[key] = value;
    }
  }
  return env;
}

async function git(root: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnv(),
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function secretaryText(companionId = 'grokbot'): string {
  return secretaryLabel(companionId);
}

export async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'companion-mcp-'));
  const wikiRoot = join(dir, 'wiki');
  const runDir = join(dir, 'run');
  const digestDir = join(runDir, 'digests');
  const dispatchDir = join(runDir, 'dispatch');
  await mkdir(join(wikiRoot, 'xo-wiki/wiki'), { recursive: true });
  await mkdir(join(wikiRoot, 'docs/board/motions'), { recursive: true });
  await mkdir(join(wikiRoot, 'docs/board/design-rounds'), { recursive: true });
  await mkdir(digestDir, { recursive: true });
  await mkdir(dispatchDir, { recursive: true });
  const tokens: CompanionTokens = {
    grokbot: 'grokbot-plaintext-token-do-not-log',
    dot: 'dot-plaintext-token-do-not-log',
    muse: 'muse-plaintext-token-do-not-log',
    duet: 'duet-plaintext-token-do-not-log',
  };
  const dispatchToken = 'dispatch-plaintext-credential-do-not-log';
  for (const [id, token] of Object.entries(tokens)) {
    await writeFile(join(digestDir, `${id}.sha256`), `${sha256(token)}\n`, 'utf8');
    await writeFile(join(dispatchDir, id), `${dispatchToken}\n`, 'utf8');
  }
  await writeFile(join(wikiRoot, 'xo-wiki/wiki/a.md'), 'alpha tracked page\n', 'utf8');
  await writeFile(join(wikiRoot, 'xo-wiki/wiki/secrets.md'), SECRET_PAGE, 'utf8');
  await writeFile(
    join(wikiRoot, 'docs/board/motions/M-READ.discussion.md'),
    'board tracked note\n',
    'utf8'
  );
  const outside = join(dir, 'outside-secret.txt');
  await writeFile(outside, 'OUTSIDE-SECRET-CONTENT\n', 'utf8');
  await symlink(outside, join(wikiRoot, 'xo-wiki/wiki/outside.md'));
  await git(wikiRoot, ['init', '-b', 'main']);
  await git(wikiRoot, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    'add',
    '--',
    'xo-wiki/wiki/a.md',
    'xo-wiki/wiki/secrets.md',
    'xo-wiki/wiki/outside.md',
    'docs/board/motions/M-READ.discussion.md',
  ]);
  await git(wikiRoot, [
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
  await writeFile(join(wikiRoot, 'xo-wiki/wiki/secret.md'), 'UNTRACKED-SECRET-CONTENT\n', 'utf8');
  const configPath = join(dir, 'companions.json');
  const auditLog = join(dir, 'audit.log');
  const revokedFile = join(dir, 'revoked.json');
  const githubTokenFile = join(runDir, 'github-token');
  await writeFile(revokedFile, '[]\n', 'utf8');
  await writeFile(githubTokenFile, 'github-test-token\n', 'utf8');
  await writeFile(auditLog, '', 'utf8');
  const config = buildConfig({
    digestDir,
    dispatchDir,
    enabled: { grokbot: true, dot: false, muse: false, duet: false },
    boardSecretary: { grokbot: true, dot: false, muse: false, duet: false },
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  const env: Record<string, string> = {
    COMPANION_MCP_BIND_ADDR: '127.0.0.1',
    COMPANION_MCP_PORT: '0',
    COMPANION_MCP_CONFIG: configPath,
    COMPANION_MCP_AUDIT_LOG: auditLog,
    COMPANION_MCP_REVOKED_FILE: revokedFile,
    COMPANION_WIKI_ROOT: wikiRoot,
    ORACLE_URL: 'http://127.0.0.1:9/oracle',
    DISPATCH_BASE_URL: 'http://127.0.0.1:9',
    COMPANION_BOARD_REPO: 'thinmansoftware/bdc-xo',
    COMPANION_BOARD_BASE: 'main',
    COMPANION_GITHUB_TOKEN_FILE: githubTokenFile,
    COMPANION_GITHUB_API_BASE: 'http://127.0.0.1:9',
  };
  return {
    dir,
    wikiRoot,
    configPath,
    auditLog,
    revokedFile,
    githubTokenFile,
    tokens,
    dispatchToken,
    env,
    cleanup: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function writeConfig(harness: Harness, config: unknown): Promise<void> {
  await writeFile(harness.configPath, JSON.stringify(config, null, 2), 'utf8');
}

export function buildConfig(input: {
  digestDir: string;
  dispatchDir: string;
  enabled: Record<string, boolean>;
  boardSecretary: Record<string, boolean>;
  expiresAt: string;
}): { slots: Record<string, unknown>[] } {
  const ids = ['grokbot', 'dot', 'muse', 'duet'] as const;
  return {
    slots: ids.map(id => ({
      companion_id: id,
      enabled: input.enabled[id] ?? false,
      dispatch_principal_id: id,
      token_sha256_file: join(input.digestDir, `${id}.sha256`),
      token_expires_at: input.expiresAt,
      dispatch_credential_file: join(input.dispatchDir, id),
      tools: input.boardSecretary[id]
        ? [...BASE_TOOL_NAMES, ...BOARD_TOOL_NAMES]
        : [...BASE_TOOL_NAMES],
      allowed_recipients: ['xo', 'astra'],
      board_secretary: input.boardSecretary[id] ?? false,
      board_seat_recipients: ['astra', 'fable', 'grok'],
    })),
  };
}

export async function startRecordingServer(
  handler: (request: RecordedHttpRequest) => { status: number; body: unknown }
): Promise<RecordingServer> {
  const requests: RecordedHttpRequest[] = [];
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub.local');
    const recorded: RecordedHttpRequest = {
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      body: await readBody(req),
    };
    requests.push(recorded);
    const result = handler(recorded);
    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub_bind_failed');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function startFromHarness(
  harness: Harness,
  patch: Record<string, string> = {}
): Promise<RunningCompanionServer> {
  return startCompanionMcp({ ...harness.env, ...patch });
}

export async function withClient(
  baseUrl: string,
  token: string,
  fn: (client: Client) => Promise<void>
): Promise<void> {
  const client = new Client({ name: 'companion-test', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

export async function callToolText(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  if (!('content' in result) || !Array.isArray(result.content)) {
    throw new Error('tool result had no content');
  }
  const text = result.content.find(item => item.type === 'text');
  if (text === undefined || text.type !== 'text') {
    throw new Error('tool result had no text');
  }
  const rawText: unknown = text.text;
  if (typeof rawText !== 'string') {
    throw new Error('tool result had no text');
  }
  return rawText;
}

export function parseToolJson(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('tool json was not an object');
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    record[key] = value;
  }
  return record;
}
