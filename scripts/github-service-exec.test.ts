import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  githubCommandReadsStdin,
  runGitHubServiceCommand as runCommand,
} from './github-service-exec';
import { githubCommandChangesPullRequestAuthorship } from './github-service-exec';
import { serviceGitHubCommandEnvironment } from '../packages/core/src/github/service-identity';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flushGitHubApiMeter,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
} from '../packages/core/src/github/metering';
import { SqliteAdapter } from '../packages/core/src/db/adapters/sqlite';
import { execFile } from 'node:child_process';

let db: SqliteAdapter;
beforeEach(() => {
  db = new SqliteAdapter(':memory:');
});
afterEach(async () => {
  resetGitHubApiMeterForTests();
  await db.close();
});
const runGitHubServiceCommand = (
  input: Parameters<typeof runCommand>[0]
): ReturnType<typeof runCommand> => runCommand({ ...input, db });

describe('complete REST pull-list quota admission', () => {
  const args = [
    'api',
    'repos/synthetic/test/pulls?state=all&per_page=100&sort=created&direction=asc',
    '--paginate',
    '--slurp',
  ];
  const identity = {
    kind: 'pat' as const,
    service: 'smart_cauldron' as const,
    token: 'synthetic-pat',
    poolId: 'user-pat' as const,
    distinct: false as const,
  };
  const exhaust = async (resource: string, poolId: string = identity.poolId): Promise<void> => {
    recordGitHubApiCall({
      service: identity.service,
      poolId,
      resource,
      status: 200,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 3600,
    });
    await flushGitHubApiMeter(db);
    // Prove admission reads durable quota, not just this process's cache.
    resetGitHubApiMeterForTests();
  };

  for (const command of ['gh', '/usr/bin/gh', 'C:\\Program Files\\GitHub CLI\\gh.exe']) {
    test(`exhausted Search permits explicit REST pulls and meters core (${command})`, async () => {
      await exhaust('search');
      let launches = 0;
      const result = await runGitHubServiceCommand({
        service: identity.service,
        identity,
        command,
        args,
        execute: (argv, env) => {
          launches += 1;
          expect(argv).toEqual([command, ...args]);
          expect(env.GH_TOKEN).toBe(identity.token);
          return {
            exitCode: 0,
            stdout: new TextEncoder().encode('[[]]'),
            stderr: new TextEncoder().encode(
              '* Request at synthetic\n< HTTP/2 200\n< x-ratelimit-resource: core\n< x-ratelimit-remaining: 4999\n* Request took synthetic\n'
            ),
          };
        },
      });
      expect(result.exitCode).toBe(0);
      expect(launches).toBe(1);
      const usage = await db.query<{ calls: number }>(
        "SELECT calls FROM github_api_usage WHERE pool_id = $1 AND resource = 'core'",
        [identity.poolId]
      );
      expect(usage.rows[0]?.calls).toBe(1);
      const search = await db.query<{ remaining: number }>(
        "SELECT remaining FROM github_api_pool_state WHERE pool_id = $1 AND resource = 'search'",
        [identity.poolId]
      );
      expect(search.rows[0]?.remaining).toBe(0);
    });
  }

  for (const resource of ['core', 'cli']) {
    test(`exhausted ${resource} still blocks explicit REST pulls before launch`, async () => {
      await exhaust(resource);
      let launches = 0;
      await expect(
        runGitHubServiceCommand({
          service: identity.service,
          identity,
          command: 'gh',
          args,
          execute: () => {
            launches += 1;
            throw new Error('must not launch');
          },
        })
      ).rejects.toThrow(`github_pool_backoff:${identity.poolId}/${resource}`);
      expect(launches).toBe(0);
    });
  }

  test('permission retry executes the classified snapshot despite caller mutation during token mint', async () => {
    await exhaust('search');
    await exhaust('search', 'app-1-2');
    const commandArgs = [...args];
    const commands: string[][] = [];
    const tokens: (string | undefined)[] = [];
    const input: Parameters<typeof runCommand>[0] = {
      service: identity.service,
      command: '/usr/bin/gh',
      args: commandArgs,
      env: { ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN: 'synthetic-fallback' },
      identity: {
        kind: 'app',
        service: identity.service,
        poolId: 'app-1-2',
        appId: '1',
        installationId: '2',
        privateKey: 'unused',
        distinct: true,
      },
      token: async () => {
        input.command = 'synthetic-other-command';
        commandArgs.splice(0, commandArgs.length, 'api', 'search/issues?q=synthetic');
        return 'synthetic-app';
      },
      execute: (command, env) => {
        commands.push(command);
        tokens.push(env.GH_TOKEN);
        return {
          exitCode: commands.length === 1 ? 1 : 0,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode(
            commands.length === 1 ? 'Resource not accessible by integration (HTTP 403)' : ''
          ),
        };
      },
    };
    const result = await runGitHubServiceCommand(input);
    expect(result.exitCode).toBe(0);
    expect(commands).toEqual([
      ['/usr/bin/gh', ...args],
      ['/usr/bin/gh', ...args],
    ]);
    expect(tokens).toEqual(['synthetic-app', 'synthetic-fallback']);
  });

  test('an unexpected traced Search response remains metered and blocks a later unknown command', async () => {
    await runGitHubServiceCommand({
      service: identity.service,
      identity,
      command: 'gh',
      args,
      execute: () => ({
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode(
          `* Request at synthetic\n< HTTP/2 403\n< x-ratelimit-resource: search\n< x-ratelimit-remaining: 0\n< x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 3600}\n* Request took synthetic\n`
        ),
      }),
    });
    const usage = await db.query<{ calls: number; rate_limited: number }>(
      "SELECT calls, rate_limited FROM github_api_usage WHERE pool_id = $1 AND resource = 'search'",
      [identity.poolId]
    );
    expect(usage.rows[0]).toMatchObject({ calls: 1, rate_limited: 1 });
    await expect(
      runGitHubServiceCommand({
        service: identity.service,
        identity,
        command: 'gh',
        args: ['pr', 'list'],
        execute: () => {
          throw new Error('must not launch');
        },
      })
    ).rejects.toThrow(`github_pool_backoff:${identity.poolId}/search`);
  });

  for (const candidate of [
    { command: 'synthetic-gh', args },
    { command: 'gh', args: ['api', 'search/issues?q=synthetic'] },
    { command: 'gh', args: ['pr', 'list', '--search', 'WO-SYNTHETIC'] },
    { command: 'gh', args: [...args, '--method', 'POST'] },
    { command: 'gh', args: [...args, '--hostname', 'example.invalid'] },
    { command: 'gh', args: [...args, '--field', 'x=y'] },
    { command: 'gh', args: [...args, '--input=-'] },
    { command: 'gh', args: args.slice(0, -1) },
    { command: 'gh', args: ['api', 'graphql', '--paginate', '--slurp'] },
    ...[
      'repos/synthetic/../pulls?state=all&per_page=100&sort=created&direction=asc',
      'repos/synthetic/%2e%2e/pulls?state=all&per_page=100&sort=created&direction=asc',
      'repos/{owner}/{repo}/pulls?state=all&per_page=100&sort=created&direction=asc',
      'https://api.github.com/repos/synthetic/test/pulls?state=all&per_page=100&sort=created&direction=asc',
      'repos/synthetic/test/pulls?state=all&per_page=100&sort=created&direction=asc&extra=1',
      'repos/synthetic/test/pulls/1/merge',
      'repos/synthetic/test/pulls?state=all&per_page=100&sort=created&direction=asc\n',
      'repos/synthetic/test repo/pulls?state=all&per_page=100&sort=created&direction=asc',
    ].map(endpoint => ({ command: 'gh', args: ['api', endpoint, '--paginate', '--slurp'] })),
  ]) {
    test(`ambiguous command retains Search gate (${candidate.command} ${candidate.args.join(' ')})`, async () => {
      await exhaust('search');
      let launches = 0;
      await expect(
        runGitHubServiceCommand({
          service: identity.service,
          identity,
          ...candidate,
          execute: () => {
            launches += 1;
            throw new Error('must not launch');
          },
        })
      ).rejects.toThrow(`github_pool_backoff:${identity.poolId}/search`);
      expect(launches).toBe(0);
    });
  }
});

