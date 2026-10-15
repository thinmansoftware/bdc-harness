import { describe, expect, test } from 'bun:test';
import { runGitHubServiceCommand } from './github-service-exec';

describe('operation-scoped GitHub CLI authentication', () => {
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
