import { describe, expect, it } from 'bun:test';
import { digestProposal } from './loop';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('loads the quota digest through the real SQLite connection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-github-digest-'));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `
          const { getDatabase, closeDatabase } = await import('@archon/core/db');
          const { loadGitHubDigestData } = await import(${JSON.stringify(new URL('./loop.ts', import.meta.url).href)});
          const db = getDatabase();
          try {
            await db.query('INSERT INTO github_api_usage (hour_bucket, service, pool_id, resource, calls) VALUES ($1, $2, $3, $4, $5)',
              ['2026-10-26T11:00:00.000Z', 'taskmaster', 'test-pool', 'core', 7]);
            await db.query('INSERT INTO github_api_usage (hour_bucket, service, pool_id, resource, calls) VALUES ($1, $2, $3, $4, $5)',
              ['2026-10-24T11:00:00.000Z', 'old-service', 'test-pool', 'core', 99]);
            await db.query('INSERT INTO github_api_pool_state (pool_id, resource, "limit", remaining, observed_at) VALUES ($1, $2, $3, $4, $5)',
              ['test-pool', 'core', 5000, 4900, '2026-10-26T11:00:00.000Z']);
            const result = await loadGitHubDigestData(Date.parse('2026-10-26T12:00:00.000Z'));
            console.log('DIGEST_RESULT=' + JSON.stringify({ ...result, servicesByPool: [...result.servicesByPool] }));
          } finally {
            await closeDatabase();
          }
        `,
      ],
      {
        env: { ...process.env, ARCHON_HOME: home, DATABASE_URL: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const result = stdout.split('\n').find(line => line.startsWith('DIGEST_RESULT='));
    expect(result).toBeDefined();
    expect(JSON.parse(result!.slice('DIGEST_RESULT='.length))).toEqual({
      usage: [{ service: 'taskmaster', pool_id: 'test-pool', calls: 7, peak: 7 }],
      pools: [{ pool_id: 'test-pool', resource: 'core', remaining: 4900, limit: 5000 }],
      servicesByPool: [['test-pool', ['taskmaster']]],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('Test 7: GitHub quota digest', () => {
  it('reports services, resources, and strict low warnings', () => {
    const body = digestProposal(
      [],
      {
        pause_state: 'RUNNING',
        pause_scope: null,
        pause_actor: null,
        pause_reason: null,
        epoch: 1,
        updated_at: '2026-10-14T00:00:00Z',
      },
      Date.parse('2026-10-14T00:00:00Z'),
      undefined,
      [],
      {
        usage: [
          { service: 'merge_manager', pool_id: 'app-y', calls: 24, peak: 3 },
          { service: 'taskmaster', pool_id: 'app-y', calls: 48, peak: 4 },
          { service: 'overseer', pool_id: 'app-x', calls: 12, peak: 2 },
        ],
        pools: [
          { pool_id: 'app-y', resource: 'core', remaining: 900, limit: 15000 },
          { pool_id: 'app-y', resource: 'search', remaining: 25, limit: 30 },
          { pool_id: 'app-x', resource: 'core', remaining: 14000, limit: 15000 },
        ],
        servicesByPool: new Map([
          ['app-y', ['merge_manager', 'taskmaster']],
          ['app-x', ['overseer']],
        ]),
      }
    ).body;
    expect(body).toContain('GitHub API last 24h by service: merge_manager');
    expect(body).toContain('app-y/core 900/15000');
    expect(body).toContain('GITHUB-QUOTA-LOW app-y/core (merge_manager, taskmaster)');
    expect(body).not.toContain('GITHUB-QUOTA-LOW app-y/search');
  });
});