describe('operation-scoped GitHub CLI authentication', () => {
  test('buffers declared gh stdin sources and leaves ordinary query arguments alone', () => {
    for (const args of [
      ['api', 'repos/synthetic/test', '--input', '-'],
      ['api', 'repos/synthetic/test', '--input=-'],
      ['issue', 'comment', '1', '--body-file', '-'],
      ['issue', 'comment', '1', '--body-file=-'],
      ['api', 'graphql', '-F', 'query=@-'],
      ['api', 'graphql', '--field', 'query=@-'],
      ['api', 'graphql', '--field=query=@-'],
      ['api', 'graphql', '-Fquery=@-'],
      ['auth', 'login', '--with-token'],
      ['workflow', 'run', 'synthetic.yml', '--json'],
      ['gist', 'create', '-'],
    ]) {
      expect(githubCommandReadsStdin(args)).toBe(true);
    }
    for (const args of [
      ['pr', 'list', '--json', 'url'],
      ['pr', 'view', '1', '--json', 'mergeable'],
      ['issue', 'comment', '1', '--body', '-'],
      ['api', 'repos/synthetic/test', '--input', 'body.json'],
    ]) {
      expect(githubCommandReadsStdin(args)).toBe(false);
    }
  });
  test('execFile commands finish while their unused stdin pipe remains open', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'github-service-open-stdin-'));
    try {
      const result = await new Promise<{ error: Error | null; stdout: string }>(resolve => {
        // Match Smart Cauldron: execFile creates a pipe, and the caller never
        // writes to or closes child.stdin. No real GitHub request is made.
        execFile(
          process.execPath,
          [
            `${import.meta.dir}/github-service-exec.ts`,
            'smart_cauldron',
            process.execPath,
            '-e',
            'process.stdout.write("synthetic-pr-result")',
          ],
          {
            // This real CLI also initializes its disposable SQLite database.
            // Keep a finite child limit within the integration-test budget.
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              ARCHON_HOME: directory,
              DATABASE_URL: '',
              GH_TOKEN: 'synthetic-pat',
              LOG_LEVEL: 'error',
            },
          },
          (error, stdout) => resolve({ error, stdout })
        );
      });
      expect(result.error).toBeNull();
      expect(result.stdout).toBe('synthetic-pr-result');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
  test('command launch failures are persisted as CLI attempts without a permission retry', async () => {
    let launches = 0;
    let caught: unknown;
    try {
      await runGitHubServiceCommand({
        service: 'run_nodes',
        command: 'synthetic-missing-command',
        args: [],
        identity: {
          kind: 'pat',
          service: 'run_nodes',
          token: 'synthetic-pat',
          poolId: 'user-pat',
          distinct: false,
        },
        execute: () => {
          launches += 1;
          throw new Error('synthetic launch failure');
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('synthetic launch failure');
    expect(launches).toBe(1);
    const usage = await db.query<{ calls: number }>(
      "SELECT calls FROM github_api_usage WHERE resource = 'cli'"
    );
    expect(usage.rows[0]?.calls).toBe(1);
  });
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
        '--',
        '--input',
        '-',
      ],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ARCHON_HOME: process.env.ARCHON_HOME,
        DATABASE_URL: '',
        LOG_LEVEL: 'error',
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
        ARCHON_HOME: process.env.ARCHON_HOME,
        DATABASE_URL: '',
        LOG_LEVEL: 'error',
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
  for (const reason of ['permission', 'graphql_permission', 'rate_limit', 'transport']) {
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
            reason === 'graphql_permission'
              ? 'GraphQL: Resource not accessible by integration (addComment)'
              : reason === 'permission'
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
      expect(used).toEqual(reason.includes('permission') ? ['app-1', 'original-pat'] : ['app-1']);
      expect(parent).toEqual({ GH_TOKEN: 'original-pat', GITHUB_TOKEN: 'original-pat' });
      if (reason === 'rate_limit') {
        let refused: unknown;
        try {
          await runGitHubServiceCommand(input);
        } catch (error) {
          refused = error;
        }
        expect(String(refused)).toContain('github_pool_backoff');
        expect(mints).toBe(1);
      } else {
        await runGitHubServiceCommand(input);
        expect(mints).toBe(2);
        expect(used).toContain('app-2');
      }
    });
  }
  // WO-HARNESS-OPEN-PR-REFUSES-REVIEWER-AUTHOR-01 regression: the open-pr-if-needed
  // node sets ARCHON_GITHUB_NO_PERMISSION_FALLBACK=1 so a distinct builder App that
  // passes the lane's acting-login guard but lacks pr-create permission fails closed
  // instead of silently opening the PR with the reviewer/user PAT fallback.
  test('ARCHON_GITHUB_NO_PERMISSION_FALLBACK=1 blocks the permission fallback on App 403', async () => {
    const used: string[] = [];
    let mints = 0;
    const result = await runGitHubServiceCommand({
      service: 'run_nodes' as const,
      command: 'gh',
      args: ['pr', 'create', '--title', 'x'],
      env: {
        GH_TOKEN: 'reviewer-pat',
        GITHUB_TOKEN: 'reviewer-pat',
        ARCHON_GITHUB_NO_PERMISSION_FALLBACK: '1',
      },
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
        return {
          exitCode: 1,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode('Resource not accessible by integration (HTTP 403)'),
        };
      },
    });
    // The builder App token is tried exactly once; the reviewer PAT is never used.
    expect(used).toEqual(['app-1']);
    expect(used).not.toContain('reviewer-pat');
    expect(mints).toBe(1);
    // The App 403 surfaces as a failure rather than a reviewer-authored success.
    expect(result.exitCode).toBe(1);
  });

  test('classifies pull request authorship commands', () => {
    const authorship = [
      ['pr', 'create', '--repo', 'o/r', '--head', 'b'],
      ['pr', '--repo', 'o/r', 'create', '--head', 'b'],
      ['-R', 'o/r', 'pr', 'create'],
      ['pr', 'review', '12', '--approve'],
      ['pr', '-R', 'o/r', 'review', '12', '-a'],
      ['api', 'repos/o/r/pulls', '-f', 'title=x'],
      ['api', 'repos/o/r/pulls/12/reviews', '-X', 'POST'],
      [
        'api',
        'graphql',
        '-f',
        'query=mutation { createPullRequest(input: {}) { clientMutationId } }',
      ],
      [
        '-R',
        'o/r',
        'api',
        'graphql',
        '-f',
        'query=mutation { createPullRequest(input: {}) { clientMutationId } }',
      ],
    ];
    const reads = [
      ['pr', 'view', '12'],
      ['pr', '--repo', 'o/r', 'view', '12'],
      ['pr', 'list'],
      ['pr', 'checks', '12'],
      ['pr', 'comment', '12', '--body', 'x'],
      ['api', 'repos/o/r/pulls/12/reviews'],
      ['api', 'repos/o/r/pulls/12/comments'],
      ['issue', 'comment', '1', '--body', 'x'],
    ];
    expect(
      authorship.map(args => [args.join(' '), githubCommandChangesPullRequestAuthorship(args)])
    ).toEqual(authorship.map(args => [args.join(' '), true]));
    expect(
      reads.map(args => [args.join(' '), githubCommandChangesPullRequestAuthorship(args)])
    ).toEqual(reads.map(args => [args.join(' '), false]));
  });

  test('App 403 does not retry PR creation with the PAT', async () => {
    const appIdentity = {
      kind: 'app' as const,
      service: 'run_nodes' as const,
      appId: '1',
      installationId: '2',
      privateKey: 'unused',
      poolId: 'app-1-2',
      distinct: true as const,
    };
    for (const args of [
      ['pr', 'create', '--repo', 'o/r', '--head', 'b'],
      ['pr', '--repo', 'o/r', 'create', '--head', 'b'],
      [
        '-R',
        'o/r',
        'api',
        'graphql',
        '-f',
        'query=mutation { createPullRequest(input: {}) { clientMutationId } }',
      ],
    ]) {
      let calls = 0;
      const result = await runGitHubServiceCommand({
        service: 'run_nodes',
        command: 'gh',
        args,
        env: { ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN: 'synthetic-fallback' },
        identity: appIdentity,
        token: async () => 'synthetic-app',
        execute: () => {
          calls += 1;
          return {
            exitCode: 1,
            stdout: new Uint8Array(),
            stderr: new TextEncoder().encode('HTTP 403 Resource not accessible by integration'),
          };
        },
      });
      expect(calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain(
        'github_service_exec: permission fallback refused for a PR authorship command (authorship must come from one identity)'
      );
      const fallbackRows = await db.query<{ permission_fallbacks: number }>(
        "SELECT permission_fallbacks FROM github_api_usage WHERE pool_id = 'user-pat'"
      );
      expect(fallbackRows.rows).toEqual([]);
    }
  });

  test('reads retain PAT retry after an App 403', async () => {
    const calls: Array<string | undefined> = [];
    const result = await runGitHubServiceCommand({
      service: 'run_nodes',
      command: 'gh',
      args: ['pr', 'view', '12', '--json', 'mergeable'],
      env: { ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN: 'synthetic-fallback' },
      identity: {
        kind: 'app',
        service: 'run_nodes',
        appId: '1',
        installationId: '2',
        privateKey: 'unused',
        poolId: 'app-1-2',
        distinct: true,
      },
      token: async () => 'synthetic-app',
      execute: (_command, env) => {
        calls.push(env.GH_TOKEN);
        const first = calls.length === 1;
        return {
          exitCode: first ? 1 : 0,
          stdout: new TextEncoder().encode(first ? '' : 'second-ok'),
          stderr: new TextEncoder().encode(
            first ? 'HTTP 403 Resource not accessible by integration' : ''
          ),
        };
      },
    });
    expect(calls).toEqual(['synthetic-app', 'synthetic-fallback']);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe('second-ok');
    expect(new TextDecoder().decode(result.stderr)).not.toContain('permission fallback refused');
  });
});
