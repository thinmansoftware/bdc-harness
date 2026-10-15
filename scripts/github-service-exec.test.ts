import { describe, expect, test } from 'bun:test';
import { runGitHubServiceCommand } from './github-service-exec';

describe('operation-scoped GitHub CLI authentication', () => {
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
