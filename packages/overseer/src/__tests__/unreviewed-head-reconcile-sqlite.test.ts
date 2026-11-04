/**
 * WO-HARNESS-OVERSEER-UNREVIEWED-HEAD-RECONCILE-01 -- Test 5, against a REAL
 * SqliteAdapter (the adapter class production uses), not a fake store.
 *
 * Reproduces bdc-harness PR 1462 (2026-11-04): the event store held
 * overseer-reviewer rows only for the OLD head, because the push of the new
 * head landed while the container was being recreated and its webhook was
 * lost. The old-head row is written through the real push path
 * (ingestPullRequestEvent + createRealIngestDeps), then the reconcile clock's
 * startup pass runs against the same database through
 * createRealUnreviewedHeadReconcileDeps. Only the GitHub reads (open-PR
 * listing, mergeability) are stubbed; the dispatch DAL is real.
 */
import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { createHmac } from 'crypto';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { runWithBoundDatabase } from './isolated-database';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

function test(name: string, fn: () => Promise<unknown>, timeout?: number): void {
  bunTest(
    name,
    () => {
      if (!db) throw new Error('reconcile sqlite adapter was not created');
      return runWithBoundDatabase(db, () => Promise.resolve(fn()));
    },
    timeout
  );
}

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const { createRealIngestDeps, REVIEW_RECIPIENT } = await import('../pr-review-wiring.ts');
const { ingestPullRequestEvent } = await import('../pr-review-ingest.ts');
const {
  createRealUnreviewedHeadReconcileDeps,
  startUnreviewedHeadReconcileClock,
  stopUnreviewedHeadReconcileClock,
} = await import('../unreviewed-head-reconcile.ts');

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

function sign(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const PR_NUMBER = 1462;
const OLD_HEAD = '644b3f61'.padEnd(40, '0');
const NEW_HEAD = '8b307224'.padEnd(40, '0');
const CONFIG = {
  webhookSecret: 'reconcile-integration-secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

describe('unreviewed-head reconcile against a real SqliteAdapter', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-unreviewed-head-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    stopUnreviewedHeadReconcileClock();
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('Test 5: restart_replay_real_sqlite', async () => {
    // The real push-path deps, with only the GitHub mergeability read stubbed
    // so no network call is attempted.
    const ingestDeps = {
      ...createRealIngestDeps(CONFIG),
      fetchPullRequestMergeability: async () => ({ mergeableState: 'clean' }),
    };

    // 1. The OLD head was reviewed through the real push path.
    const payload = JSON.stringify({
      action: 'synchronize',
      number: PR_NUMBER,
      pull_request: {
        number: PR_NUMBER,
        draft: false,
        head: { sha: OLD_HEAD, ref: 'fix/overseer-merge-discovery' },
        base: { ref: 'dev', sha: 'd'.repeat(40) },
        user: { login: 'bluedevilcollectibles' },
      },
      repository: { name: REPO, owner: { login: OWNER } },
    });
    const seeded = await ingestPullRequestEvent(
      {
        rawBody: payload,
        signature: sign(payload, CONFIG.webhookSecret),
        eventType: 'pull_request',
        deliveryId: 'reconcile-seed-old-head',
      },
      ingestDeps
    );
    expect(seeded.disposition).toBe('queued');

    // 2. GitHub now reports the PR at the NEW head, whose push was lost.
    const deps = createRealUnreviewedHeadReconcileDeps(CONFIG, {
      ingestDeps,
      listOpenPullRequests: async () => [
        {
          owner: OWNER,
          repo: REPO,
          prNumber: PR_NUMBER,
          title: 'fix(overseer): merge discovery counts only required checks',
          draft: false,
          headSha: NEW_HEAD,
          headRef: 'fix/overseer-merge-discovery',
          baseRef: 'dev',
          baseSha: 'd'.repeat(40),
          author: 'bluedevilcollectibles',
        },
      ],
    });
    const silent = { info: () => {}, warn: () => {} };
    const options = { repos: [{ owner: OWNER, repo: REPO }], dryRun: false, logger: silent };

    const readRows = async () =>
      (
        await db.query<{ idempotency_key: string; repeat_reason: string | null; status: string }>(
          `SELECT idempotency_key, repeat_reason, status FROM agent_dispatch_messages
           WHERE recipient = $1 AND task_type = 'run_review' ORDER BY idempotency_key`,
          [REVIEW_RECIPIENT]
        )
      ).rows;

    const before = await readRows();
    expect(before.map(row => row.idempotency_key)).toEqual([
      `pr-review:${OWNER}/${REPO}#${PR_NUMBER}@${OLD_HEAD}`,
    ]);

    // 3. Startup pass (first boot after the rebuild).
    const first = await startUnreviewedHeadReconcileClock(CONFIG, {
      deps,
      intervalMinutes: 60,
      options,
    });
    stopUnreviewedHeadReconcileClock();
    expect(first?.enqueued).toBe(1);

    const afterFirst = await readRows();
    const newHeadRows = afterFirst.filter(
      row => row.idempotency_key === `pr-review:${OWNER}/${REPO}#${PR_NUMBER}@${NEW_HEAD}`
    );
    expect(newHeadRows).toHaveLength(1);
    expect(newHeadRows[0]?.repeat_reason).toBe(`reconcile:unreviewed_head:${NEW_HEAD}`);
    expect(newHeadRows[0]?.status).toBe('queued');
    expect(afterFirst).toHaveLength(2);

    // 4. A second startup pass (another restart) adds nothing.
    const second = await startUnreviewedHeadReconcileClock(CONFIG, {
      deps,
      intervalMinutes: 60,
      options,
    });
    stopUnreviewedHeadReconcileClock();
    expect(second?.enqueued).toBe(0);
    expect(second?.already_requested).toBe(1);

    const afterSecond = await readRows();
    expect(afterSecond).toHaveLength(2);
    expect(
      afterSecond.filter(
        row => row.idempotency_key === `pr-review:${OWNER}/${REPO}#${PR_NUMBER}@${NEW_HEAD}`
      )
    ).toHaveLength(1);
  });
});
