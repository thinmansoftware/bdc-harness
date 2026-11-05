/**
 * WO-HARNESS-OVERSEER-UNREVIEWED-HEAD-RECONCILE-01 -- unit tests (Tests 1-4,
 * 6-10; Tests 8-10 are the 48h window and per-pass cap of amendment 2). Test 5 (restart replay against a real SqliteAdapter) lives in
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
  resolveUnreviewedHeadReconcileMaxPerPass,
  resolveUnreviewedHeadReconcileMinutes,
  resolveUnreviewedHeadReconcileWindowHours,
  runUnreviewedHeadReconcilePass,
  type ReconcileLogger,
  type ReconcileOpenPullRequest,
  type UnreviewedHeadReconcileDeps,
} from '../unreviewed-head-reconcile';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const REPOS = [{ owner: OWNER, repo: REPO }];
// Fixed clock: every fixture's updated_at is measured against this instant.
const NOW_MS = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR_MS = 3_600_000;

function hoursAgo(hours: number): string {
  return new Date(NOW_MS - hours * HOUR_MS).toISOString();
}

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
    updatedAt: hoursAgo(1),
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
      now: () => NOW_MS,
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
      now: () => NOW_MS,
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
      now: () => NOW_MS,
    });
    expect(first.enqueued).toBe(1);
    const second = await runUnreviewedHeadReconcilePass(deps(queue, pulls), {
      repos: REPOS,
      dryRun: false,
      logger,
      now: () => NOW_MS,
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
      { repos: REPOS, dryRun: false, logger, now: () => NOW_MS }
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
      { repos: REPOS, dryRun: true, logger, now: () => NOW_MS }
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

  test('Test 8: stale_pr_outside_window_skipped', async () => {
    const queue = fakeQueue();
    const { logger, lines } = captureLogger();
    // 72h old against the default 48h window, unreviewed at its head.
    const stale = pr(244, sha('6'), { updatedAt: hoursAgo(72) });
    // No readable updated_at is treated as outside the window, never as eligible.
    const unknown = pr(245, sha('5'), { updatedAt: 'not-a-date' });
    const summary = await runUnreviewedHeadReconcilePass(deps(queue, [stale, unknown]), {
      repos: REPOS,
      dryRun: false,
      logger,
      now: () => NOW_MS,
    });

    expect(summary.windowHours).toBe(48);
    expect(queue.enqueueCalls).toHaveLength(0);
    expect(queue.rows).toHaveLength(0);
    expect(summary.outside_window).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.enqueued).toBe(0);
    const passLine = lines.find(line => line.msg.startsWith('reconcile_unreviewed_head_pass '));
    expect(passLine?.msg).toContain('outside_window=2');
    expect(passLine?.msg).toContain('skipped=0');
    expect(passLine?.obj.outside_window).toBe(2);

    // A smaller window, set explicitly, moves the line: 3h-old is outside 2h.
    const narrow = await runUnreviewedHeadReconcilePass(
      deps(fakeQueue(), [pr(246, sha('4'), { updatedAt: hoursAgo(3) })]),
      { repos: REPOS, dryRun: false, logger, now: () => NOW_MS, windowHours: 2 }
    );
    expect(narrow.outside_window).toBe(1);
    expect(narrow.enqueued).toBe(0);
  });

  test('Test 9: per_pass_cap_enforced', async () => {
    // 12 eligible unreviewed PRs, PR 100+i updated i hours ago (all inside 48h),
    // listed oldest-first and split across two repos so the cap must sort.
    const pulls = Array.from({ length: 12 }, (_, i) =>
      pr(100 + i, sha(i.toString(16)), { updatedAt: hoursAgo(i + 1) })
    ).reverse();
    const shopops = pulls.slice(0, 6).map(p => ({ ...p, repo: 'shopops' }));
    const harness = pulls.slice(6);
    const listing = async ({ repo }: { repo: string }) => (repo === 'shopops' ? shopops : harness);
    const repos = [
      { owner: OWNER, repo: 'shopops' },
      { owner: OWNER, repo: REPO },
    ];

    const live = fakeQueue();
    const { logger, lines } = captureLogger();
    const summary = await runUnreviewedHeadReconcilePass(
      { ...deps(live, []), listOpenPullRequests: listing },
      { repos, dryRun: false, logger, now: () => NOW_MS }
    );
    expect(summary.maxPerPass).toBe(10);
    expect(summary.enqueued).toBe(10);
    expect(summary.capped).toBe(2);
    expect(live.rows).toHaveLength(10);
    // The 10 most recently updated: PRs 100..109. The two oldest (110, 111) wait.
    expect(live.enqueueCalls.map(call => call.prNumber)).toEqual([
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
    ]);
    const passLine = lines.find(line => line.msg.startsWith('reconcile_unreviewed_head_pass '));
    expect(passLine?.msg).toContain('capped=2');
    expect(passLine?.msg).toContain('enqueued=10');

    // The next pass picks up the two that were capped, and nothing else.
    const next = await runUnreviewedHeadReconcilePass(
      { ...deps(live, []), listOpenPullRequests: listing },
      { repos, dryRun: false, logger, now: () => NOW_MS }
    );
    expect(next.enqueued).toBe(2);
    expect(next.capped).toBe(0);
    expect(next.already_requested).toBe(10);
    expect(live.rows).toHaveLength(12);

    // Dry-run on a fresh queue: the cap applies to would_enqueue the same way.
    const dry = fakeQueue();
    const dryLog = captureLogger();
    const drySummary = await runUnreviewedHeadReconcilePass(
      { ...deps(dry, []), listOpenPullRequests: listing },
      { repos, dryRun: true, logger: dryLog.logger, now: () => NOW_MS }
    );
    expect(drySummary.would_enqueue).toBe(10);
    expect(drySummary.capped).toBe(2);
    expect(drySummary.enqueued).toBe(0);
    expect(dry.enqueueCalls).toHaveLength(0);
    expect(
      dryLog.lines.filter(line => line.msg.startsWith('reconcile_would_enqueue '))
    ).toHaveLength(10);

    // An explicit cap overrides the default.
    const small = await runUnreviewedHeadReconcilePass(
      { ...deps(fakeQueue(), []), listOpenPullRequests: listing },
      { repos, dryRun: false, logger, now: () => NOW_MS, maxPerPass: 3 }
    );
    expect(small.enqueued).toBe(3);
    expect(small.capped).toBe(9);
  });

  test('Test 10: updated_at_inside_window_counts', async () => {
    // The listing carries no head commit date, so updated_at alone decides: a PR
    // whose head commit is old but which was updated 47h ago is eligible.
    const queue = fakeQueue();
    const { logger } = captureLogger();
    const head = sha('c');
    const summary = await runUnreviewedHeadReconcilePass(
      deps(queue, [pr(374, head, { updatedAt: hoursAgo(47) })]),
      { repos: REPOS, dryRun: false, logger, now: () => NOW_MS }
    );
    expect(summary.outside_window).toBe(0);
    expect(summary.enqueued).toBe(1);
    expect(queue.enqueueCalls).toHaveLength(1);
    expect(queue.enqueueCalls[0]?.idempotencyKey).toBe(`pr-review:${OWNER}/${REPO}#374@${head}`);
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
      { repos: REPOS, dryRun: false, logger, now: () => NOW_MS }
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
      { repos: REPOS, dryRun: false, logger, now: () => NOW_MS }
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
        now: () => NOW_MS,
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

  test('env flags: window defaults to 48h and cap to 10; invalid values warn and fall back', () => {
    const { logger, lines } = captureLogger();
    expect(resolveUnreviewedHeadReconcileWindowHours(undefined, logger)).toBe(48);
    expect(resolveUnreviewedHeadReconcileWindowHours('', logger)).toBe(48);
    expect(resolveUnreviewedHeadReconcileWindowHours('24', logger)).toBe(24);
    expect(resolveUnreviewedHeadReconcileMaxPerPass(undefined, logger)).toBe(10);
    expect(resolveUnreviewedHeadReconcileMaxPerPass('25', logger)).toBe(25);
    expect(lines).toHaveLength(0);

    expect(resolveUnreviewedHeadReconcileWindowHours('0', logger)).toBe(48);
    expect(resolveUnreviewedHeadReconcileWindowHours('abc', logger)).toBe(48);
    expect(resolveUnreviewedHeadReconcileMaxPerPass('-3', logger)).toBe(10);
    expect(resolveUnreviewedHeadReconcileMaxPerPass('2.5', logger)).toBe(10);
    const warns = lines.filter(
      line => line.level === 'warn' && line.msg === 'reconcile_unreviewed_head_invalid_env'
    );
    expect(warns).toHaveLength(4);
    expect(warns.map(line => line.obj.env)).toEqual([
      'OVERSEER_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS',
      'OVERSEER_UNREVIEWED_HEAD_RECONCILE_WINDOW_HOURS',
      'OVERSEER_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS',
      'OVERSEER_UNREVIEWED_HEAD_RECONCILE_MAX_PER_PASS',
    ]);
    expect(warns[0]?.obj.fallback).toBe(48);
    expect(warns[2]?.obj.fallback).toBe(10);
  });
});
