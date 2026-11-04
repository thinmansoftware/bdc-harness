/**
 * WO-HARNESS-OVERSEER-UNREVIEWED-HEAD-RECONCILE-01 -- unit tests (Tests 1-4,
 * 6, 7). Test 5 (restart replay against a real SqliteAdapter) lives in
 * unreviewed-head-reconcile-sqlite.test.ts.
 *
 * The in-memory queue below models the one property the reconcile relies on:
 * the push path's enqueue is keyed by a UNIQUE idempotency key, so a second
 * enqueue of the same key returns the existing row (alreadyExisted) instead of
 * inserting a duplicate.
 */
import { describe, expect, test } from 'bun:test';
import type { PriorReviewWork } from '../pr-review-ingest.ts';
import {
  UNREVIEWED_HEAD_REASON_PREFIX,
  resolveUnreviewedHeadReconcileDryRun,
  resolveUnreviewedHeadReconcileMinutes,
  runUnreviewedHeadReconcilePass,
  type ReconcileLogger,
  type ReconcileOpenPullRequest,
  type UnreviewedHeadReconcileDeps,
} from '../unreviewed-head-reconcile';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const REPOS = [{ owner: OWNER, repo: REPO }];

interface QueuedRow {
  messageId: string;
  idempotencyKey: string;
  prNumber: number;
  headSha: string;
  status: PriorReviewWork['status'];
  repeatReason: string | null;
}

function sha(char: string): string {
  return char.repeat(40);
}

function pr(prNumber: number, headSha: string, extra: Partial<ReconcileOpenPullRequest> = {}) {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber,
    title: `PR ${prNumber}`,
    draft: false,
    headSha,
    headRef: `feat/pr-${prNumber}`,
    baseRef: 'dev',
    baseSha: sha('0'),
    author: 'bluedevilcollectibles',
    ...extra,
  } satisfies ReconcileOpenPullRequest;
}

function fakeQueue(seed: QueuedRow[] = []) {
  const rows: QueuedRow[] = [...seed];
  const enqueueCalls: Parameters<UnreviewedHeadReconcileDeps['enqueueReviewWork']>[0][] = [];
  return {
    rows,
    enqueueCalls,
    listPriorReviewWork: async (input: { prNumber: number }): Promise<PriorReviewWork[]> =>
      rows
        .filter(row => row.prNumber === input.prNumber)
        .map(row => ({
          messageId: row.messageId,
          headSha: row.headSha,
          status: row.status,
          verdict: null,
          verdictId: null,
          isAutoRereview: false,
          headCiGreen: false,
        })),
    enqueueReviewWork: async (
      input: Parameters<UnreviewedHeadReconcileDeps['enqueueReviewWork']>[0]
    ) => {
      enqueueCalls.push(input);
      const existing = rows.find(row => row.idempotencyKey === input.idempotencyKey);
      if (existing) return { messageId: existing.messageId, alreadyExisted: true };
      const row: QueuedRow = {
        messageId: `msg-${rows.length + 1}`,
        idempotencyKey: input.idempotencyKey,
        prNumber: input.prNumber,
        headSha: input.headSha,
        status: 'queued',
        repeatReason: input.repeatReason,
      };
      rows.push(row);
      return { messageId: row.messageId, alreadyExisted: false };
    },
  };
}

function captureLogger() {
  const lines: { level: 'info' | 'warn'; obj: Record<string, unknown>; msg: string }[] = [];
  const logger: ReconcileLogger = {
    info: (obj, msg) => lines.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => lines.push({ level: 'warn', obj, msg }),
  };
  return { lines, logger };
}

function deps(
  queue: ReturnType<typeof fakeQueue>,
  pulls: ReconcileOpenPullRequest[]
): UnreviewedHeadReconcileDeps {
  return {
    reviewerIdentity: 'thinman-overseer[bot]',
    listOpenPullRequests: async () => pulls,
    listPriorReviewWork: queue.listPriorReviewWork,
    enqueueReviewWork: queue.enqueueReviewWork,
  };
}

