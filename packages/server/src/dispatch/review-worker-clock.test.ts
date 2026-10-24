import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import {
  startReviewWorkerClock,
  stopReviewWorkerClock,
  tickReviewWorkerClock,
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
  test('completed unverified review work persists its nonmergeable disposition and verification', async () => {
    const outcome: SubmitOutcome = {
      disposition: 'approved_unverified',
      verification: 'unverified',
      event: 'COMMENT',
      reason: 'sandbox unavailable',
    };
    const deps = fakeDeps([message('unverified')], () => outcome);
    await tickReviewWorkerClock(CONFIG, deps);
    expect(deps.postResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'done',
        task_outcome: 'succeeded',
        result_body: JSON.stringify(outcome),
      })
    );
    expect(deps.deferMessage).not.toHaveBeenCalled();
  });

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
