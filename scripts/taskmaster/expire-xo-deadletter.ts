/**
 * One-shot dead-letter expiry for Taskmaster's queued 'xo' mailbox.
 *
 * WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01 (M-155 WO 3), Section 7.
 *
 * Context: Taskmaster's exception-push rewrite ends the noise stream that
 * produced ~920 queued, never-addressed recipient='xo' messages -- a dead-letter
 * box no reader ever drained. This script retires that backlog by marking those
 * rows addressed, so the go-forward loop starts from a clean mailbox. It is a
 * ONE-SHOT operator action run once at Deploy 2 (M-155 gate G9/G10) -- it is NOT
 * invoked by the loop and it never un-pauses anything.
 *
 * Safety:
 *   - Default is a DRY RUN: it prints the count that WOULD be expired and exits
 *     without writing.
 *   - It only writes when passed an explicit --confirm flag.
 *   - It matches the recipient NORMALIZED via LOWER(BTRIM(recipient)) = 'xo',
 *     the same identity normalization migration 040 (L51) applies -- never a raw
 *     string compare.
 *   - It scopes to sender='taskmaster' and status='queued' with addressed_at
 *     IS NULL, so only Taskmaster's own never-drained dead letters are touched.
 *
 * Usage:
 *   bun run scripts/taskmaster/expire-xo-deadletter.ts            # dry run (count only)
 *   bun run scripts/taskmaster/expire-xo-deadletter.ts --confirm  # actually expire
 */
// Root scripts are not workspace-package consumers, so Bun does not link
// @archon/* here; import from the package source by relative path (matches
// scripts/dispatch-worker/report-unroutable.ts).
import { getDatabase, closeDatabase } from '../../packages/core/src/db/connection';

/** addressed_by audit value -- cites the ratified motion for the journal trail. */
const ADDRESSED_BY = 'taskmaster:m155-deadletter';

/** Shared predicate: queued, never-addressed, taskmaster-sent, recipient 'xo'. */
const MATCH_WHERE =
  "status = 'queued' AND addressed_at IS NULL AND sender = 'taskmaster' " +
  "AND LOWER(BTRIM(recipient)) = 'xo'";

async function countMatching(): Promise<number> {
  const result = await getDatabase().query<{ cnt: number | string }>(
    `SELECT COUNT(*) AS cnt FROM agent_dispatch_messages WHERE ${MATCH_WHERE}`
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

async function expireMatching(nowIso: string): Promise<void> {
  await getDatabase().query(
    `UPDATE agent_dispatch_messages
        SET addressed_at = $1, addressed_by = $2
      WHERE ${MATCH_WHERE}`,
    [nowIso, ADDRESSED_BY]
  );
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const count = await countMatching();

  if (!confirm) {
    process.stdout.write(
      `[dry-run] ${count} queued never-addressed taskmaster 'xo' dead-letter ` +
        'message(s) match. Re-run with --confirm to expire them (M-155 WO 3).\n'
    );
    return;
  }

  if (count === 0) {
    process.stdout.write('[confirm] 0 matching messages -- nothing to expire.\n');
    return;
  }

  const nowIso = new Date().toISOString();
  await expireMatching(nowIso);
  const remaining = await countMatching();
  process.stdout.write(
    `[confirm] Expired ${count} taskmaster 'xo' dead-letter message(s) as addressed ` +
      `(addressed_by='${ADDRESSED_BY}', citing M-155). Remaining matching: ${remaining}.\n`
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`expire-xo-deadletter failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
