/**
 * One-shot regrade of structurally-unmeetable mailbox expectations
 * (WO-HARNESS-TASKMASTER-MAILBOX-EVIDENCE-01, bdc-xo#2028).
 *
 * Before this WO, every Taskmaster send to a MAILBOX principal (operator, xo,
 * and any other drain_on_start / notify_only recipient) registered a
 * `dispatch_reply_exists` expectation demanding a status='done' reply. Mailbox
 * principals are READ, never replied to, so that proof could never arrive: the
 * expectation exhausted its retries, escalated a blocker to xo, and -- before
 * M-155 Amendment 03 -- the underlying send was graded 'noise', dragging the
 * useful-rate floor down until Taskmaster paused ITSELF.
 *
 * The code change fixes NEW expectations (a read is now the proof). This script
 * repairs the HISTORICAL rows so a resume computes the floor honestly:
 *   - tm_expectations rows in ('escalated','failed') whose recipient is a
 *     mailbox principal and whose evidence kind is dispatch_reply_exists are
 *     marked `given_up` with reason `unmeetable_mailbox_reply_spec`;
 *   - the linked tm_journal action (identified by the expectation's
 *     `tm-<journal id>` correlation) is regraded to NULL (ungraded), so it no
 *     longer counts as noise in the epoch-bounded useful-rate lookback;
 *   - exactly one tm_journal note citing bdc-xo#2028 is written.
 *
 * Usage:
 *   bun scripts/taskmaster/regrade-unmeetable-expectations.ts            # dry-run count
 *   bun scripts/taskmaster/regrade-unmeetable-expectations.ts --confirm  # mutate
 *
 * - Dry-run by default: prints the matching row count and exits. Requires an
 *   explicit --confirm flag to mutate anything.
 * - Idempotent: a second --confirm run matches 0 rows (the first run moved them
 *   out of escalated/failed) and never duplicates the note.
 * - NEVER invoked by the loop. Operator-side, run once at the rebuild that lands
 *   this WO, per the wiki runbook.
 */
import { randomUUID } from 'node:crypto';
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';
import type { IDatabase } from '../../packages/core/src/db/adapters/types';

const JOURNAL_IDEMPOTENCY_KEY = 'tm:2028:unmeetable-mailbox-regrade';
const GIVEN_UP_REASON = 'unmeetable_mailbox_reply_spec';

interface CandidateRow {
  id: string;
  evidence_json: string;
}

export interface RegradeResult {
  /** Expectations matched as unmeetable mailbox-reply specs. */
  matched: number;
  /** tm_journal actions whose grade was cleared to NULL. */
  regradedJournalActions: number;
  /** Whether the bdc-xo#2028 note was written on this run. */
  noteWritten: boolean;
}

/**
 * The journal action id an expectation supervises. loop.ts dispatches with
 * `correlation_id: tm-<journal id>` and stores the same value in the
 * dispatch_reply_exists evidence, so stripping the `tm-` prefix recovers the
 * tm_journal row to regrade. Returns null when the shape does not match, so a
 * malformed row is skipped rather than mis-regrading an unrelated action.
 */
function journalActionIdFromEvidence(evidenceJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { kind?: unknown }).kind !== 'dispatch_reply_exists'
  ) {
    return null;
  }
  const correlationId = (parsed as { correlation_id?: unknown }).correlation_id;
  if (typeof correlationId !== 'string' || !correlationId.startsWith('tm-')) return null;
  const actionId = correlationId.slice('tm-'.length);
  return actionId.length > 0 ? actionId : null;
}

/**
 * Candidate expectations: escalated/failed, owed by a mailbox principal, with a
 * dispatch_reply_exists spec. The kind is re-checked in JS (not just a SQL LIKE)
 * so a correlation_id that happens to contain the token cannot be mismatched.
 */
async function findCandidates(db: IDatabase): Promise<CandidateRow[]> {
  const result = await db.query<CandidateRow>(
    `SELECT e.id AS id, e.evidence_json AS evidence_json
       FROM tm_expectations e
       JOIN dispatch_principals dp
         ON dp.principal_id = LOWER(TRIM(e.recipient))
      WHERE e.status IN ('escalated', 'failed')
        AND dp.delivery_mode IN ('drain_on_start', 'notify_only')`
  );
  return result.rows.filter(row => journalActionIdFromEvidence(row.evidence_json) !== null);
}

