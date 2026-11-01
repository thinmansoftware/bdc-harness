/**
 * Child-process SQLite probe for the malformed stale-verdict sweep.
 *
 * The parent test file must not import this module and must not install a
 * process-global getDatabase() mock. This process owns the only handle, and
 * closeDatabase() runs only here.
 */
import type { IDatabase } from '@archon/core/db/adapters/types';
import { closeDatabase, getDatabase } from '@archon/core/db/connection';
import type { StandingVerdict } from '@archon/overseer/pr-review-check-ingest';
import {
  createMemorySweepCursor,
  runStaleVerdictSweep,
  type LatestCheckCompletion,
  type StaleVerdictSweepDeps,
  type SweepCandidate,
} from './stale-verdict-sweep';
import { listRealSweepCandidates } from './stale-verdict-sweep-wiring';

const REVIEW_RECIPIENT = 'overseer-reviewer';
const TOTAL_ROWS = 60;
/** Rows 1..50 are malformed -- a full default page of them. */
const MALFORMED_THROUGH = 50;
/** The only row that can ever become a candidate. */
const ELIGIBLE_ROW = 55;

interface PageProbe {
  kind: 'page';
  candidatesLength: number;
  rawCount: number;
  discarded: number;
  lastRawSeq: number;
  firstPrNumber: number | null;
}

interface WalkProbe {
  kind: 'walk';
  firstExamined: number;
  firstEnqueued: number;
  firstDiscarded: number;
  firstAfterSeq: number;
  cursorAfterFirst: number;
  cursorAfterSecond: number;
  totalEnqueued: number;
  enqueuedPrs: number[];
}

interface RewindProbe {
  kind: 'rewind';
  afterSeq: number;
  cursor: number;
}

type ProbePayload = PageProbe | WalkProbe | RewindProbe;

async function seedRows(db: IDatabase): Promise<void> {
  for (let index = 1; index <= TOTAL_ROWS; index += 1) {
    const malformed = index <= MALFORMED_THROUGH;
    const body = malformed
      ? index % 2 === 0
        ? '{ this is not json'
        : JSON.stringify({ note: 'parses, but carries no review fields' })
      : JSON.stringify({
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: index,
          headSha: `head-${index}`,
          baseRef: 'dev',
          author: 'bluedevilcollectibles',
        });
    await db.query(
      `INSERT INTO agent_dispatch_messages
         (id, correlation_id, idempotency_key, task_type, sender, recipient, body,
          status, created_at, priority, fencing_token, seq)
       VALUES ($1, $2, $3, 'run_review', 'overseer', $4, $5, 'done', $6, 'normal', 0, $7)`,
      [
        `msg-${index}`,
        `pr-review:thinmansoftware/bdc-harness#${index}@head-${index}`,
        `pr-review:${index}`,
        REVIEW_RECIPIENT,
        body,
        new Date(Date.UTC(2026, 8, 8, 0, 0, 0) + index * 1000).toISOString(),
        index,
      ]
    );
  }
}

async function pageProbe(limit: number, afterSeq: number): Promise<PageProbe> {
  const page = await listRealSweepCandidates(limit, afterSeq);
  return {
    kind: 'page',
    candidatesLength: page.candidates.length,
    rawCount: page.rawCount,
    discarded: page.discarded,
    lastRawSeq: page.lastRawSeq,
    firstPrNumber: page.candidates[0]?.prNumber ?? null,
  };
}

function secondHeartbeatDeps(enqueued: number[]): StaleVerdictSweepDeps {
  return {
    listCandidates: listRealSweepCandidates,
    readStandingVerdict: async (candidate: SweepCandidate): Promise<StandingVerdict | null> =>
      candidate.prNumber === ELIGIBLE_ROW
        ? {
            headSha: candidate.headSha,
            disposition: 'changes_requested',
            summary: '[major] checks/test (windows-latest): required check failed',
            recordedAt: '2026-09-08T12:00:00.000Z',
          }
        : {
            headSha: candidate.headSha,
            disposition: 'approved',
            summary: 'No blocking findings.',
            recordedAt: '2026-09-08T12:00:00.000Z',
          },
    readLatestCheckCompletion: async (): Promise<LatestCheckCompletion | null> => ({
      checkId: 'check_run:555',
      checkName: 'test (windows-latest)',
      conclusion: 'success',
      completedAt: '2026-09-08T16:00:00.000Z',
      allChecksGreen: true,
    }),
    enqueueRecheckWork: async (input: {
      prNumber: number;
    }): Promise<{ messageId: string; alreadyExisted: boolean }> => {
      enqueued.push(input.prNumber);
      return { messageId: `msg-${input.prNumber}`, alreadyExisted: false };
    },
  };
}

async function walkSecondHeartbeat(): Promise<WalkProbe> {
  const enqueued: number[] = [];
  const deps = secondHeartbeatDeps(enqueued);
  const cursor = createMemorySweepCursor();
  const first = await runStaleVerdictSweep(deps, 3, cursor);
  const cursorAfterFirst = await cursor.read();
  const second = await runStaleVerdictSweep(deps, 3, cursor);
  return {
    kind: 'walk',
    firstExamined: first.examined,
    firstEnqueued: first.enqueued,
    firstDiscarded: first.discarded,
    firstAfterSeq: first.afterSeq,
    cursorAfterFirst,
    cursorAfterSecond: await cursor.read(),
    totalEnqueued: second.enqueued + first.enqueued,
    enqueuedPrs: enqueued,
  };
}

async function walkExhaustedRewind(): Promise<RewindProbe> {
  const deps: StaleVerdictSweepDeps = {
    listCandidates: listRealSweepCandidates,
    readStandingVerdict: async candidate => ({
      headSha: candidate.headSha,
      disposition: 'approved',
      summary: 'No blocking findings.',
      recordedAt: '2026-09-08T12:00:00.000Z',
    }),
    readLatestCheckCompletion: async () => null,
    enqueueRecheckWork: async () => ({ messageId: 'unused', alreadyExisted: true }),
  };
  const cursor = createMemorySweepCursor(TOTAL_ROWS);
  const result = await runStaleVerdictSweep(deps, 3, cursor);
  return {
    kind: 'rewind',
    afterSeq: result.afterSeq,
    cursor: await cursor.read(),
  };
}

async function runScenario(scenario: string): Promise<ProbePayload> {
  if (scenario === 'page-malformed') return pageProbe(3, 0);
  if (scenario === 'page-resume') return pageProbe(3, MALFORMED_THROUGH);
  if (scenario === 'page-exhausted') return pageProbe(3, TOTAL_ROWS);
  if (scenario === 'walk-second-heartbeat') return walkSecondHeartbeat();
  if (scenario === 'walk-exhausted-rewind') return walkExhaustedRewind();
  throw new Error(`unknown_probe_scenario:${scenario}`);
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? '';
  try {
    const db = getDatabase();
    if (db.dialect !== 'sqlite') throw new Error('isolated_sqlite_required');
    await seedRows(db);
    const payload = await runScenario(scenario);
    process.stdout.write(`PROBE=${JSON.stringify(payload)}\n`);
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
