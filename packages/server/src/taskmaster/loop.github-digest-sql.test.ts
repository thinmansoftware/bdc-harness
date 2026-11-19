/**
 * The daily digest's GitHub section runs a real query against github_api_pool_state.
 * An unquoted `AS limit` alias is a syntax error in SQLite ("near limit"), so the
 * digest's GitHub section failed on every tick (seen live 2026-11-03 22:19Z).
 * This test runs the query on a real SqliteAdapter, not a mock.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { loadGitHubDigestData } from './loop';

let dbPath: string;
let db: SqliteAdapter;

beforeEach(() => {
  dbPath = join(tmpdir(), `tm-github-digest-${Date.now()}-${Math.random()}.db`);
  db = new SqliteAdapter(dbPath);
});

afterEach(async () => {
  await db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // already gone
    }
  }
});

describe('loadGitHubDigestData on SQLite', () => {
  test('reads pool limits without a syntax error', async () => {
    const now = Date.parse('2026-11-03T22:00:00Z');
    await db.query(
      `INSERT INTO github_api_pool_state (pool_id, resource, "limit", remaining, reset_at, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['app', 'core', 5000, 4321, '2026-11-03T23:00:00Z', '2026-11-03T21:59:00Z']
    );
    await db.query(
      `INSERT INTO github_api_pool_state (pool_id, resource, "limit", remaining, reset_at, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['app', 'code_search', 10, 10, '2026-11-03T23:00:00Z', '2026-11-03T21:59:00Z']
    );

    const data = await loadGitHubDigestData(now, db);

    expect(data.pools).toEqual([
      { pool_id: 'app', resource: 'core', remaining: 4321, limit: 5000 },
    ]);
  });
});