/**
 * Regrade the historical unmeetable mailbox expectations. Dry-run by default;
 * mutates only when `confirm` is true, and then inside a single transaction so
 * the expectation give-ups, the journal regrades and the note commit together.
 */
export async function regradeUnmeetableExpectations(
  db: IDatabase,
  opts: { confirm: boolean }
): Promise<RegradeResult> {
  const candidates = await findCandidates(db);
  if (!opts.confirm || candidates.length === 0) {
    return { matched: candidates.length, regradedJournalActions: 0, noteWritten: false };
  }

  const nowIso = new Date().toISOString();
  let regradedJournalActions = 0;
  let noteWritten = false;

  await db.withTransaction(async query => {
    for (const candidate of candidates) {
      // Give up the expectation. Conditioned on the row still being in the
      // matched set so a concurrent run cannot double-apply.
      await query(
        `UPDATE tm_expectations
            SET status = 'given_up', evidence_pointer = $1, updated_at = $2
          WHERE id = $3 AND status IN ('escalated', 'failed')`,
        [GIVEN_UP_REASON, nowIso, candidate.id]
      );
      // Regrade the linked journal action to ungraded, only when it carries a
      // grade (idempotent; a second run finds NULL and touches nothing).
      const actionId = journalActionIdFromEvidence(candidate.evidence_json);
      if (actionId) {
        const updated = await query(
          `UPDATE tm_journal SET grade = NULL, graded_at = NULL
            WHERE id = $1 AND grade IS NOT NULL`,
          [actionId]
        );
        regradedJournalActions += updated.rowCount;
      }
    }

    // Exactly one note, idempotent on a stable key.
    const existingNote = await query<{ id: string }>(
      'SELECT id FROM tm_journal WHERE idempotency_key = $1',
      [JOURNAL_IDEMPOTENCY_KEY]
    );
    if (existingNote.rows.length === 0) {
      await query(
        `INSERT INTO tm_journal
           (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
         VALUES ($1, $2, $3, 'digest', $4, $5, 'expired')`,
        [
          randomUUID(),
          nowIso,
          'tm:2028:unmeetable-mailbox-regrade',
          JSON.stringify({
            note:
              `Regraded ${candidates.length} structurally-unmeetable mailbox expectations ` +
              '(status escalated/failed, dispatch_reply_exists spec owed by a drain_on_start / ' +
              `notify_only principal) to given_up (reason ${GIVEN_UP_REASON}) and cleared their ` +
              'linked tm_journal grades to NULL so the useful-rate floor is recomputed honestly ' +
              'on resume. Authority: bdc-xo#2028 ' +
              '(WO-HARNESS-TASKMASTER-MAILBOX-EVIDENCE-01). One-shot operator action at the ' +
              'rebuild that lands the WO; never run by the loop.',
            matched: candidates.length,
            reason: GIVEN_UP_REASON,
          }),
          JOURNAL_IDEMPOTENCY_KEY,
        ]
      );
      noteWritten = true;
    }
  });

  return { matched: candidates.length, regradedJournalActions, noteWritten };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const db = getDatabase();

  if (!confirm) {
    const candidates = await findCandidates(db);
    console.log(
      `[dry-run] ${candidates.length} unmeetable mailbox expectation(s) ` +
        '(escalated/failed, dispatch_reply_exists, mailbox recipient) match. ' +
        'Re-run with --confirm to give them up and regrade their journal actions (bdc-xo#2028).'
    );
    return;
  }

  const result = await regradeUnmeetableExpectations(db, { confirm: true });
  if (result.matched === 0) {
    console.log('Nothing to regrade: 0 matching rows.');
    return;
  }
  console.log(
    `Regraded ${result.matched} unmeetable mailbox expectation(s) to given_up ` +
      `(reason ${GIVEN_UP_REASON}), cleared ${result.regradedJournalActions} journal grade(s), ` +
      `and ${result.noteWritten ? 'wrote' : 'reused'} the bdc-xo#2028 citation note.`
  );
}

// Only run the CLI when invoked directly, so the test can import the pure
// function without triggering a real database connection.
if (import.meta.main) {
  main()
    .then(async () => {
      await closeDatabase();
    })
    .catch(async (error: unknown) => {
      console.error('regrade-unmeetable-expectations failed:', error);
      await closeDatabase();
      process.exitCode = 1;
    });
}
