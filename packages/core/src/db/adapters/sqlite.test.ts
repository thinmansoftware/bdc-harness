import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'fs';
import { join } from 'path';

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
  });

  describe('agent messaging Phase 0 schema', () => {
    const phase0Columns = [
      'priority',
      'task_outcome',
      'acknowledged_at',
      'acknowledged_by',
      'addressed_at',
      'addressed_by',
      'escalated_tg_at',
      'escalated_sms_at',
      'subject_key',
      'repeat_reason',
      'route_disposition',
      'supersedes_id',
    ];

    test('fresh databases expose Phase 0 message columns and the canonical principal registry', async () => {
      db = createTestDb();

      const columns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('agent_dispatch_messages')`
      );
      const columnNames = new Set(columns.rows.map(column => column.name));
      for (const column of phase0Columns) {
        expect(columnNames.has(column)).toBe(true);
      }
      const phase1Index = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_dispatch_messages_subject_history'`
      );
      expect(phase1Index.rows[0]?.sql).toContain(
        'ON agent_dispatch_messages(subject_key, created_at DESC, id DESC) WHERE subject_key IS NOT NULL'
      );

      const principals = await db.query<{
        principal_id: string;
        delivery_mode: string;
        active: number;
      }>(
        `SELECT principal_id, delivery_mode, active
         FROM dispatch_principals
         ORDER BY principal_id`
      );
      expect(principals.rows).toEqual([
        { principal_id: 'board', delivery_mode: 'alias_resolved', active: 1 },
        { principal_id: 'cauldron', delivery_mode: 'notify_only', active: 1 },
        { principal_id: 'claude', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'claude-acp', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'codex', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'codex-mcp', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'cursor', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'fusion', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'grok', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'grok-acp', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'john', delivery_mode: 'notify_only', active: 0 },
        { principal_id: 'merge-manager', delivery_mode: 'notify_only', active: 0 },
        { principal_id: 'operator', delivery_mode: 'drain_on_start', active: 1 },
        { principal_id: 'overseer', delivery_mode: 'notify_only', active: 1 },
        // WO-HARNESS-OVERSEER-REVIEW-ROUTE-01 (migration 043): sorted
        // alphabetically by principal_id, same as the query's ORDER BY.
        { principal_id: 'overseer-review-route', delivery_mode: 'notify_only', active: 1 },
        { principal_id: 'overseer-reviewer', delivery_mode: 'worker_poll', active: 1 },
        // WO-HARNESS-OPERATOR-INBOX-BACKPRESSURE-01 (migration 046): audit home
        // for routine review-route receipts.
        { principal_id: 'review-receipts-log', delivery_mode: 'notify_only', active: 1 },
        { principal_id: 'xo', delivery_mode: 'drain_on_start', active: 1 },
      ]);
    });

    test('existing databases add Phase 0 columns, backfill queued run reports once, and seed live-only recipients', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      legacy.run(`
        CREATE TABLE agent_dispatch_messages (
          id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          task_type TEXT NOT NULL,
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          result_body TEXT,
          created_at TEXT NOT NULL
          ,claimed_at TEXT
          ,completed_at TEXT
          ,not_before TEXT
          ,lease_owner TEXT
          ,lease_expires_at TEXT
          ,fencing_token INTEGER NOT NULL DEFAULT 0
        )
      `);
      legacy.run(`
        INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
        VALUES
          ('legacy-heartbeat', 'c1', 'k1', 'run_report', 'unexpected-sender', '  Live-Only  ', 'report', 'queued', '2026-08-05T00:00:00.000Z'),
          ('legacy-complete', 'c2', 'k2', 'run_report', 'unexpected-sender', 'operator', 'report', 'done', '2026-08-05T00:00:00.000Z')
      `);
      legacy.close();

      db = new SqliteAdapter(currentDbPath);
      const columns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('agent_dispatch_messages')`
      );
      const columnNames = new Set(columns.rows.map(column => column.name));
      for (const column of phase0Columns) {
        expect(columnNames.has(column)).toBe(true);
      }
      const phase1Index = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_dispatch_messages_subject_history'`
      );
      expect(phase1Index.rows[0]?.sql).toContain('WHERE subject_key IS NOT NULL');

      const priorities = await db.query<{ id: string; priority: string }>(
        `SELECT id, priority FROM agent_dispatch_messages ORDER BY id`
      );
      expect(priorities.rows).toEqual([
        { id: 'legacy-complete', priority: 'normal' },
        { id: 'legacy-heartbeat', priority: 'heartbeat' },
      ]);

      const livePrincipal = await db.query<{
        principal_id: string;
        delivery_mode: string;
        active: number;
      }>(
        `SELECT principal_id, delivery_mode, active
         FROM dispatch_principals
         WHERE principal_id = 'live-only'`
      );
      expect(livePrincipal.rows).toEqual([
        { principal_id: 'live-only', delivery_mode: 'drain_on_start', active: 1 },
      ]);

      await db.query(`
        INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, priority, created_at)
        VALUES ('new-blocker', 'c3', 'k3', 'run_report', 'unexpected-sender', 'operator', 'new report', 'queued', 'blocker', '2026-08-05T00:00:00.000Z')
      `);
      await db.close();

      db = new SqliteAdapter(currentDbPath);
      const reopened = await db.query<{ id: string; priority: string }>(
        `SELECT id, priority FROM agent_dispatch_messages WHERE id = 'new-blocker'`
      );
      expect(reopened.rows).toEqual([{ id: 'new-blocker', priority: 'blocker' }]);
    });

    test('rolls back a failed Phase 0 backfill and recovers exactly once on reopen', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      legacy.run(`
        CREATE TABLE agent_dispatch_messages (
          id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          task_type TEXT NOT NULL CHECK (task_type IN ('agent_message', 'run_review', 'draft_spec', 'run_report')),
          sender TEXT NOT NULL,
          recipient TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'failed', 'cancelled')),
          result_body TEXT,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          not_before TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          fencing_token INTEGER NOT NULL DEFAULT 0
        )
      `);
      legacy.run(`
        INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at)
        VALUES
          ('legacy-heartbeat', 'c1', 'k1', 'run_report', 'unexpected-sender', 'operator', 'report', 'queued', '2026-08-05T00:00:00.000Z')
      `);
      legacy.run(`
        CREATE TRIGGER fail_phase0_heartbeat_backfill
        BEFORE UPDATE OF priority ON agent_dispatch_messages
        WHEN NEW.priority = 'heartbeat'
        BEGIN
          SELECT RAISE(ABORT, 'induced_phase0_backfill_failure');
        END
      `);
      legacy.close();

      db = new SqliteAdapter(currentDbPath);
      const failedColumns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('agent_dispatch_messages')`
      );
      const failedColumnNames = new Set(failedColumns.rows.map(column => column.name));
      for (const column of phase0Columns) {
        expect(failedColumnNames.has(column)).toBe(false);
      }
      const unchangedLegacyRow = await db.query<{ status: string; task_type: string }>(
        `SELECT status, task_type FROM agent_dispatch_messages WHERE id = 'legacy-heartbeat'`
      );
      expect(unchangedLegacyRow.rows).toEqual([{ status: 'queued', task_type: 'run_report' }]);

      await db.query('DROP TRIGGER fail_phase0_heartbeat_backfill');
      await db.close();
      db = new SqliteAdapter(currentDbPath);

      const recoveredColumns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('agent_dispatch_messages')`
      );
      const recoveredColumnNames = new Set(recoveredColumns.rows.map(column => column.name));
      for (const column of phase0Columns) {
        expect(recoveredColumnNames.has(column)).toBe(true);
      }
      const recoveredHeartbeat = await db.query<{ priority: string }>(
        `SELECT priority FROM agent_dispatch_messages WHERE id = 'legacy-heartbeat'`
      );
      expect(recoveredHeartbeat.rows).toEqual([{ priority: 'heartbeat' }]);

      await db.query(`
        INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, priority, created_at)
        VALUES
          ('post-recovery-blocker', 'c2', 'k2', 'run_report', 'unexpected-sender', 'operator', 'blocker report', 'queued', 'blocker', '2026-08-05T00:01:00.000Z')
      `);
      await db.close();
      db = new SqliteAdapter(currentDbPath);

      const reopened = await db.query<{ id: string; priority: string }>(
        `SELECT id, priority
         FROM agent_dispatch_messages
         WHERE id IN ('legacy-heartbeat', 'post-recovery-blocker')
         ORDER BY id`
      );
      expect(reopened.rows).toEqual([
        { id: 'legacy-heartbeat', priority: 'heartbeat' },
        { id: 'post-recovery-blocker', priority: 'blocker' },
      ]);
    });
  });

  describe('workflow run archive schema', () => {
    const expectedArchiveColumns = ['archived_at', 'archived_by', 'archive_reason'];

    test('creates archive columns in a fresh database', async () => {
      db = createTestDb();

      const columns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('remote_agent_workflow_runs')`
      );
      const names = new Set(columns.rows.map(column => column.name));

      for (const column of expectedArchiveColumns) {
        expect(names.has(column)).toBe(true);
      }
    });

    test('adds archive columns to an existing workflow runs table', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      legacy.run(`
        CREATE TABLE remote_agent_workflow_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          codebase_id TEXT,
          workflow_name TEXT NOT NULL,
          user_message TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          current_step_index INTEGER,
          metadata TEXT DEFAULT '{}',
          parent_conversation_id TEXT,
          started_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT,
          last_activity_at TEXT DEFAULT (datetime('now')),
          working_path TEXT
        )
      `);
      legacy.close();

      db = new SqliteAdapter(currentDbPath);
      const columns = await db.query<{ name: string }>(
        `SELECT name FROM pragma_table_info('remote_agent_workflow_runs')`
      );
      const names = new Set(columns.rows.map(column => column.name));

      for (const column of expectedArchiveColumns) {
        expect(names.has(column)).toBe(true);
      }
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
