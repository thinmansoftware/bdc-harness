/**
 * One-shot M-155 dead-letter expiry (WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01).
 *
 * Marks the ~920 queued, never-addressed recipient='xo' taskmaster messages
 * as addressed, with a tm_journal note citing M-155. The Taskmaster sent them
 * into a mailbox faster than it was drained; M-155 ruled the backlog
 * dead-letter (DoD D-4: messages must reach a surface someone reads).
 *
 * Usage:
 *   bun scripts/taskmaster/expire-xo-deadletter.ts            # dry-run count
 *   bun scripts/taskmaster/expire-xo-deadletter.ts --confirm  # mutate
 *
 * - Dry-run by default: prints the matching row count and exits. Requires an
 *   explicit --confirm flag to mutate anything.
 * - Recipient is matched NORMALIZED -- LOWER(BTRIM(recipient)) = 'xo' -- the
 *   same normalization migration 040 uses to seed dispatch_principals.
 *   (BTRIM is Postgres; this one-shot targets the production Postgres DB.)
 * - NEVER invoked by the loop. Run once at Deploy 2 (M-155 gates G9/G10),
 *   operator-side, per the PR runbook section.
 */
import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';

const MATCH_WHERE = `
  sender = 'taskmaster'
  AND LOWER(BTRIM(recipient)) = 'xo'
  AND status = 'queued'
  AND addressed_at IS NULL
`;

const JOURNAL_IDEMPOTENCY_KEY = 'tm:m155:deadletter-expiry';
const ADDRESSED_BY = 'xo:m155-deadletter-expiry';

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
      `[dry-run] ${matching} queued, never-addressed recipient='xo' taskmaster ` +
        'messages match. Re-run with --confirm to mark them addressed (M-155).'
    );
    return;
  }

  if (matching === 0) {
    console.log('Nothing to expire: 0 matching rows.');
    return;
  }

  const nowIso = new Date().toISOString();
  await db.query(
    `UPDATE agent_dispatch_messages
        SET addressed_at = $1, addressed_by = $2
      WHERE ${MATCH_WHERE}`,
    [nowIso, ADDRESSED_BY]
  );

  // Journal note citing M-155 (idempotent: skipped when the note already
  // exists from a prior run). action_type/outcome use existing tm_journal
  // CHECK values; the citation lives in proposal_json.
  const existingNote = await db.query<{ id: string }>(
    'SELECT id FROM tm_journal WHERE idempotency_key = $1',
    [JOURNAL_IDEMPOTENCY_KEY]
  );
  if (existingNote.rows.length === 0) {
    await db.query(
      `INSERT INTO tm_journal
         (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
       VALUES ($1, $2, $3, 'digest', $4, $5, 'expired')`,
      [
        randomUUID(),
        nowIso,
        'm155:deadletter-expiry',
        JSON.stringify({
          note:
            `M-155 dead-letter expiry: marked ${matching} queued, never-addressed ` +
            "recipient='xo' taskmaster messages as addressed. Authority: " +
            'M-20260817-155 (docs/board/motions/M-20260817-155-taskmaster-course-correction.md), ' +
            'DoD D-4. One-shot operator action at Deploy 2; never run by the loop.',
          expired_count: matching,
          addressed_by: ADDRESSED_BY,
        }),
        JOURNAL_IDEMPOTENCY_KEY,
      ]
    );
  }

  console.log(
    `Marked ${matching} taskmaster dead-letter messages addressed (addressed_by=${ADDRESSED_BY}) ` +
      'and journaled the M-155 citation.'
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
