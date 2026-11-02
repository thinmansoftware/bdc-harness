import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage, SeqCursorMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import { runAndSubmitReview } from '@archon/overseer/pr-review-submit';
import type { createRealOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import {
  createGitHubReviewCheckoutPrLookup,
  createReviewCheckoutEvictor,
  DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES,
  DEFAULT_REVIEW_SPARSE_EXCLUDES,
  derivePrStateFromAssociatedPulls,
  evictReviewCheckouts,
  resolveReviewCheckoutCacheMaxBytes,
  resolveSparseExcludes,
  startReviewWorkerClock,
  stopReviewWorkerClock,
  tickReviewWorkerClock,
  type ReviewCheckoutCacheLogger,
  type ReviewCheckoutPrState,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

function message(id: string, headSha = `head-${id}`): DispatchMessage {
  return {
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `review-${id}`,
    task_type: 'run_review',
    sender: 'overseer',
    recipient: 'overseer-reviewer',
    body: JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 730,
      headSha,
      baseRef: 'dev',
      author: 'contributor',
    }),
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: 'gh:thinmansoftware/bdc-harness#730',
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

function fakeDeps(
  queued: DispatchMessage[],
  outcomeFor: (id: string) => SubmitOutcome = () => ({ disposition: 'approved' })
): ReviewWorkerDeps {
  const terminal = new Set<string>();
  return {
    registerWorker: mock(async data => ({
      ...data,
      status: 'available' as const,
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    heartbeatWorker: mock(async data => ({
      worker_id: data.worker_id,
      host: 'test',
      capabilities: {},
      max_concurrency: 1,
      status: data.status ?? 'available',
      registered_at: new Date(0).toISOString(),
      last_heartbeat_at: new Date(0).toISOString(),
    })),
    listMessages: mock(async () => queued),
    claimMessage: mock(async ({ id, worker_id }) => {
      if (terminal.has(id)) return null;
      const found = queued.find(item => item.id === id);
      return found
        ? { ...found, status: 'claimed' as const, lease_owner: worker_id, fencing_token: 1 }
        : null;
    }),
    postResult: mock(async input => {
      terminal.add(input.id);
      const found = queued.find(item => item.id === input.id);
      return found
        ? {
            ...found,
            status: input.status ?? 'done',
            result_body: input.result_body,
            task_outcome: input.task_outcome ?? null,
          }
        : null;
    }),
    releaseMessage: mock(async () => null),
    // WO-HARNESS-OVERSEER-REVIEW-CHECK-DEFERRAL-01 Section 7: the worker now
    // calls the deferral by its WO name. It delegates to releaseMessage, so the
    // fencing guards asserted below are unchanged.
    deferMessage: mock(async () => null),
    runAndSubmitReview: mock(async work => outcomeFor(work.messageId)),
    createSubmitDeps: mock(() => ({ reviewerIdentity: CONFIG.reviewerIdentity }) as SubmitDeps),
  };
}

afterEach(() => stopReviewWorkerClock());

describe('review worker clock', () => {
  test('submits the queued exact head once and marks the item done', async () => {
    const queued = [message('one', 'exact-head')];
    const deps = fakeDeps(queued);

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'exact-head', messageId: 'one' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'one',
        fencing_token: 1,
        status: 'done',
        task_outcome: 'succeeded',
      })
    );
  });

  test('records a stale-head outcome as terminal without retrying submission', async () => {
    const deps = fakeDeps([message('stale', 'old-head')], () => ({
      disposition: 'stale_head',
      reason: 'head_advanced_during_review',
    }));

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done', task_outcome: 'succeeded' })
    );
  });

  test.each([
    ['changes_requested', 'done', 'succeeded'],
    ['custody_conflict', 'failed', 'blocked'],
    ['merge_custody_conflict', 'failed', 'blocked'],
    ['reviewer_failed', 'failed', 'failed'],
    ['submission_failed', 'failed', 'failed'],
    // #775: the required status-check contexts could not be read after the
    // attempt bound. TERMINAL and blocked -- it must be POSTED, not released,
    // or the item goes back into the forever-defer loop it was blocked to end.
    ['blocked_required_contexts_unavailable', 'failed', 'blocked'],
  ] as const)(
    'maps %s submissions to %s with a %s task outcome',
    async (disposition, status, taskOutcome) => {
      const deps = fakeDeps([message(disposition)], () => ({ disposition }));

      await tickReviewWorkerClock(CONFIG, deps);

      expect(deps.postResult).toHaveBeenCalledWith(
        expect.objectContaining({
          id: disposition,
          status,
          task_outcome: taskOutcome,
        })
      );
    }
  );

  // #777 review finding (second pass): a superseded-head item is bound to a SHA
  // that is no longer live, and nothing rewrites that payload. Releasing it back
  // to the queue made every later tick re-evaluate the same dead SHA and return
  // superseded_head again -- an indefinite retry loop. It must TERMINATE; ingest
  // separately enqueues a fresh item bound to the exact new head.
  test('terminates a superseded-head item instead of releasing it back to the queue', async () => {
    const deps = fakeDeps([message('superseded', 'exact-head')], () => ({
      disposition: 'superseded_head',
      reason: 'head_advanced_before_required_contexts_block',
    }));

    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'superseded',
        fencing_token: 1,
        status: 'done',
        task_outcome: 'succeeded',
      })
    );
    // Releasing an item whose bound head is dead is what created the loop.
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  // The loop the finding names is only visible across TWO ticks: the first tick
  // disposes of the item, the second must not evaluate it again.
  test('does not re-evaluate a superseded-head item on the next tick', async () => {
    const deps = fakeDeps([message('superseded', 'exact-head')], () => ({
      disposition: 'superseded_head',
      reason: 'head_advanced_before_required_contexts_block',
    }));

    await tickReviewWorkerClock(CONFIG, deps);
    await tickReviewWorkerClock(CONFIG, deps);

    // One evaluation total: the stale SHA is never judged twice.
    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: 'exact-head', messageId: 'superseded' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledTimes(1);
    expect(deps.releaseMessage).not.toHaveBeenCalled();
  });

  // WO-HARNESS-OVERSEER-REVIEW-WAITS-FOR-CHECKS-01: a checks-pending item is
  // released (not posted as a result) with a future not_before, and is retried
  // until it reaches a terminal disposition.
  test('defers (never posts) a checks-pending item with a future not_before', async () => {
    const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
    const deps = fakeDeps([message('pending', 'exact-head')], () => ({
      disposition: 'checks_pending',
      reason: 'checks_not_terminal',
      pendingChecks: ['test (windows-latest)'],
    }));
    deps.logger = { warn: (data, logMessage) => warnings.push({ data, message: logMessage }) };

    const before = Date.now();
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      fencing_token: number;
      defer_until: string;
    };
    expect(deferArg.id).toBe('pending');
    expect(deferArg.fencing_token).toBe(1);
    expect(new Date(deferArg.defer_until).getTime()).toBeGreaterThan(before);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: 'overseer_review_checks_pending_deferred',
        data: expect.objectContaining({
          messageId: 'pending',
          defer_until: deferArg.defer_until,
          pending_checks: ['test (windows-latest)'],
        }),
      }),
    ]);
    // A defer is not a terminal result.
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  test('logs no_checks_reported when a checks-pending outcome has no names', async () => {
    const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
    const deps = fakeDeps([message('no-checks')], () => ({
      disposition: 'checks_pending',
    }));
    deps.logger = { warn: (data, logMessage) => warnings.push({ data, message: logMessage }) };
    await tickReviewWorkerClock(CONFIG, deps);
    expect(warnings[0]).toEqual({
      message: 'overseer_review_checks_pending_deferred',
      data: expect.objectContaining({ pending_checks: [], reason: 'no_checks_reported' }),
    });
  });

  test('does not call an explicit empty pending list no_checks_reported', async () => {
    const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
    const deps = fakeDeps([message('unknown-contexts')], () => ({
      disposition: 'checks_pending',
      pendingChecks: [],
    }));
    deps.logger = { warn: (data, logMessage) => warnings.push({ data, message: logMessage }) };
    await tickReviewWorkerClock(CONFIG, deps);
    expect(warnings[0]?.data).toEqual(expect.objectContaining({ pending_checks: [] }));
    expect(warnings[0]?.data).not.toHaveProperty('reason');
  });

  // bdc-harness #782 part 2: a rate limit is a deferral with GitHub's own reset
  // clock, never a terminal verdict.
  test('defers a rate-limited item until the reported retry instant', async () => {
    const retryAfter = new Date(Date.now() + 900_000).toISOString();
    const deps = fakeDeps([message('limited', 'exact-head')], () => ({
      disposition: 'rate_limited',
      reason: 'github_rate_limited',
      retryAfter,
      retryAfterMs: 900_000,
    }));

    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      defer_until: string;
    };
    expect(deferArg.id).toBe('limited');
    // The reset instant is used verbatim: retrying earlier would just burn
    // another request against a budget that is still exhausted (#774).
    expect(deferArg.defer_until).toBe(retryAfter);
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  test('a rate-limited item with no reported clock still gets a finite backoff', async () => {
    const deps = fakeDeps([message('noclock', 'exact-head')], () => ({
      disposition: 'rate_limited',
      reason: 'github_rate_limited',
    }));

    const before = Date.now();
    await tickReviewWorkerClock(CONFIG, deps);

    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      defer_until: string;
    };
    expect(new Date(deferArg.defer_until).getTime()).toBeGreaterThan(before);
    expect(deps.postResult).not.toHaveBeenCalled();
  });

  // WO-HARNESS-OVERSEER-REVIEW-TRIGGER-01: end to end through the REAL submit
  // path. Live 2026-11-01 17:07Z, bdc-harness #1390's first review was retired
  // `failed` because the head re-read hit the local pool gate; nothing re-armed
  // it for 80 minutes. The item must instead go back to the queue until the
  // gate opens, with no terminal result posted.
  test('a pool-gate refusal on the head re-read re-queues the item until the gate opens', async () => {
    const gateUntil = Date.now() + 120_000;
    let submitted = 0;
    const deps = fakeDeps([message('gated', 'exact-head')]);
    deps.runAndSubmitReview = runAndSubmitReview;
    deps.createSubmitDeps = () => ({
      reviewerIdentity: CONFIG.reviewerIdentity,
      runReviewer: async () => ({
        approved: true,
        summary: 'No blocking findings.',
        reviewedHeadSha: 'exact-head',
      }),
      submitReview: async () => {
        submitted += 1;
        return { submitted: true };
      },
      currentHeadSha: async () => {
        throw new Error(`github_pool_backoff:app-4574893-153295654/core:${gateUntil}`);
      },
      recordReceipt: async () => undefined,
    });

    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.postResult).not.toHaveBeenCalled();
    expect(submitted).toBe(0);
    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    const deferArg = (deps.deferMessage as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      id: string;
      fencing_token: number;
      defer_until: string;
    };
    expect(deferArg.id).toBe('gated');
    expect(deferArg.fencing_token).toBe(1);
    const deferMs = new Date(deferArg.defer_until).getTime();
    // The gate's own expiry, give or take the milliseconds the tick took.
    expect(Math.abs(deferMs - gateUntil)).toBeLessThan(5_000);
  });

  test('a non-rate-limit head re-read failure is still posted terminal', async () => {
    const deps = fakeDeps([message('broken', 'exact-head')]);
    deps.runAndSubmitReview = runAndSubmitReview;
    deps.createSubmitDeps = () => ({
      reviewerIdentity: CONFIG.reviewerIdentity,
      runReviewer: async () => ({
        approved: true,
        summary: 'No blocking findings.',
        reviewedHeadSha: 'exact-head',
      }),
      submitReview: async () => ({ submitted: true }),
      currentHeadSha: async () => {
        throw new Error('github_500');
      },
      recordReceipt: async () => undefined,
    });

    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.deferMessage).not.toHaveBeenCalled();
    expect(deps.postResult).toHaveBeenCalledTimes(1);
    const posted = (deps.postResult as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      status: string;
      task_outcome: string;
      result_body: string;
    };
    expect(posted.status).toBe('failed');
    expect(posted.task_outcome).toBe('failed');
    expect(JSON.parse(posted.result_body).reason).toBe('head_recheck_failed:github_500');
  });

  // bdc-harness #782 part 3: the sweep runs on the heartbeat and never takes
  // the primary review path down with it.
  test('runs the stale-verdict sweep once per tick after the queue is drained', async () => {
    const deps = fakeDeps([message('one', 'exact-head')]);
    const sweep = mock(async () => ({ examined: 1, enqueued: 1, duplicates: 0 }));
    deps.staleVerdictSweep = sweep;

    await tickReviewWorkerClock(CONFIG, deps);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledWith(CONFIG);
    // The queued item was still handled.
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));
  });

  test('a sweep failure never fails the tick or the primary review path', async () => {
    const deps = fakeDeps([message('one', 'exact-head')]);
    deps.staleVerdictSweep = mock(async () => {
      throw new Error('github_unavailable');
    });

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));
  });

  test('retries a released item on a later tick until it reaches a terminal disposition', async () => {
    let disposition: SubmitOutcome['disposition'] = 'checks_pending';
    const deps = fakeDeps(
      [message('retry', 'exact-head')],
      () => ({ disposition }) as SubmitOutcome
    );

    // Tick 1: checks still pending -> defer, no result.
    await tickReviewWorkerClock(CONFIG, deps);
    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    expect(deps.postResult).not.toHaveBeenCalled();

    // Checks conclude; tick 2 picks up the same message and completes it.
    disposition = 'approved';
    await tickReviewWorkerClock(CONFIG, deps);

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(2);
    expect(deps.deferMessage).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'retry', status: 'done', task_outcome: 'succeeded' })
    );
  });

  test('isolates a failed item and continues through the batch', async () => {
    const deps = fakeDeps([message('bad'), message('good')]);
    const originalClaim = deps.claimMessage;
    deps.claimMessage = mock(async input => {
      if (input.id === 'bad') throw new Error('claim failed');
      return originalClaim(input);
    }) as typeof deps.claimMessage;

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'good' }));
  });

  test('terminates an invalid review body as blocked and continues the batch', async () => {
    const invalid = { ...message('invalid'), body: JSON.stringify({ owner: 'thinmansoftware' }) };
    const deps = fakeDeps([invalid, message('valid')]);

    await expect(tickReviewWorkerClock(CONFIG, deps)).resolves.toBeUndefined();

    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(deps.runAndSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'valid' }),
      expect.anything()
    );
    expect(deps.postResult).toHaveBeenCalledTimes(2);
    expect(deps.postResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'valid' }));
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'invalid',
        fencing_token: 1,
        status: 'failed',
        task_outcome: 'blocked',
        result_body: JSON.stringify({ reason: 'invalid_review_work_body' }),
      })
    );
    expect(deps.createSubmitDeps).toHaveBeenCalledTimes(1);
  });

  test('does not start when review route configuration is absent', async () => {
    const deps = fakeDeps([message('never')]);
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'production';
    try {
      startReviewWorkerClock(null, deps);
      startReviewWorkerClock(undefined, deps);
      await Bun.sleep(5);

      expect(deps.registerWorker).not.toHaveBeenCalled();

      startReviewWorkerClock(CONFIG, deps);
      await Bun.sleep(5);
      expect(deps.registerWorker).toHaveBeenCalledTimes(1);
    } finally {
      stopReviewWorkerClock();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});

describe('invalid review work against isolated real SQLite', () => {
  for (const conflict of [false, true]) {
    test(`preserves validation and fencing (conflict=${conflict})`, () => {
      const home = mkdtempSync(join(tmpdir(), 'review-invalid-'));
      const url = (path: string) =>
        JSON.stringify(pathToFileURL(resolve(import.meta.dir, path)).href);
      const script = `
        const dispatch = await import(${url('../../../core/src/db/dispatch.ts')});
        const { getDatabase, closeDatabase } = await import(${url('../../../core/src/db/connection.ts')});
        const { tickReviewWorkerClock } = await import(${url('./review-worker-clock.ts')});
        const health = await import(${url('../../../overseer/src/judge-ladder-health.ts')});
        try {
          const db = getDatabase();
          if (db.dialect !== 'sqlite') throw new Error('isolated_sqlite_required');
          const create = (key, body, repeat_reason = null) => dispatch.createAuthenticatedMessage(
            { kind: 'system', sender: 'overseer' },
            { correlation_id: key, idempotency_key: key, task_type: 'run_review', recipient: 'overseer-reviewer', body: JSON.stringify(body), repeat_reason }
          );
          const bad = await create('invalid', { owner: 'thinmansoftware' }, 'operator_request:ladder_restored');
          const good = await create('valid', { owner: 'thinmansoftware', repo: 'bdc-harness', prNumber: 730, headSha: 'a'.repeat(40), baseRef: 'dev', author: 'fixture' });
          health.recordJudgeRungOutage('fixture-judge', { kind: 'usage_limit', code: 'usage_limit' });
          let reviews = 0, constructions = 0, nullResults = 0;
          const deps = {
            registerWorker: dispatch.registerWorker, heartbeatWorker: dispatch.heartbeatWorker,
            listMessages: dispatch.listMessages, claimMessage: dispatch.claimMessage,
            releaseMessage: dispatch.releaseMessage, deferMessage: dispatch.deferMessage,
            postResult: async input => {
              if (${conflict} && input.id === bad.id) {
                await db.query('UPDATE agent_dispatch_messages SET fencing_token = fencing_token + 1 WHERE id = $1', [bad.id]);
              }
              const result = await dispatch.postResult(input);
              if (result === null) nullResults++;
              return result;
            },
            runAndSubmitReview: async () => { reviews++; return { disposition: 'approved' }; },
            createSubmitDeps: () => { constructions++; return { reviewerIdentity: 'fixture-reviewer' }; },
          };
          await tickReviewWorkerClock({ webhookSecret: 'fixture', reviewerIdentity: 'fixture-reviewer' }, deps);
          const invalid = await dispatch.getMessage(bad.id);
          const valid = await dispatch.getMessage(good.id);
          console.log('PROBE=' + JSON.stringify({ invalidStatus: invalid.status, invalidOutcome: invalid.task_outcome, invalidResult: invalid.result_body, validStatus: valid.status, reviews, constructions, nullResults, outages: health.snapshotJudgeLadderHealth().outages.length }));
        } finally { await closeDatabase(); }
      `;
      try {
        writeFileSync(join(home, 'probe.ts'), script);
        const env: NodeJS.ProcessEnv = { ...process.env, ARCHON_HOME: home };
        delete env.DATABASE_URL;
        const proc = Bun.spawnSync([process.execPath, 'run', join(home, 'probe.ts')], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 45_000,
        });
        if (proc.exitCode !== 0)
          throw new Error(
            `SQLite probe exited ${proc.exitCode}: ${proc.stderr.toString()} ${proc.stdout.toString()}`
          );
        expect(proc.exitCode).toBe(0);
        const line = proc.stdout
          .toString()
          .split('\n')
          .find(line => line.startsWith('PROBE='));
        if (!line) throw new Error(`missing probe output: ${proc.stderr.toString()}`);
        const result = JSON.parse(line.slice(6));
        expect(result.validStatus).toBe('done');
        expect(result.reviews).toBe(1);
        expect(result.constructions).toBe(1);
        expect(result.outages).toBe(1);
        expect(result.invalidStatus).toBe(conflict ? 'claimed' : 'failed');
        expect(result.invalidOutcome).toBe(conflict ? null : 'blocked');
        expect(result.invalidResult).toBe(
          conflict ? null : JSON.stringify({ reason: 'invalid_review_work_body' })
        );
        expect(result.nullResults).toBe(conflict ? 1 : 0);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01: review checkout cache eviction.
// Pure filesystem + injected GitHub/claims: these run on every platform.
// ---------------------------------------------------------------------------

interface LogEntry {
  level: 'info' | 'warn';
  message: string;
  data: Record<string, unknown>;
}

function captureLogger(): { logger: ReviewCheckoutCacheLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (data, message): void => {
        entries.push({ level: 'info', message, data });
      },
      warn: (data, message): void => {
        entries.push({ level: 'warn', message, data });
      },
    },
  };
}

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

/** A cached checkout dir holding `bytes` of content, last used at `usedAt` seconds. */
async function cachedCheckout(
  root: string,
  owner: string,
  repo: string,
  head: string,
  bytes: number,
  usedAt: number,
  prNumber?: number
): Promise<string> {
  const path = join(root, owner, repo, head);
  await mkdir(join(path, 'docs'), { recursive: true });
  await writeFile(join(path, 'docs', 'payload.bin'), 'x'.repeat(bytes));
  await utimes(path, usedAt, usedAt);
  if (prNumber !== undefined) await writeFile(`${path}.pr`, `${prNumber}\n`);
  return path;
}

function evictedMessages(entries: LogEntry[]): Record<string, unknown>[] {
  return entries.filter(e => e.message === 'overseer_review_checkout_evicted').map(e => e.data);
}

describe('review checkout cache eviction (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01)', () => {
  let spool = '';
  let root = '';
  beforeEach(async () => {
    spool = await mkdtemp(join(tmpdir(), 'review-cache-'));
    root = join(spool, 'checkouts');
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(spool, { recursive: true, force: true });
  });

  test('evict-merged: merged and closed are evicted, open and lookup-failure are kept', async () => {
    const merged = await cachedCheckout(root, 'o', 'r', sha(1), 100, 1_000, 11);
    const closed = await cachedCheckout(root, 'o', 'r', sha(2), 50, 1_001);
    const open = await cachedCheckout(root, 'o', 'r', sha(3), 10, 1_002);
    const failing = await cachedCheckout(root, 'o', 'r', sha(4), 10, 1_003);
    const seen: { headSha: string; prNumber?: number }[] = [];
    const { logger, entries } = captureLogger();
    const result = await evictReviewCheckouts({
      checkoutRoot: root,
      maxBytes: 1_000_000,
      inUse: [],
      logger,
      lookupPrState: async input => {
        seen.push({ headSha: input.headSha, prNumber: input.prNumber });
        if (input.headSha === sha(1)) return { state: 'merged' };
        if (input.headSha === sha(2)) return { state: 'closed' };
        if (input.headSha === sha(3)) return { state: 'open', headSha: sha(3) };
        throw new Error('github_unavailable');
      },
    });
    expect(existsSync(merged)).toBe(false);
    expect(existsSync(`${merged}.pr`)).toBe(false);
    expect(existsSync(closed)).toBe(false);
    expect(existsSync(open)).toBe(true);
    expect(existsSync(failing)).toBe(true);
    // The sibling marker routes the lookup by PR number.
    expect(seen.find(s => s.headSha === sha(1))?.prNumber).toBe(11);
    expect(evictedMessages(entries)).toEqual([
      { owner: 'o', repo: 'r', headSha: sha(1), reason: 'merged', bytesFreed: 100 },
      { owner: 'o', repo: 'r', headSha: sha(2), reason: 'closed', bytesFreed: 50 },
    ]);
    expect(
      entries.find(e => e.message === 'overseer_review_checkout_state_unknown')?.data
    ).toMatchObject({ headSha: sha(4), reason: 'github_unavailable' });
    expect(result.freedBytes).toBe(150);
    expect(
      entries.find(e => e.message === 'overseer_review_checkout_eviction_pass')?.data
    ).toMatchObject({ evicted: 2, freedBytes: 150, totalBytes: 20 });
  });

  test('evict-superseded: an older head of an open PR goes once its live head is cached', async () => {
    const old = await cachedCheckout(root, 'o', 'r', sha(10), 40, 1_000);
    const current = await cachedCheckout(root, 'o', 'r', sha(11), 40, 1_001);
    // A superseded head whose live head is NOT cached is left for the cap.
    const lonely = await cachedCheckout(root, 'o', 'other', sha(12), 40, 1_002);
    const { logger, entries } = captureLogger();
    await evictReviewCheckouts({
      checkoutRoot: root,
      maxBytes: 1_000_000,
      inUse: [],
      logger,
      lookupPrState: async input =>
        input.repo === 'other'
          ? { state: 'open', headSha: sha(99) }
          : { state: 'open', headSha: sha(11) },
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(lonely)).toBe(true);
    expect(evictedMessages(entries)).toEqual([
      { owner: 'o', repo: 'r', headSha: sha(10), reason: 'superseded', bytesFreed: 40 },
    ]);
  });

  test('cap evicts least-recently-used first and always keeps the newest 2 per repo', async () => {
    for (let i = 1; i <= 5; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    // A second repo with one checkout: its newest-2 floor protects it.
    const solo = await cachedCheckout(root, 'o', 'solo', sha(50), 100, 500);
    const { logger, entries } = captureLogger();
    const result = await evictReviewCheckouts({
      checkoutRoot: root,
      maxBytes: 350,
      inUse: [],
      logger,
    });
    // 600 total: LRU order evicts sha(1), sha(2), sha(3) (solo is floor-protected).
    expect(evictedMessages(entries).map(e => [e.headSha, e.reason, e.bytesFreed])).toEqual([
      [sha(1), 'cap', 100],
      [sha(2), 'cap', 100],
      [sha(3), 'cap', 100],
    ]);
    expect(existsSync(join(root, 'o', 'r', sha(4)))).toBe(true);
    expect(existsSync(join(root, 'o', 'r', sha(5)))).toBe(true);
    expect(existsSync(solo)).toBe(true);
    expect(result).toMatchObject({ freedBytes: 300, totalBytes: 300, overCap: false });
    expect(entries.some(e => e.message === 'overseer_review_checkout_cache_over_cap')).toBe(false);
  });

  test('cap that cannot be met keeps the newest 2 and logs over_cap', async () => {
    for (let i = 1; i <= 5; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    const { logger, entries } = captureLogger();
    const result = await evictReviewCheckouts({
      checkoutRoot: root,
      maxBytes: 150,
      inUse: [],
      logger,
    });
    expect(evictedMessages(entries).map(e => e.headSha)).toEqual([sha(1), sha(2), sha(3)]);
    expect(existsSync(join(root, 'o', 'r', sha(4)))).toBe(true);
    expect(existsSync(join(root, 'o', 'r', sha(5)))).toBe(true);
    expect(result.overCap).toBe(true);
    expect(
      entries.find(e => e.message === 'overseer_review_checkout_cache_over_cap')?.data
    ).toEqual({ totalBytes: 200, maxBytes: 150 });
  });

  test('in-use checkout, job scratch and tmp builds are never touched', async () => {
    // Oldest, merged and over cap: eligible on every axis except in-use.
    const inFlight = await cachedCheckout(root, 'o', 'r', sha(1), 100, 900);
    const expired = await cachedCheckout(root, 'o', 'r', sha(2), 100, 901);
    for (let i = 3; i <= 4; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    const scratch = join(spool, 'job-1.scratch', 'co');
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, 'file'), 'x'.repeat(500));
    const tmpBuild = join(root, 'o', 'r', `${sha(9)}.tmp-1234`);
    await mkdir(tmpBuild, { recursive: true });
    await writeFile(join(tmpBuild, 'file'), 'x'.repeat(500));
    const claimedFor = (id: string, head: string, leaseMs: number): DispatchMessage => ({
      ...message(id, head),
      body: JSON.stringify({ owner: 'o', repo: 'r', prNumber: 7, headSha: head, baseRef: 'dev' }),
      status: 'claimed',
      lease_expires_at: new Date(1_000_000 + leaseMs).toISOString(),
    });
    const listClaimedReviews = mock(async () => [
      { ...claimedFor('live', sha(1), 60_000), cursor_seq: 1 },
      { ...claimedFor('dead', sha(2), -60_000), cursor_seq: 2 },
    ]);
    const { logger, entries } = captureLogger();
    const evictor = createReviewCheckoutEvictor({
      listClaimedReviews,
      checkoutRoot: root,
      maxBytes: 1,
      now: () => 1_000_000,
      logger,
      lookupPrState: async () => ({ state: 'merged' }),
    });
    await evictor({ protect: [] });
    expect(listClaimedReviews).toHaveBeenCalledWith({
      recipient: 'overseer-reviewer',
      task_type: 'run_review',
      status: 'claimed',
      limit: 500,
    });
    expect(existsSync(inFlight)).toBe(true);
    // An expired lease is not in flight.
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(join(scratch, 'file'))).toBe(true);
    expect(existsSync(join(tmpBuild, 'file'))).toBe(true);
    expect(evictedMessages(entries).map(e => e.headSha)).not.toContain(sha(1));
  });

  test('a live claim behind 500 stale claims is still protected (claims are walked by page)', async () => {
    const live = await cachedCheckout(root, 'o', 'r', sha(1), 100, 900);
    for (let i = 2; i <= 4; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    const claim = (id: string, head: string, leaseMs: number, seq: number): SeqCursorMessage => ({
      ...message(id, head),
      body: JSON.stringify({ owner: 'o', repo: 'r', prNumber: 7, headSha: head, baseRef: 'dev' }),
      status: 'claimed',
      lease_expires_at: new Date(1_000_000 + leaseMs).toISOString(),
      cursor_seq: seq,
    });
    // Page 1: 500 expired claims (the oldest rows). Page 2: the one live review.
    const stale = Array.from({ length: 500 }, (_, i) =>
      claim(`stale-${i}`, sha(9), -60_000, i + 1)
    );
    const calls: (number | undefined)[] = [];
    const listClaimedReviews = async (filters: {
      afterSeq?: number;
    }): Promise<SeqCursorMessage[]> => {
      calls.push(filters.afterSeq);
      if (filters.afterSeq === undefined) return stale;
      if (filters.afterSeq === 500) return [claim('live', sha(1), 60_000, 501)];
      return [];
    };
    const evictor = createReviewCheckoutEvictor({
      listClaimedReviews,
      checkoutRoot: root,
      maxBytes: 1,
      now: () => 1_000_000,
      logger: captureLogger().logger,
    });
    await evictor({ protect: [] });
    expect(calls).toEqual([undefined, 500]);
    expect(existsSync(live)).toBe(true);
  });

  test('a claim walk that cannot finish skips the pass instead of evicting', async () => {
    const head = await cachedCheckout(root, 'o', 'r', sha(1), 100, 900);
    for (let i = 2; i <= 4; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    const { logger, entries } = captureLogger();
    let seq = 0;
    const evictor = createReviewCheckoutEvictor({
      // Always a full page: the walk never ends, so it must give up and skip.
      listClaimedReviews: async () =>
        Array.from({ length: 500 }, () => {
          seq += 1;
          return { ...message(`m${seq}`, sha(9)), status: 'claimed' as const, cursor_seq: seq };
        }),
      checkoutRoot: root,
      maxBytes: 1,
      now: () => 1_000_000,
      logger,
    });
    expect(await evictor({ protect: [] })).toBeNull();
    expect(entries.map(e => e.message)).toEqual(['overseer_review_checkout_eviction_skipped']);
    expect(existsSync(head)).toBe(true);
  });

  test('protected head survives, unreadable claims skip the pass, GitHub is throttled', async () => {
    const protectedHead = await cachedCheckout(root, 'o', 'r', sha(1), 100, 900);
    for (let i = 2; i <= 4; i += 1) await cachedCheckout(root, 'o', 'r', sha(i), 100, 1_000 + i);
    const { logger, entries } = captureLogger();
    const lookup = mock(
      async (): Promise<ReviewCheckoutPrState> => ({ state: 'open', headSha: sha(4) })
    );
    let nowMs = 1_000_000;
    let failClaims = true;
    const evictor = createReviewCheckoutEvictor({
      listClaimedReviews: async () => {
        if (failClaims) throw new Error('db_down');
        return [];
      },
      checkoutRoot: root,
      maxBytes: 1,
      now: () => nowMs,
      stateSweepIntervalMs: 60_000,
      logger,
      lookupPrState: lookup,
    });
    expect(await evictor({ protect: [] })).toBeNull();
    expect(entries.map(e => e.message)).toEqual(['overseer_review_checkout_eviction_skipped']);
    expect(existsSync(protectedHead)).toBe(true);
    failClaims = false;
    await evictor({ protect: [{ owner: 'o', repo: 'r', headSha: sha(1).toUpperCase() }] });
    expect(existsSync(protectedHead)).toBe(true);
    const callsAfterFirst = lookup.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    nowMs += 1_000;
    await evictor({ protect: [] });
    expect(lookup.mock.calls.length).toBe(callsAfterFirst);
  });

  test('worker tick evicts before preparing (protecting that head) and after the drain', async () => {
    const calls: string[] = [];
    const deps = fakeDeps([message('a', sha(7))]);
    deps.resolveReviewBase = mock(async () => ({ baseRef: 'dev', baseSha: sha(6) }));
    deps.prepareCheckout = mock(async () => {
      calls.push('prepare');
      return '';
    });
    deps.evictCheckouts = mock(async input => {
      calls.push(`evict:${input.protect.map(k => k.headSha).join(',')}`);
      throw new Error('disk_walk_failed');
    });
    await tickReviewWorkerClock(CONFIG, deps);
    expect(calls).toEqual([`evict:${sha(7)}`, 'prepare', 'evict:']);
    // An eviction failure never blocks the review itself.
    expect(deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
  });
});

describe('review checkout cache helpers', () => {
  test('cache cap env defaults to 3GB and rejects junk', () => {
    expect(DEFAULT_REVIEW_CHECKOUT_CACHE_MAX_BYTES).toBe(3221225472);
    expect(resolveReviewCheckoutCacheMaxBytes(undefined)).toBe(3221225472);
    expect(resolveReviewCheckoutCacheMaxBytes('')).toBe(3221225472);
    expect(resolveReviewCheckoutCacheMaxBytes('-5')).toBe(3221225472);
    expect(resolveReviewCheckoutCacheMaxBytes('1.5')).toBe(3221225472);
    expect(resolveReviewCheckoutCacheMaxBytes(' 1048576 ')).toBe(1048576);
  });

  test('sparse excludes match owner/repo and refuse unsafe paths', () => {
    expect(
      resolveSparseExcludes('ThinmanSoftware', 'BDC-XO', DEFAULT_REVIEW_SPARSE_EXCLUDES)
    ).toEqual(['generations']);
    expect(
      resolveSparseExcludes('thinmansoftware', 'bdc-harness', DEFAULT_REVIEW_SPARSE_EXCLUDES)
    ).toEqual([]);
    expect(
      resolveSparseExcludes(
        'o',
        'r',
        'o/r:/media/, o/r:../etc, o/r:a/*, o/r:, o/r:docs/big, x/y:skip, o/r:media'
      )
    ).toEqual(['media', 'docs/big']);
    expect(resolveSparseExcludes('thinmansoftware', 'bdc-xo', '')).toEqual([]);
  });

  test('associated-pulls state: open wins, merged vs closed, doubt is unknown', () => {
    expect(derivePrStateFromAssociatedPulls(sha(1), [])).toEqual({
      state: 'unknown',
      reason: 'no_associated_pr',
    });
    expect(derivePrStateFromAssociatedPulls(sha(1), { message: 'x' })).toMatchObject({
      state: 'unknown',
    });
    expect(
      derivePrStateFromAssociatedPulls(sha(1), [
        { state: 'closed', merged_at: null, head: { sha: sha(1) } },
        { state: 'open', head: { sha: sha(2) } },
      ])
    ).toEqual({ state: 'open', headSha: sha(2) });
    expect(
      derivePrStateFromAssociatedPulls(sha(1), [
        { state: 'closed', merged_at: '2026-11-01T00:00:00Z', head: { sha: sha(1) } },
      ])
    ).toEqual({ state: 'merged' });
    expect(
      derivePrStateFromAssociatedPulls(sha(1), [{ state: 'closed', merged_at: null }])
    ).toEqual({ state: 'closed' });
  });

  test('GitHub lookup reads the PR by number, else by commit association', async () => {
    const pulls: Record<number, { state: string; merged?: boolean; head: { sha: string } }> = {
      1: { state: 'closed', merged: true, head: { sha: sha(1) } },
      2: { state: 'closed', merged: false, head: { sha: sha(2) } },
      3: { state: 'open', head: { sha: sha(30) } },
    };
    const request = mock(async () => ({ data: [{ state: 'closed', merged_at: 'x' }] }));
    const client = {
      pulls: {
        get: async (input: Record<string, unknown>): Promise<unknown> => ({
          data: pulls[input.pull_number as number],
        }),
      },
      request,
    };
    const lookup = createGitHubReviewCheckoutPrLookup(
      () => client as unknown as ReturnType<typeof createRealOctokitClient>
    );
    const key = { owner: 'o', repo: 'r', headSha: sha(3) };
    expect(await lookup({ ...key, prNumber: 1 })).toEqual({ state: 'merged' });
    expect(await lookup({ ...key, prNumber: 2 })).toEqual({ state: 'closed' });
    expect(await lookup({ ...key, prNumber: 3 })).toEqual({ state: 'open', headSha: sha(30) });
    expect(request).not.toHaveBeenCalled();
    expect(await lookup(key)).toEqual({ state: 'merged' });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', {
      owner: 'o',
      repo: 'r',
      commit_sha: sha(3),
    });
  });
});