describe('unreviewed-head reconcile', () => {
  test('Test 1: missed_head_gets_one_request', async () => {
    const queue = fakeQueue();
    const head = sha('a');
    const { logger, lines } = captureLogger();
    const summary = await runUnreviewedHeadReconcilePass(deps(queue, [pr(1462, head)]), {
      repos: REPOS,
      dryRun: false,
      logger,
    });

    expect(summary.enqueued).toBe(1);
    expect(queue.rows).toHaveLength(1);
    expect(queue.enqueueCalls).toHaveLength(1);
    const call = queue.enqueueCalls[0];
    expect(call?.idempotencyKey).toBe(`pr-review:${OWNER}/${REPO}#1462@${head}`);
    expect(call?.correlationId).toBe(`pr-review:${OWNER}/${REPO}#1462@${head}`);
    expect(call?.repeatReason).toBe(`reconcile:unreviewed_head:${head}`);
    expect(call?.repeatReason?.startsWith(UNREVIEWED_HEAD_REASON_PREFIX)).toBe(true);
    expect(call?.headSha).toBe(head);
    expect(call?.baseRef).toBe('dev');
    expect(call?.author).toBe('bluedevilcollectibles');
    expect(call?.headCiGreen).toBe(false);
    expect(
      lines.filter(line => line.msg === `reconcile_enqueued ${OWNER}/${REPO}#1462@${head}`)
    ).toHaveLength(1);
  });

  test('Test 2: already_requested_head_untouched', async () => {
    const statuses: PriorReviewWork['status'][] = ['queued', 'claimed', 'done', 'cancelled'];
    for (const status of statuses) {
      const head = sha('b');
      const queue = fakeQueue([
        {
          messageId: `existing-${status}`,
          idempotencyKey: `pr-review:${OWNER}/${REPO}#7@${head}`,
          prNumber: 7,
          headSha: head,
          status,
          repeatReason: null,
        },
      ]);
      const { logger } = captureLogger();
      const summary = await runUnreviewedHeadReconcilePass(deps(queue, [pr(7, head)]), {
        repos: REPOS,
        dryRun: false,
        logger,
      });
      expect(queue.enqueueCalls).toHaveLength(0);
      expect(queue.rows).toHaveLength(1);
      expect(summary.already_requested).toBe(1);
      expect(summary.enqueued).toBe(0);
    }
  });

  test('Test 3: only_drafts_skipped', async () => {
    const queue = fakeQueue();
    const { logger } = captureLogger();
    const draft = pr(10, sha('c'), { draft: true });
    const fallback = pr(11, sha('d'), {
      title: 'FALLBACK: opus-repaired build needs human review',
    });
    const salvage = pr(12, sha('e'), { headRef: 'salvage/wo-thing-01' });
    const summary = await runUnreviewedHeadReconcilePass(deps(queue, [draft, fallback, salvage]), {
      repos: REPOS,
      dryRun: false,
      logger,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.enqueued).toBe(2);
    const enqueuedNumbers = queue.enqueueCalls.map(call => call.prNumber).sort();
    expect(enqueuedNumbers).toEqual([11, 12]);
    expect(queue.enqueueCalls.filter(call => call.prNumber === 11)).toHaveLength(1);
    expect(queue.enqueueCalls.filter(call => call.prNumber === 12)).toHaveLength(1);
    expect(queue.enqueueCalls.some(call => call.prNumber === 10)).toBe(false);
  });

  test('Test 4: second_pass_is_idempotent', async () => {
    const queue = fakeQueue();
    const head = sha('a');
    const { logger } = captureLogger();
    const pulls = [pr(1462, head)];
    const first = await runUnreviewedHeadReconcilePass(deps(queue, pulls), {
      repos: REPOS,
      dryRun: false,
      logger,
    });
    expect(first.enqueued).toBe(1);
    const second = await runUnreviewedHeadReconcilePass(deps(queue, pulls), {
      repos: REPOS,
      dryRun: false,
      logger,
    });
    expect(second.enqueued).toBe(0);
    expect(second.already_requested).toBe(1);
    expect(queue.rows).toHaveLength(1);
    expect(queue.enqueueCalls).toHaveLength(1);
  });

  test('Test 6: pass_summary_logged', async () => {
    const reviewedHead = sha('f');
    const queue = fakeQueue([
      {
        messageId: 'existing-reviewed',
        idempotencyKey: `pr-review:${OWNER}/${REPO}#21@${reviewedHead}`,
        prNumber: 21,
        headSha: reviewedHead,
        status: 'done',
        repeatReason: null,
      },
    ]);
    const { logger, lines } = captureLogger();
    await runUnreviewedHeadReconcilePass(
      deps(queue, [pr(20, sha('1')), pr(21, reviewedHead), pr(22, sha('2'), { draft: true })]),
      { repos: REPOS, dryRun: false, logger }
    );

    const summaries = lines.filter(line => line.msg.startsWith('reconcile_unreviewed_head_pass '));
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary?.msg).toContain('scanned=3');
    expect(summary?.msg).toContain('enqueued=1');
    expect(summary?.msg).toContain('skipped=1');
    expect(summary?.msg).toContain('already_requested=1');
    expect(summary?.obj.scanned).toBe(3);
    expect(summary?.obj.enqueued).toBe(1);
    expect(summary?.obj.skipped).toBe(1);
    expect(summary?.obj.already_requested).toBe(1);
  });

  test('Test 7: dry_run_lists_without_enqueuing', async () => {
    const queue = fakeQueue();
    const { logger, lines } = captureLogger();
    const headA = sha('7');
    const headB = sha('8');
    const summary = await runUnreviewedHeadReconcilePass(
      deps(queue, [pr(30, headA), pr(31, headB)]),
      { repos: REPOS, dryRun: true, logger }
    );

    expect(queue.enqueueCalls).toHaveLength(0);
    expect(queue.rows).toHaveLength(0);
    expect(summary.enqueued).toBe(0);
    expect(summary.would_enqueue).toBe(2);
    const wouldLines = lines
      .filter(line => line.msg.startsWith('reconcile_would_enqueue '))
      .map(line => line.msg)
      .sort();
    expect(wouldLines).toEqual([
      `reconcile_would_enqueue ${OWNER}/${REPO}#30@${headA}`,
      `reconcile_would_enqueue ${OWNER}/${REPO}#31@${headB}`,
    ]);
  });

  test('intake parity: custody conflict, dirty base and an exhausted judge ladder do not enqueue', async () => {
    const queue = fakeQueue();
    const { logger } = captureLogger();
    const own = pr(40, sha('9'), { author: 'thinman-overseer[bot]' });
    const dirty = pr(41, sha('3'));
    const summary = await runUnreviewedHeadReconcilePass(
      {
        ...deps(queue, [own, dirty]),
        fetchPullRequestMergeability: async () => ({ mergeableState: 'dirty' }),
      },
      { repos: REPOS, dryRun: false, logger }
    );
    expect(summary.custody_conflict).toBe(1);
    expect(summary.dirty).toBe(1);
    expect(queue.enqueueCalls).toHaveLength(0);

    const exhausted = await runUnreviewedHeadReconcilePass(
      {
        ...deps(queue, [pr(42, sha('4'))]),
        judgeLadderBreaker: {
          check: () => ({ until: '2026-11-04T05:00:00.000Z', rungs: [] }),
          park: () => {},
          notify: async () => false,
        } as unknown as UnreviewedHeadReconcileDeps['judgeLadderBreaker'],
      },
      { repos: REPOS, dryRun: false, logger }
    );
    expect(exhausted.breaker_deferred).toBe(1);
    expect(queue.enqueueCalls).toHaveLength(0);
  });

  test('a failing repo listing is logged and the other repos still run', async () => {
    const queue = fakeQueue();
    const { logger, lines } = captureLogger();
    const summary = await runUnreviewedHeadReconcilePass(
      {
        ...deps(queue, []),
        listOpenPullRequests: async ({ repo }) => {
          if (repo === 'shopops') throw new Error('boom');
          return [pr(50, sha('5'))];
        },
      },
      {
        repos: [
          { owner: OWNER, repo: 'shopops' },
          { owner: OWNER, repo: REPO },
        ],
        dryRun: false,
        logger,
      }
    );
    expect(summary.failedRepos).toEqual([`${OWNER}/shopops`]);
    expect(summary.enqueued).toBe(1);
    expect(lines.some(line => line.msg === 'reconcile_unreviewed_head_listing_failed')).toBe(true);
  });

  test('env flags: interval defaults to 15 and dry run reads 1/true/yes', () => {
    expect(resolveUnreviewedHeadReconcileMinutes(undefined)).toBe(15);
    expect(resolveUnreviewedHeadReconcileMinutes('5')).toBe(5);
    expect(resolveUnreviewedHeadReconcileMinutes('0')).toBe(15);
    expect(resolveUnreviewedHeadReconcileMinutes('abc')).toBe(15);
    expect(resolveUnreviewedHeadReconcileDryRun('1')).toBe(true);
    expect(resolveUnreviewedHeadReconcileDryRun('true')).toBe(true);
    expect(resolveUnreviewedHeadReconcileDryRun(undefined)).toBe(false);
    expect(resolveUnreviewedHeadReconcileDryRun('0')).toBe(false);
  });
});
