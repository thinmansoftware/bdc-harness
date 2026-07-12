import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';

let currentDbPath = '';

function createTestDb(): SqliteAdapter {
  currentDbPath = join(
    import.meta.dir,
    `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return new SqliteAdapter(currentDbPath);
}

/** Insert a parent codebase row to satisfy FK constraints */
async function insertCodebase(db: SqliteAdapter, id: string): Promise<void> {
  await db.query(`INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`, [
    id,
    `test-codebase-${id}`,
    '/tmp/test-cwd',
  ]);
}

describe('SqliteAdapter', () => {
  let db: SqliteAdapter;

  afterEach(async () => {
    if (db) {
      await db.close();
    }
    try {
      unlinkSync(currentDbPath);
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-wal');
    } catch {
      /* may not exist */
    }
    try {
      unlinkSync(currentDbPath + '-shm');
    } catch {
      /* may not exist */
    }
  });

  describe('Smart Cauldron reliability schema', () => {
    test('creates all additive reliability tables and indexes', async () => {
      db = createTestDb();

      const tables = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'remote_agent_%'`
      );
      const tableNames = new Set(tables.rows.map(row => row.name));
      for (const table of [
        'remote_agent_run_authorities',
        'remote_agent_run_leases',
        'remote_agent_provider_attempts',
        'remote_agent_run_outcomes',
        'remote_agent_scheduled_waits',
        'remote_agent_supervisor_incidents',
        'remote_agent_supervisor_observations',
        'remote_agent_supervisor_repair_leases',
        'remote_agent_supervisor_actions',
      ]) {
        expect(tableNames.has(table)).toBe(true);
      }

      const indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_reliability_%'`
      );
      expect(indexes.rows.map(row => row.name).sort()).toEqual([
        'idx_reliability_active_leases',
        'idx_reliability_attempts_run_node',
        'idx_reliability_due_waits',
      ]);
      const supervisorIndexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_supervisor_%'`
      );
      expect(supervisorIndexes.rows.map(row => row.name).sort()).toEqual([
        'idx_supervisor_actions_incident',
        'idx_supervisor_observations_incident',
        'idx_supervisor_repair_leases_expiry',
      ]);
    });

    test('upgrades legacy supervisor actions before creating attempt indexes and enforces NOT NULL', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      legacy.run(`
        CREATE TABLE remote_agent_supervisor_incidents (
          incident_id TEXT PRIMARY KEY,
          incident_key TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL,
          wo_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'repairing', 'recovered', 'escalated')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO remote_agent_supervisor_incidents
          (incident_id, incident_key, run_id, wo_id, status, created_at, updated_at)
        VALUES
          ('incident-1', 'recovery:run-1', 'run-1', 'WO-1', 'open',
           '2026-07-12T00:00:00Z', '2026-07-12T00:00:00Z');
        CREATE TABLE remote_agent_supervisor_actions (
          action_id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          action_type TEXT NOT NULL,
          outcome TEXT NOT NULL,
          evidence_refs TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          completed_at TEXT
        );
        CREATE UNIQUE INDEX uq_supervisor_action_incident
          ON remote_agent_supervisor_actions(incident_id);
        INSERT INTO remote_agent_supervisor_actions
          (action_id, incident_id, owner_id, fencing_token, action_type, outcome, created_at)
        VALUES ('action-1', 'incident-1', 'xo', 1, 'repair', 'completed', '2026-07-12T00:00:00Z');
      `);
      legacy.close();

      db = new SqliteAdapter(currentDbPath);

      const columns = await db.query<{ name: string; is_not_null: number }>(
        `SELECT name, "notnull" AS is_not_null
         FROM pragma_table_info('remote_agent_supervisor_actions')`
      );
      expect(columns.rows.find(column => column.name === 'attempt_id')?.is_not_null).toBe(1);
      const upgraded = await db.query<{ action_id: string; attempt_id: string }>(
        'SELECT action_id, attempt_id FROM remote_agent_supervisor_actions'
      );
      expect(upgraded.rows).toEqual([{ action_id: 'action-1', attempt_id: 'action-1' }]);
      await db.query(
        "UPDATE remote_agent_supervisor_incidents SET status = 'abandoned' WHERE incident_id = 'incident-1'"
      );
      await expect(
        db.query(
          `INSERT INTO remote_agent_supervisor_actions
           (action_id, attempt_id, incident_id, owner_id, fencing_token, action_type, outcome,
            evidence_refs, created_at, status)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            'action-2',
            'incident-2',
            'xo',
            2,
            'repair',
            'completed',
            '[]',
            '2026-07-12T00:00:01Z',
            'completed',
          ]
        )
      ).rejects.toThrow();
    });
  });

  describe('INSERT with RETURNING', () => {
    test('returns inserted row via native RETURNING', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      const result = await db.query<{ id: string; status: string }>(
        `INSERT INTO remote_agent_isolation_environments
         (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        ['test-id', 'cb-1', 'issue', '1', 'worktree', '/tmp/test', 'issue-1', 'active']
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('test-id');
      expect(result.rows[0].status).toBe('active');
    });

    test('returns correct row on ON CONFLICT DO UPDATE', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      // Insert initial row
      await db.query(
        `INSERT INTO remote_agent_isolation_environments
         (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['orig-id', 'cb-1', 'issue', '42', 'worktree', '/tmp/original', 'issue-42', 'active']
      );

      // Upsert with ON CONFLICT -- this is the scenario that was broken
      const result = await db.query<{ id: string; working_path: string; branch_name: string }>(
        `INSERT INTO remote_agent_isolation_environments
         (codebase_id, workflow_type, workflow_id, provider, working_path, branch_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (codebase_id, workflow_type, workflow_id) WHERE status = 'active'
         DO UPDATE SET
           working_path = EXCLUDED.working_path,
           branch_name = EXCLUDED.branch_name,
           status = 'active'
         RETURNING *`,
        ['cb-1', 'issue', '42', 'worktree', '/tmp/updated', 'issue-42-v2']
      );

      expect(result.rows).toHaveLength(1);
      // Must return the updated row, not a random/wrong row
      expect(result.rows[0].id).toBe('orig-id');
      expect(result.rows[0].working_path).toBe('/tmp/updated');
      expect(result.rows[0].branch_name).toBe('issue-42-v2');
    });
  });

  describe('placeholder conversion (#999 regression)', () => {
    test('$N inside SQL comments is treated as a placeholder -- avoid $N in comments', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      // A query with $1 and $2 as real params, but $3 only appears in a comment.
      // convertPlaceholders replaces ALL $N occurrences including inside comments,
      // producing 3 ? marks for only 2 params -> SQLite error.
      const sql = `SELECT * FROM remote_agent_codebases WHERE id = $1 AND name = $2 -- $3 is not a real param`;
      await expect(db.query(sql, ['cb-1', 'test-codebase-cb-1'])).rejects.toThrow();
    });

    test('query succeeds when $N placeholders match param count', async () => {
      db = createTestDb();
      await insertCodebase(db, 'cb-1');

      const result = await db.query<{ id: string }>(
        `SELECT id FROM remote_agent_codebases WHERE id = $1 AND name = $2`,
        ['cb-1', 'test-codebase-cb-1']
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].id).toBe('cb-1');
    });
  });

  describe('UPDATE/DELETE with RETURNING', () => {
    test('throws error for UPDATE RETURNING', async () => {
      db = createTestDb();

      await expect(
        db.query(
          `UPDATE remote_agent_isolation_environments SET status = $1 WHERE id = $2 RETURNING *`,
          ['destroyed', 'test-id']
        )
      ).rejects.toThrow('does not support RETURNING clause on UPDATE/DELETE');
    });
  });

  describe('datetime() chronological vs lexical comparison', () => {
    // Documents the SQLite-specific bug fixed in getActiveWorkflowRunByPath.
    // `started_at` is TEXT in "YYYY-MM-DD HH:MM:SS" format. Comparing it
    // directly to an ISO param "YYYY-MM-DDTHH:MM:SS.mmmZ" with `<` is
    // LEXICAL: char 11 is space (0x20) in the column vs T (0x54) in the
    // param, so every column value lex-sorts before every ISO param,
    // making the comparison ALWAYS true regardless of actual time.
    //
    // Wrapping both sides in datetime() forces chronological comparison.

    test('lexical comparison gives wrong answer for SQLite stored format vs ISO param', async () => {
      db = createTestDb();
      // Column-format value (afternoon) is chronologically AFTER the ISO
      // param (morning), but lex compares char-11 (space < T) -> wrong.
      const result = await db.query<{ broken: number }>(
        `SELECT ('2026-04-14 12:00:00' < $1) AS broken`,
        ['2026-04-14T10:00:00.000Z']
      );
      // Expected by chronology: FALSE. Lex says: TRUE.
      expect(result.rows[0].broken).toBe(1);
    });

    test('datetime() wrap on both sides gives chronological comparison', async () => {
      db = createTestDb();
      const result = await db.query<{ correct: number }>(
        `SELECT (datetime('2026-04-14 12:00:00') < datetime($1)) AS correct`,
        ['2026-04-14T10:00:00.000Z']
      );
      // 12:00 < 10:00 is FALSE -- datetime() comparison agrees with reality.
      expect(result.rows[0].correct).toBe(0);
    });

    test('datetime() handles equality across formats', async () => {
      db = createTestDb();
      const result = await db.query<{ equal: number }>(
        `SELECT (datetime('2026-04-14 10:00:00') = datetime($1)) AS equal`,
        ['2026-04-14T10:00:00.000Z']
      );
      expect(result.rows[0].equal).toBe(1);
    });
  });
});
