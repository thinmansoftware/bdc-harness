import { describe, expect, test } from 'bun:test';
import { runGitHubServiceCommand } from './github-service-exec';
import { serviceGitHubCommandEnvironment } from '../packages/core/src/github/service-identity';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('operation-scoped GitHub CLI authentication', () => {
  test('Smart Cauldron override survives the actual container wrapper and keeps PAT fallback', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const original = {
      GH_TOKEN: 'synthetic-original-pat',
      GITHUB_TOKEN: 'synthetic-original-pat',
      GITHUB_APP_ID: '1',
      GITHUB_APP_INSTALLATION_ID: '2',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_SMART_CAULDRON_ID: '3',
      GITHUB_APP_SMART_CAULDRON_INSTALLATION_ID: '4',
      GITHUB_APP_SMART_CAULDRON_PRIVATE_KEY: privateKey,
    };
    const token = async (
      identity: Parameters<NonNullable<Parameters<typeof runGitHubServiceCommand>[0]['token']>>[0]
    ): Promise<string> =>
      identity.kind === 'app' ? `synthetic-app-${identity.appId}` : 'synthetic-original-pat';
    const auth = await serviceGitHubCommandEnvironment('smart_cauldron', original, token);
    expect(auth.poolId).toBe('app-3-4');
    const directory = mkdtempSync(join(tmpdir(), 'github-service-wrapper-'));
    const unix = (path: string): string =>
      path
        .replaceAll('\\', '/')
        .replace(/^([A-Za-z]):/, (_all, drive: string) => `/${drive.toLowerCase()}`);
    try {
      writeFileSync(join(directory, 'bun'), '#!/usr/bin/env bash\nprintf "%s\\n" "$2"\n', {
        mode: 0o755,
      });
      const guard = unix(join(import.meta.dir, 'container/gh-merge-guard.sh'));
      const routed = Bun.spawnSync({
        cmd: [
          'bash',
          '-c',
          `export PATH='${unix(directory)}':"$PATH"; source '${guard}' "$@"`,
          'guard',
          'pr',
          'list',
        ],
        env: {
          ...auth.env,
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GH_GUARD_REAL_GH: 'unused-synthetic-gh',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(routed.exitCode).toBe(0);
      const service = new TextDecoder().decode(routed.stdout).trim();
      expect(service).toBe('smart_cauldron');
      const used: string[] = [];
      await runGitHubServiceCommand({
        service: service as 'smart_cauldron',
        command: 'synthetic-gh',
        args: ['issue', 'comment', '1'],
        env: auth.env,
        token,
        execute: (_cmd, env) => {
          used.push(env.GH_TOKEN ?? '');
          const denied = used.length === 1;
          return {
            exitCode: denied ? 1 : 0,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(
              denied ? 'Resource not accessible by integration (HTTP 403)' : ''
            ),
          };
        },
      });
      expect(used).toEqual(['synthetic-app-3', 'synthetic-original-pat']);
      expect(original.GH_TOKEN).toBe('synthetic-original-pat');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('the real command driver forwards piped request input without a provider call', () => {
    const payload = '{"body":"synthetic stdin regression"}';
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        `${import.meta.dir}/github-service-exec.ts`,
        'run_nodes',
        process.execPath,
        '-e',
        'process.stdout.write(await Bun.stdin.text())',
      ],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GH_TOKEN: 'synthetic-pat',
        GITHUB_TOKEN: 'synthetic-pat',
      },
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(payload);
  });
  test('the real permission retry replays the same stdin bytes', () => {
    const payload = '{"body":"permission retry input"}';
    const child = `const input = await Bun.stdin.text();
      if (process.env.GH_TOKEN === 'synthetic-app') {
        console.error('Resource not accessible by integration (HTTP 403)'); process.exit(1);
      }
      process.stdout.write(input);`;
    const driver = `import { runGitHubServiceCommand } from ${JSON.stringify(`${import.meta.dir}/github-service-exec.ts`)};
      const result = await runGitHubServiceCommand({service:'run_nodes', command:process.execPath,
        args:['-e',${JSON.stringify(child)}], stdin:await Bun.stdin.bytes(),
        identity:{kind:'app',service:'run_nodes',appId:'1',installationId:'2',privateKey:'unused',poolId:'synthetic',distinct:true},
        token:async()=> 'synthetic-app'});
      await Bun.write(Bun.stdout,result.stdout); process.exitCode=result.exitCode;`;
    const result = Bun.spawnSync({
      cmd: [process.execPath, '-e', driver],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GH_TOKEN: 'synthetic-pat',
        GITHUB_TOKEN: 'synthetic-pat',
      },
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(payload);
  });
  for (const reason of ['permission', 'rate_limit', 'transport']) {
    test(`preserves parent credentials and retries only permission denial (${reason})`, async () => {
      const parent = { GH_TOKEN: 'original-pat', GITHUB_TOKEN: 'original-pat' };
      const used: string[] = [];
      let mints = 0;
      const input = {
        service: 'run_nodes' as const,
        command: 'gh',
        args: ['issue', 'comment', '1'],
        env: parent,
        identity: {
          kind: 'app' as const,
          service: 'run_nodes' as const,
          appId: '1',
          installationId: '2',
          privateKey: 'unused-synthetic',
          poolId: 'app-1-2',
          distinct: true as const,
        },
        token: async () => `app-${++mints}`,
        execute: (_command: string[], env: Record<string, string | undefined>) => {
          used.push(env.GH_TOKEN ?? '');
          const denied = env.GH_TOKEN !== 'original-pat';
          const error =
            reason === 'permission'
              ? 'Resource not accessible by integration (HTTP 403)'
              : reason === 'rate_limit'
                ? 'API rate limit exceeded (HTTP 403)'
                : 'connection reset';
          return {
            exitCode: denied ? 1 : 0,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode(denied ? error : ''),
          };
        },
      };
      await runGitHubServiceCommand(input);
      expect(used).toEqual(reason === 'permission' ? ['app-1', 'original-pat'] : ['app-1']);
      expect(parent).toEqual({ GH_TOKEN: 'original-pat', GITHUB_TOKEN: 'original-pat' });
      await runGitHubServiceCommand(input);
      expect(mints).toBe(2);
      expect(used).toContain('app-2');
    });
  }
});
