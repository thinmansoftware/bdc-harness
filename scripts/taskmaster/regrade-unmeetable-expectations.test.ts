import { describe, test, expect, afterEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '../../packages/core/src/db/adapters/sqlite';
import { regradeUnmeetableExpectations } from './regrade-unmeetable-expectations';

// Test 6 (regrade_script_dry_run_and_confirm): a fixture with 5 escalated
// mailbox expectations (recipient operator == drain_on_start) carrying
// dispatch_reply_exists specs, and 2 to codex (worker_poll). Dry run counts 5
// and mutates nothing; --confirm gives up the 5, regrades their journal actions
// to NULL, leaves the 2 codex rows untouched, writes exactly one bdc-xo#2028
// note, and a second --confirm reports 0.

let currentDbPath = '';

function createTestDb(): SqliteAdapter {
  currentDbPath = join(
    import.meta.dir,
    `.test-regrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  return new SqliteAdapter(currentDbPath);
}

async function seedExpectation(
  db: SqliteAdapter,
  opts: { id: string; recipient: string; journalId: string }
): Promise<void> {
  await db.query(
    `INSERT INTO tm_expectations
       (id, registration_key, dispatch_ref, recipient, evidence_json, due_at, on_absence,
        max_retries, retries, status, registered_by, self_supervised, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, '1970-01-01T00:00:00.000Z', 'escalate', 2, 2, 'escalated',
             'taskmaster', 0, '2026-09-15T00:00:00.000Z', '2026-09-16T00:00:00.000Z')`,
    [
      opts.id,
      `key-${opts.id}`,
      `dispatch-${opts.id}`,
      opts.recipient,
      JSON.stringify({
        kind: 'dispatch_reply_exists',
        correlation_id: `tm-${opts.journalId}`,
        classification: 'succeeded',
      }),
    ]
  );
  await db.query(
    `INSERT INTO tm_journal
       (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome, grade, graded_at)
     VALUES ($1, '2026-09-15T00:00:00.000Z', $2, 'escalate_p0', '{}', $3, 'sent', 'noise', '2026-09-16T00:00:00.000Z')`,
    [opts.journalId, `thread-${opts.journalId}`, `tm:key-${opts.journalId}`]
  );
}

async function statusOf(db: SqliteAdapter, id: string): Promise<string | undefined> {
  const r = await db.query<{ status: string }>('SELECT status FROM tm_expectations WHERE id = $1', [
    id,
  ]);
  return r.rows[0]?.status;
}

async function gradeOf(db: SqliteAdapter, journalId: string): Promise<string | null | undefined> {
  const r = await db.query<{ grade: string | null }>('SELECT grade FROM tm_journal WHERE id = $1', [
    journalId,
  ]);
  return r.rows[0]?.grade;
}

async function noteCount(db: SqliteAdapter): Promise<number> {
  const r = await db.query<{ cnt: number | string }>(
    "SELECT COUNT(*) AS cnt FROM tm_journal WHERE idempotency_key = 'tm:2028:unmeetable-mailbox-regrade'"
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

describe('regrade-unmeetable-expectations', () => {
  let db: SqliteAdapter;

  afterEach(async () => {
    if (db) await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(currentDbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
  });

  test('regrade_script_dry_run_and_confirm', async () => {
    db = createTestDb();
    // operator == drain_on_start, codex == worker_poll (both seeded by default).
    for (let i = 1; i <= 5; i += 1) {
      await seedExpectation(db, {
        id: `exp-op-${i}`,
        recipient: 'operator',
        journalId: `jrnl-op-${i}`,
      });
    }
    for (let i = 1; i <= 2; i += 1) {
      await seedExpectation(db, {
        id: `exp-cx-${i}`,
        recipient: 'codex',
        journalId: `jrnl-cx-${i}`,
      });
    }

    // DRY RUN: matches 5, mutates nothing.
    const dry = await regradeUnmeetableExpectations(db, { confirm: false });
    expect(dry.matched).toBe(5);
    expect(dry.regradedJournalActions).toBe(0);
    expect(dry.noteWritten).toBe(false);
    expect(await statusOf(db, 'exp-op-1')).toBe('escalated');
    expect(await gradeOf(db, 'jrnl-op-1')).toBe('noise');
    expect(await noteCount(db)).toBe(0);

    // CONFIRM: gives up the 5 operator rows, regrades their journals to NULL,
    // leaves the 2 codex rows untouched, writes exactly one note.
    const confirmed = await regradeUnmeetableExpectations(db, { confirm: true });
    expect(confirmed.matched).toBe(5);
    expect(confirmed.regradedJournalActions).toBe(5);
    expect(confirmed.noteWritten).toBe(true);
    for (let i = 1; i <= 5; i += 1) {
      expect(await statusOf(db, `exp-op-${i}`)).toBe('given_up');
      expect(await gradeOf(db, `jrnl-op-${i}`)).toBeNull();
    }
    // codex (worker_poll) rows are NOT mailbox -> untouched.
    for (let i = 1; i <= 2; i += 1) {
      expect(await statusOf(db, `exp-cx-${i}`)).toBe('escalated');
      expect(await gradeOf(db, `jrnl-cx-${i}`)).toBe('noise');
    }
    // The reason is recorded on the given-up rows.
    const reason = await db.query<{ evidence_pointer: string | null }>(
      'SELECT evidence_pointer FROM tm_expectations WHERE id = $1',
      ['exp-op-1']
    );
    expect(reason.rows[0]?.evidence_pointer).toBe('unmeetable_mailbox_reply_spec');
    expect(await noteCount(db)).toBe(1);

    // SECOND CONFIRM: reports 0 and does not duplicate the note.
    const again = await regradeUnmeetableExpectations(db, { confirm: true });
    expect(again.matched).toBe(0);
    expect(again.noteWritten).toBe(false);
    expect(await noteCount(db)).toBe(1);
  });
});
