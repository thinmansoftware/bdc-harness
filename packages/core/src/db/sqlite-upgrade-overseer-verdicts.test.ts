/**
 * Upgrade regression for bdc-harness #842 (rebuild 11, 2026-09-14 18:14Z).
 *
 * Every other DAL test starts from an EMPTY database, where createSchema creates
 * overseer_verdicts with the merge-execution bookkeeping columns already present.
 * Production predates those columns, and the base DDL created
 * idx_overseer_verdicts_merge_action (which references actioned_at) BEFORE the
 * additive block added the column -- so archon-app-1 crash-looped with
 * "no such column: actioned_at". This test opens an old-shape database with the
 * current adapter and asserts the upgrade succeeds end to end.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

const paths: string[] = [];

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function tempDbPath(): string {
  const path = join(
    import.meta.dir,
    `.test-sqlite-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  paths.push(path);
  return path;
}

/** overseer_verdicts as it existed before the migration-052 additive columns. */
function createOldShapeOverseerVerdicts(path: string): void {
  // Only the verdicts table is pre-created in its old shape; every other table is
  // absent so createSchema builds it fresh (the REFERENCES clause does not require
  // the referenced table to exist at CREATE time, and foreign keys are not enforced
  // on rows that already exist when the adapter opens the file).
  const raw = new Database(path);
  raw.run(`CREATE TABLE overseer_verdicts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES remote_agent_workflow_runs(id) ON DELETE CASCADE,
    wo_id TEXT NOT NULL,
    head_sha TEXT NOT NULL DEFAULT '',
    evidence_digest TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'claimed',
    verdict TEXT,
    confidence REAL,
    model TEXT,
    model_rung INTEGER,
    proposed_action TEXT,
    proposed_tier INTEGER,
    required_tier INTEGER,
    effective_tier INTEGER,
    hint_action TEXT,
    hint_error_class TEXT,
    reason TEXT,
    evidence TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  raw.run(
    `INSERT INTO overseer_verdicts (id, run_id, wo_id, head_sha, proposed_action)
     VALUES ('verdict-old', 'run-old', 'WO-OLD-01', 'sha-old', 'flag_merge_ready')`
  );
  raw.close();
}

afterEach(() => {
  for (const path of paths.splice(0)) cleanupDb(path);
});

describe('sqlite schema upgrade: overseer_verdicts predating migration 052', () => {
  test('opening an old-shape database adds the bookkeeping columns and the merge-action index', async () => {
    const path = tempDbPath();
    createOldShapeOverseerVerdicts(path);

    const db = new SqliteAdapter(path);
    try {
      const columns = await db.query<{ name: string }>("PRAGMA table_info('overseer_verdicts')");
      const names = new Set(columns.rows.map(row => row.name));
      for (const expected of [
        'actioned_at',
        'mutation_sent',
        'action_reason',
        'merge_sha',
        'pr_url',
      ]) {
        expect(names.has(expected), expected).toBe(true);
      }
      const indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'overseer_verdicts'`
      );
      expect(indexes.rows.map(row => row.name)).toContain('idx_overseer_verdicts_merge_action');
      // The pre-existing row survives the upgrade and is visible to the merge bridge query.
      const unactioned = await db.query<{ id: string }>(
        `SELECT id FROM overseer_verdicts WHERE proposed_action = 'flag_merge_ready' AND actioned_at IS NULL`
      );
      expect(unactioned.rows.map(row => row.id)).toEqual(['verdict-old']);
    } finally {
      await db.close();
    }
  });

  test('reopening an already-upgraded database is idempotent', async () => {
    const path = tempDbPath();
    createOldShapeOverseerVerdicts(path);
    const first = new SqliteAdapter(path);
    await first.close();
    const second = new SqliteAdapter(path);
    try {
      const columns = await second.query<{ name: string }>(
        "PRAGMA table_info('overseer_verdicts')"
      );
      expect(columns.rows.filter(row => row.name === 'actioned_at')).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});
