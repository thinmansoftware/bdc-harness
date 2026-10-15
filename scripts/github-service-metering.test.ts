import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from '../packages/core/src/db/adapters/sqlite';

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
  const driver = join(import.meta.dir, 'github-service-exec.ts');
  const run = (code: string): ReturnType<typeof Bun.spawnSync> =>
    Bun.spawnSync({
      cmd: [process.execPath, driver, 'run_nodes', process.execPath, '-e', code],
      env,
      stdin: new Uint8Array(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  let db: SqliteAdapter | undefined;
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
    const second = run(`await Bun.write(${JSON.stringify(marker)}, 'unexpected execution');`);
    expect(second.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const unchanged = await db.query<{ calls: number }>(
      'SELECT SUM(calls) AS calls FROM github_api_usage'
    );
    expect(unchanged.rows[0]?.calls).toBe(2);
  } finally {
    await db?.close();
    Bun.gc(true);
    rmSync(home, { recursive: true, force: true });
  }
});
