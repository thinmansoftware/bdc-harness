import { describe, test, expect, afterEach } from 'bun:test';
import { SqliteAdapter } from './sqlite';

// Bun 1.3.x silently drops a root test path when a mixed invocation begins with
// workspace-package paths. Register the migration suite through the SQLite
// package so both the pinned Phase 1.5 command and ordinary package CI grade it.
await import('../../../../../scripts/dispatch-worker/dispatch-migration-smoke.test');
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
      expect(columnNames.has('sender_principal_id')).toBe(true);
      const phase1Index = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_dispatch_messages_subject_history'`
      );
      expect(phase1Index.rows[0]?.sql).toContain(
        'ON agent_dispatch_messages(subject_key, created_at DESC, id DESC) WHERE subject_key IS NOT NULL'
      );
      const authIdx = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_agent_dispatch_messages_sender_idempotency_authenticated'`
      );
      expect(authIdx.rows[0]?.sql).toContain('sender_principal_id');
      expect(authIdx.rows[0]?.sql).toContain('WHERE sender_principal_id IS NOT NULL');
      const legacyIdx = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_agent_dispatch_messages_idempotency_legacy'`
      );
      expect(legacyIdx.rows[0]?.sql).toContain('WHERE sender_principal_id IS NULL');
      const tableSql = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_messages'`
      );
      expect(tableSql.rows[0]?.sql ?? '').not.toMatch(/idempotency_key TEXT NOT NULL UNIQUE/i);

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
        { principal_id: 'do', delivery_mode: 'worker_poll', active: 1 },
        { principal_id: 'duty-officer', delivery_mode: 'worker_poll', active: 1 },
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
      expect(columnNames.has('sender_principal_id')).toBe(true);
      const phase1Index = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_dispatch_messages_subject_history'`
      );
      expect(phase1Index.rows[0]?.sql).toContain('WHERE subject_key IS NOT NULL');
      const authIdx = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_agent_dispatch_messages_sender_idempotency_authenticated'`
      );
      expect(authIdx.rows[0]?.sql).toContain('WHERE sender_principal_id IS NOT NULL');
      const legacyIdx = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_agent_dispatch_messages_idempotency_legacy'`
      );
      expect(legacyIdx.rows[0]?.sql).toContain('WHERE sender_principal_id IS NULL');
      const principalsNull = await db.query<{ sender_principal_id: string | null }>(
        `SELECT sender_principal_id FROM agent_dispatch_messages`
      );
      expect(principalsNull.rows.every(row => row.sender_principal_id == null)).toBe(true);

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

  describe('tm_journal unheard grade migration (migration 055 / WO-HARNESS-TASKMASTER-UNHEARD-GRADE-01)', () => {
    test('an existing pre-unheard tm_journal table is rebuilt so it accepts the unheard grade', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      // Pre-migration shape: the grade CHECK does NOT list 'unheard' (matches
      // the CHECK createSchema wrote before this WO widened it).
      legacy.run(`
        CREATE TABLE tm_journal (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          thread_ref TEXT NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')),
          proposal_json TEXT NOT NULL,
          idempotency_key TEXT,
          before_hash TEXT,
          proof_predicate TEXT,
          proof_deadline_at TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')),
          graded_at TEXT,
          grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful'))
        )
      `);
      legacy.run(`
        INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome, grade)
        VALUES ('legacy-journal-1', '2026-08-01T00:00:00.000Z', 'thread-1', 'nudge', '{}', 'sent', 'noise')
      `);
      legacy.close();

      // Reopening through SqliteAdapter must run the migration and rebuild the
      // table with the widened CHECK, without losing the pre-existing row.
      db = new SqliteAdapter(currentDbPath);

      const schema = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_journal'`
      );
      expect(schema.rows[0]?.sql).toContain('unheard');

      const preserved = await db.query<{ id: string; grade: string | null }>(
        `SELECT id, grade FROM tm_journal WHERE id = 'legacy-journal-1'`
      );
      expect(preserved.rows).toEqual([{ id: 'legacy-journal-1', grade: 'noise' }]);

      // The whole point of the migration: an UPDATE grading a row 'unheard'
      // must now succeed against the migrated (existing, not freshly created)
      // database -- this is what PR #864 flagged as broken.
      await db.query(
        `INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome, grade)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'legacy-journal-2',
          '2026-09-15T00:00:00.000Z',
          'thread-2',
          'escalate_p0',
          '{}',
          'sent',
          'unheard',
        ]
      );
      const graded = await db.query<{ grade: string | null }>(
        `SELECT grade FROM tm_journal WHERE id = 'legacy-journal-2'`
      );
      expect(graded.rows).toEqual([{ grade: 'unheard' }]);
    });
  });

  describe('tm_journal delivered_to_issue grade migration (migration 056 / WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01)', () => {
    test('a pre-delivered_to_issue tm_journal table is rebuilt so it accepts the delivered_to_issue grade', async () => {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      // Pre-056 shape: the grade CHECK includes 'unheard' (post-055) but NOT
      // 'delivered_to_issue' -- the exact on-disk shape migration 056 must widen.
      legacy.run(`
        CREATE TABLE tm_journal (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          thread_ref TEXT NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')),
          proposal_json TEXT NOT NULL,
          idempotency_key TEXT,
          before_hash TEXT,
          proof_predicate TEXT,
          proof_deadline_at TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')),
          graded_at TEXT,
          grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard'))
        )
      `);
      legacy.run(`
        INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome, grade)
        VALUES ('legacy-056-1', '2026-09-01T00:00:00.000Z', 'thread-1', 'escalate_p0', '{}', 'sent', 'unheard')
      `);
      legacy.close();

      // Reopening through SqliteAdapter must run the migration and rebuild the
      // table with the widened CHECK, without losing the pre-existing row.
      db = new SqliteAdapter(currentDbPath);

      const schema = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_journal'`
      );
      expect(schema.rows[0]?.sql).toContain('delivered_to_issue');

      const preserved = await db.query<{ id: string; grade: string | null }>(
        `SELECT id, grade FROM tm_journal WHERE id = 'legacy-056-1'`
      );
      expect(preserved.rows).toEqual([{ id: 'legacy-056-1', grade: 'unheard' }]);

      // The whole point of the migration: an INSERT grading a row
      // 'delivered_to_issue' must now succeed against the migrated database.
      await db.query(
        `INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome, grade)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          'legacy-056-2',
          '2026-09-23T00:00:00.000Z',
          'gh:thinmansoftware/bdc-harness#194',
          'escalate_p0',
          '{}',
          'sent',
          'delivered_to_issue',
        ]
      );
      const graded = await db.query<{ grade: string | null }>(
        `SELECT grade FROM tm_journal WHERE id = 'legacy-056-2'`
      );
      expect(graded.rows).toEqual([{ grade: 'delivered_to_issue' }]);
    });

    // Overseer review of PR #889 (head 84a8f479): DROP TABLE inside the
    // CHECK-widening rebuild drops every index and trigger on tm_journal. The
    // rebuild must recreate all of them in its own transaction. These tests
    // build OLD-shape databases WITH their indexes and a trigger, upgrade them
    // through SqliteAdapter, and inspect sqlite_master in the same process.
    const CANONICAL_TM_JOURNAL_INDEXES = [
      'idx_tm_journal_created',
      'idx_tm_journal_idem',
      'idx_tm_journal_thread',
    ];

    function legacyTmJournalDbWithDependents(createTableSql: string): void {
      currentDbPath = join(
        import.meta.dir,
        `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      );
      const legacy = new Database(currentDbPath);
      legacy.run(createTableSql);
      // The migration-041 indexes, exactly as a pre-rebuild database has them.
      legacy.run(
        'CREATE INDEX IF NOT EXISTS idx_tm_journal_thread ON tm_journal(thread_ref, created_at)'
      );
      legacy.run('CREATE INDEX IF NOT EXISTS idx_tm_journal_idem ON tm_journal(idempotency_key)');
      legacy.run('CREATE INDEX IF NOT EXISTS idx_tm_journal_created ON tm_journal(created_at)');
      // Objects createSchema() does not know about: they survive only if the
      // rebuild replays what was on the table, not just a hardcoded list.
      legacy.run('CREATE INDEX idx_tm_journal_outcome_legacy ON tm_journal(outcome)');
      legacy.run(`
        CREATE TRIGGER trg_tm_journal_no_delete_legacy BEFORE DELETE ON tm_journal
        BEGIN SELECT RAISE(ABORT, 'tm_journal is append-only'); END
      `);
      legacy.run(`
        INSERT INTO tm_journal (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
        VALUES ('legacy-dep-1', '2026-09-01T00:00:00.000Z', 'thread-1', 'nudge', '{}', 'idem-1', 'sent')
      `);
      legacy.close();
    }

    async function expectTmJournalDependentsPreserved(adapter: SqliteAdapter): Promise<void> {
      const indexes = await adapter.query<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'tm_journal' AND sql IS NOT NULL
         ORDER BY name`
      );
      expect(indexes.rows.map(r => r.name)).toEqual(
        [...CANONICAL_TM_JOURNAL_INDEXES, 'idx_tm_journal_outcome_legacy'].sort()
      );
      const triggers = await adapter.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tm_journal'`
      );
      expect(triggers.rows.map(r => r.name)).toEqual(['trg_tm_journal_no_delete_legacy']);

      // The replayed trigger is live, not just listed.
      let deleteError: unknown;
      try {
        await adapter.query(`DELETE FROM tm_journal WHERE id = 'legacy-dep-1'`);
      } catch (error: unknown) {
        deleteError = error;
      }
      expect(String(deleteError)).toContain('tm_journal is append-only');

      // The Taskmaster idempotency lookup is an index search, not a scan.
      // SqliteAdapter.query() only returns rows for SELECT/RETURNING, so read
      // the plan through a second handle on the same file, in this process.
      const planDb = new Database(currentDbPath, { readonly: true });
      try {
        const plan = planDb
          .prepare('EXPLAIN QUERY PLAN SELECT id FROM tm_journal WHERE idempotency_key = ?')
          .all('idem-1') as { detail: string }[];
        expect(plan.map(r => r.detail).join('\n')).toContain('USING INDEX idx_tm_journal_idem');
      } finally {
        planDb.close();
      }

      const preserved = await adapter.query<{ id: string }>(
        `SELECT id FROM tm_journal WHERE idempotency_key = 'idem-1'`
      );
      expect(preserved.rows).toEqual([{ id: 'legacy-dep-1' }]);
    }

    test('the 056 rebuild of a pre-056 tm_journal preserves every index and trigger on the table', async () => {
      legacyTmJournalDbWithDependents(`
        CREATE TABLE tm_journal (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          thread_ref TEXT NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest', 'fire_cauldron')),
          proposal_json TEXT NOT NULL,
          idempotency_key TEXT,
          before_hash TEXT,
          proof_predicate TEXT,
          proof_deadline_at TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')),
          graded_at TEXT,
          grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful', 'unheard'))
        )
      `);

      db = new SqliteAdapter(currentDbPath);

      const schema = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_journal'`
      );
      expect(schema.rows[0]?.sql).toContain('delivered_to_issue');
      await expectTmJournalDependentsPreserved(db);
    });

    test('a pre-045 tm_journal upgraded through the 045, 055 and 056 rebuilds keeps every index and trigger', async () => {
      // Four-verb, pre-'unheard' shape: all three rebuilds fire back to back,
      // so each must hand the next one a table that still has its dependents.
      legacyTmJournalDbWithDependents(`
        CREATE TABLE tm_journal (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          thread_ref TEXT NOT NULL,
          action_type TEXT NOT NULL CHECK (action_type IN ('deliver_ruling', 'nudge', 'escalate_p0', 'digest')),
          proposal_json TEXT NOT NULL,
          idempotency_key TEXT,
          before_hash TEXT,
          proof_predicate TEXT,
          proof_deadline_at TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'parked', 'deferred', 'rejected', 'expired', 'failed')),
          graded_at TEXT,
          grade TEXT CHECK (grade IS NULL OR grade IN ('useful', 'noise', 'harmful'))
        )
      `);

      db = new SqliteAdapter(currentDbPath);

      const schema = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tm_journal'`
      );
      expect(schema.rows[0]?.sql).toContain('fire_cauldron');
      expect(schema.rows[0]?.sql).toContain('delivered_to_issue');
      await expectTmJournalDependentsPreserved(db);
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

  describe('agent messaging Phase 1.5 sender principal rebuild', () => {
    test('rebuild is idempotent and preserves rows', async () => {
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
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          not_before TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          fencing_token INTEGER NOT NULL DEFAULT 0,
          priority TEXT NOT NULL DEFAULT 'normal',
          task_outcome TEXT,
          acknowledged_at TEXT,
          acknowledged_by TEXT,
          addressed_at TEXT,
          addressed_by TEXT,
          escalated_tg_at TEXT,
          escalated_sms_at TEXT,
          subject_key TEXT,
          repeat_reason TEXT,
          route_disposition TEXT,
          supersedes_id TEXT REFERENCES agent_dispatch_messages(id)
        )
      `);
      legacy.run(`
        INSERT INTO agent_dispatch_messages
          (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, priority)
        VALUES
          ('p15-1', 'c1', 'k1', 'agent_message', 'claude', 'codex', 'hello', 'queued', '2026-08-05T00:00:00.000Z', 'normal'),
          ('p15-2', 'c2', 'k2', 'agent_message', 'fusion', 'codex', 'world', 'done', '2026-08-05T00:00:01.000Z', 'normal')
      `);
      legacy.close();

      db = new SqliteAdapter(currentDbPath);
      const first = await db.query<{ id: string; sender_principal_id: string | null }>(
        `SELECT id, sender_principal_id FROM agent_dispatch_messages ORDER BY id`
      );
      expect(first.rows).toEqual([
        { id: 'p15-1', sender_principal_id: null },
        { id: 'p15-2', sender_principal_id: null },
      ]);
      await db.close();

      db = new SqliteAdapter(currentDbPath);
      const second = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM agent_dispatch_messages`
      );
      expect(second.rows[0]?.count).toBe(2);
      const indexes = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uq_agent_dispatch_messages_%' ORDER BY name`
      );
      expect(indexes.rows.map(r => r.name)).toEqual([
        'uq_agent_dispatch_messages_idempotency_legacy',
        'uq_agent_dispatch_messages_sender_idempotency_authenticated',
      ]);
    });

    test('phase15 rebuild path is outside the best-effort warn block', async () => {
      // The method is invoked after the warn-wrapped phase0 column migration.
      // A successful rebuild leaves foreign_keys enabled and both partial indexes present.
      db = createTestDb();
      const fk = await db.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
      expect(Number(fk.rows[0]?.foreign_keys ?? 0)).toBe(1);
      const tableSql = await db.query<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_messages'`
      );
      expect(tableSql.rows[0]?.sql ?? '').toContain('sender_principal_id');
      expect(tableSql.rows[0]?.sql ?? '').not.toMatch(/idempotency_key TEXT NOT NULL UNIQUE/i);
    });
  });
});
