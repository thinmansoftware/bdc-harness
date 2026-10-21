import { expect, test, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as connection from '@archon/core/db/connection';
import { serviceGitHubFetch } from '@archon/core/github/request';
import { resetGitHubApiMeterForTests } from '@archon/core/github/metering';
import { Octokit } from '@octokit/rest';
import { attachGitHubQuotaHooks } from '../adapters/github-real-deps';

test('real CLI processes persist request counts and refuse an exhausted shared pool', async () => {
  const home = mkdtempSync(join(tmpdir(), 'github-command-meter-'));
  const marker = join(home, 'must-not-run.txt');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    GH_TOKEN: 'synthetic-secret-token',
    LOG_LEVEL: 'error',
  };
  const driver = join(import.meta.dir, '../../../../scripts/github-service-exec.ts');
  const run = (code: string): ReturnType<typeof Bun.spawnSync> =>
    Bun.spawnSync({
      cmd: [process.execPath, driver, 'run_nodes', process.execPath, '-e', code],
      env,
      stdin: new Uint8Array(),
      stdout: 'pipe',
      stderr: 'pipe',
      // Each real CLI initializes an owned SQLite database before its command.
      // Bound both children explicitly within the integration-test budget.
      timeout: 20_000,
    });
  let db: SqliteAdapter | undefined;
  let databaseSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const trace = [
      '* Request at synthetic time',
      '> Authorization: token synthetic-secret-token',
      '< HTTP/2.0 200 OK',
      '< X-Ratelimit-Resource: graphql',
      '< X-Ratelimit-Remaining: 100',
      `< X-Ratelimit-Reset: ${reset}`,
      'private request/response body must not escape',
      '* Request took 1ms',
      '* Request at synthetic time',
      '< HTTP/2.0 403 Forbidden',
      '< X-Ratelimit-Resource: core',
      '< X-Ratelimit-Remaining: 0',
      `< X-Ratelimit-Reset: ${reset}`,
      '* Request took 1ms',
      'gh: API rate limit exceeded (HTTP 403)',
    ].join('\n');
    const first = run(`console.error(${JSON.stringify(trace)}); process.exit(1);`);
    expect(first.exitCode).toBe(1);
    const stderr = first.stderr?.toString() ?? '';
    expect(stderr).toContain('API rate limit exceeded');
    expect(stderr).not.toContain('synthetic-secret-token');
    expect(stderr).not.toContain('private request/response');
    db = new SqliteAdapter(join(home, 'archon.db'));
    const usage = await db.query<{ resource: string; calls: number; rate_limited: number }>(
      'SELECT resource, calls, rate_limited FROM github_api_usage ORDER BY resource'
    );
    expect(usage.rows).toEqual([
      { resource: 'core', calls: 1, rate_limited: 1 },
      { resource: 'graphql', calls: 1, rate_limited: 0 },
    ]);
    // These clients are in a different process from the CLI that exhausted
    // this pool. Clear the Map so only persisted evidence can block them.
    databaseSpy = spyOn(connection, 'getDatabase').mockReturnValue(db);
    resetGitHubApiMeterForTests();
    let requests = 0;
    const fetcher = (async () => {
      requests += 1;
      return Response.json({});
    }) as typeof fetch;
    let httpError: unknown;
    try {
      await serviceGitHubFetch({
        service: 'duty_officer',
        url: 'https://api.github.com/repos/x/y',
        identity: {
          kind: 'pat',
          service: 'duty_officer',
          token: 'synthetic',
          poolId: 'user-pat',
          distinct: false,
        },
        fetch: fetcher,
      });
    } catch (error) {
      httpError = error;
    }
    expect(String(httpError)).toContain('github_pool_backoff');
    resetGitHubApiMeterForTests();
    const client = new Octokit({ request: { fetch: fetcher } });
    attachGitHubQuotaHooks(client, 'overseer', 'user-pat');
    let octokitError: unknown;
    try {
      await client.request('GET /repos/x/y');
    } catch (error) {
      octokitError = error;
    }
    expect(String(octokitError)).toContain('github_pool_backoff');
    expect(requests).toBe(0);
    const second = run(`await Bun.write(${JSON.stringify(marker)}, 'unexpected execution');`);
    expect(second.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const unchanged = await db.query<{ calls: number }>(
      'SELECT SUM(calls) AS calls FROM github_api_usage'
    );
    expect(unchanged.rows[0]?.calls).toBe(2);
  } finally {
    databaseSpy?.mockRestore();
    resetGitHubApiMeterForTests();
    await db?.close();
    Bun.gc(true);
    rmSync(home, { recursive: true, force: true });
  }
  // Two bounded real CLI subprocesses initialize independent databases.
  // Leave room for both child limits and the parent's database assertions.
}, 45_000);
