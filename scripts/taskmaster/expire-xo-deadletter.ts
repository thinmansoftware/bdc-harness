/**
 * One-shot M-155 dead-letter expiry (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01,
 * receipt-honesty corrected by WO-HARNESS-DISPATCH-HONEST-RECEIPTS-01 / M-187a).
 *
 * Marks the queued, never-heard recipient='xo' taskmaster messages as EXPIRED
 * via route_disposition (a machine disposition, NOT a receipt), with a
 * tm_journal note citing M-155. The Taskmaster sent them into a mailbox faster
 * than it was drained; M-155 ruled the backlog dead-letter (DoD D-4: messages
 * must reach a surface someone reads). Post-M-187a a machine records what it did
 * in route_disposition + route_disposed_at and never in acknowledged_* /
 * addressed_* -- so this script writes disposition 'expired' through the
 * machine primitive disposeMessageByMachineInTransaction with actor
 * 'system:m155-deadletter-expiry', per matching row inside the existing single
 * transaction, and writes no receipt columns.
 *
 * Usage:
 *   bun scripts/taskmaster/expire-xo-deadletter.ts            # dry-run count
 *   bun scripts/taskmaster/expire-xo-deadletter.ts --confirm  # mutate
 *
 * - Dry-run by default: prints the matching row count and exits. Requires an
 *   explicit --confirm flag to mutate anything.
 * - Recipient is matched NORMALIZED -- LOWER(TRIM(recipient)) = 'xo' -- the
 *   same normalization migration 040 uses to seed dispatch_principals.
 *   (TRIM is standard SQL -- the deployed archon DB is SQLite, not Postgres.)
 * - NEVER invoked by the loop. Run once at Deploy 2 (M-155 gates G9/G10),
 *   operator-side, per the PR runbook section.
 */
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';
import { disposeMessageByMachineInTransaction } from '../../packages/core/src/db/dispatch';
import { randomUUID } from 'node:crypto';

const MATCH_WHERE = `
  sender = 'taskmaster'
  AND LOWER(TRIM(recipient)) = 'xo'
  AND status = 'queued'
  AND acknowledged_at IS NULL
  AND addressed_at IS NULL
  AND route_disposition IS NULL
`;

const JOURNAL_IDEMPOTENCY_KEY = 'tm:m155:deadletter-expiry';
const EXPIRY_ACTOR = 'system:m155-deadletter-expiry';

async function countMatching(): Promise<number> {
  const result = await getDatabase().query<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM agent_dispatch_messages WHERE ${MATCH_WHERE}`
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const db = getDatabase();
  const matching = await countMatching();

  if (!confirm) {
    console.log(
      `[dry-run] ${matching} queued, never-heard recipient='xo' taskmaster ` +
        'messages match. Re-run with --confirm to mark them expired via ' +
        'route_disposition (M-155 / M-187a).'
    );
    return;
  }

  if (matching === 0) {
    console.log('Nothing to expire: 0 matching rows.');
    return;
  }

  const nowIso = new Date().toISOString();
  // Single transaction: the per-row dispositions and the M-155 journal note
  // commit together or not at all. Without this, a failed journal insert after
  // committed dispositions would leave the expiry permanently unjournaled -- a
  // rerun sees 0 matching rows and exits before ever reaching the insert.
  let expired = 0;
  await db.withTransaction(async query => {
    const rows = await query<{ id: string }>(
      `SELECT id FROM agent_dispatch_messages WHERE ${MATCH_WHERE}`
    );
    for (const row of rows.rows) {
      // Machines write route_disposition + route_disposed_at only (M-187a). No
      // receipt column is touched. already_disposed on a rerun is harmless.
      const result = await disposeMessageByMachineInTransaction(
        query,
        { id: row.id, actor: EXPIRY_ACTOR, disposition: 'expired' },
        nowIso
      );
      if (result.ok) expired += 1;
      else if (result.reason !== 'already_disposed') {
        throw new Error(`m155_expiry_dispose_failed:${result.reason}:${row.id}`);
      }
    }

    // Journal note citing M-155 (idempotent: skipped when the note already
    // exists from a prior completed run). action_type/outcome use existing
    // tm_journal CHECK values; the citation lives in proposal_json.
    const existingNote = await query<{ id: string }>(
      'SELECT id FROM tm_journal WHERE idempotency_key = $1',
      [JOURNAL_IDEMPOTENCY_KEY]
    );
    if (existingNote.rows.length === 0) {
      // M-187a contract: the machine actor is LOGGED for provenance but NEVER
      // stored -- so it is emitted here and deliberately omitted from
      // proposal_json below.
      console.log(
        `[m155] journaling dead-letter expiry (actor=${EXPIRY_ACTOR}, ` +
          `expired_count=${expired}); actor is logged, never persisted.`
      );
      await query(
        `INSERT INTO tm_journal
           (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
         VALUES ($1, $2, $3, 'digest', $4, $5, 'expired')`,
        [
          randomUUID(),
          nowIso,
          'm155:deadletter-expiry',
          JSON.stringify({
            note:
              `M-155 dead-letter expiry: marked ${expired} queued, never-heard ` +
              "recipient='xo' taskmaster messages expired via route_disposition. " +
              'Authority: M-20260817-155 ' +
              '(docs/board/motions/M-20260817-155-taskmaster-course-correction.md), ' +
              'DoD D-4, and M-187a (machines write route_disposition, never receipts). ' +
              'One-shot operator action at Deploy 2; never run by the loop.',
            expired_count: expired,
            disposition: 'expired',
          }),
          JOURNAL_IDEMPOTENCY_KEY,
        ]
      );
    }
  });

  console.log(
    `Marked ${expired} taskmaster dead-letter messages expired ` +
      `(route_disposition=expired, actor=${EXPIRY_ACTOR}) and journaled the M-155 citation.`
  );
}

main()
  .then(async () => {
    await closeDatabase();
  })
  .catch(async (error: unknown) => {
    console.error('expire-xo-deadletter failed:', error);
    await closeDatabase();
    process.exitCode = 1;
  });
