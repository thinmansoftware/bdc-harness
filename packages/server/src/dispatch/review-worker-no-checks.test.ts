/**
 * WO-HARNESS-OVERSEER-NO-CHECKS-DEFERRAL-BOUND-01 (bdc-xo#5575): a head that reports zero check
 * runs is not deferred forever. Below the bound nothing changes; at the bound the review ends with
 * the visible outcome review_incomplete / no_checks_reported and the claim-defer loop stops.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { ReviewSpoolLease } from '@archon/core/db/review-spool-leases';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import {
  DEFAULT_NO_CHECKS_MAX_WAIT_MS,
  resolveNoChecksMaxWaitMs,
  stopReviewWorkerClock,
  tickReviewWorkerClock,
  type ReviewSpoolLeaseStore,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};
const MINUTE = 60_000;

function memoryLeaseStore(): ReviewSpoolLeaseStore {
  const rows = new Map<string, ReviewSpoolLease>();
  const live = (row: ReviewSpoolLease | undefined): boolean =>
    row !== undefined && Date.parse(row.expires_at) > Date.now();
  const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
  const matches = (
    row: ReviewSpoolLease | undefined,
    id: { holder_id: string; fencing_token: number }
  ): row is ReviewSpoolLease =>
    live(row) && row?.holder_id === id.holder_id && row.fencing_token === id.fencing_token;
  return {
    acquire: async input => {
      const row = rows.get(input.spool_key);
      if (live(row)) return null;
      const lease: ReviewSpoolLease = {
        spool_key: input.spool_key,
        holder_id: input.holder_id,
        fencing_token: (row?.fencing_token ?? 0) + 1,
        acquired_at: at(0),
        heartbeat_at: at(0),
        expires_at: at(input.ttl_seconds * 1000),
      };
      rows.set(input.spool_key, lease);
      return lease;
    },
    renew: async (id, ttl) => {
      const row = rows.get(id.spool_key);
      if (!matches(row, id)) return null;
      const next = { ...row, heartbeat_at: at(0), expires_at: at(ttl * 1000) };
      rows.set(id.spool_key, next);
      return next;
    },
    release: async id => {
      const row = rows.get(id.spool_key);
      if (!matches(row, id)) return false;
      rows.set(id.spool_key, { ...row, expires_at: new Date(0).toISOString() });
      return true;
    },
    check: async id => matches(rows.get(id.spool_key), id),
  };
}

/** A queued review row created `ageMs` ago. */
function row(id: string, ageMs: number): DispatchMessage {
  return {
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `review-${id}`,
    task_type: 'run_review',
    sender: 'overseer',
    recipient: 'overseer-reviewer',
    body: JSON.stringify({
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 4885,
      headSha: 'e01e3236a9e7ced16f0d6a0fc31024128f98065f',
      baseRef: 'main',
      author: 'contributor',
    }),
    status: 'queued',
    result_body: null,
    created_at: new Date(Date.now() - ageMs).toISOString(),
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
    subject_key: 'gh:thinmansoftware/bdc-xo#4885',
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  };
}

interface Harness {
  deps: ReviewWorkerDeps;
  comments: { body: string; commitId?: string; event: string }[];
  logs: { message: string; data: Record<string, unknown> }[];
}

function harness(rows: DispatchMessage[], outcome: SubmitOutcome): Harness {
  const terminal = new Set<string>();
  const comments: Harness['comments'] = [];
  const logs: Harness['logs'] = [];
  const submitReview = mock(async (input: { body: string; commitId?: string; event: string }) => {
    comments.push(input);
    return { submitted: true };
  });
  const deps = {
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
    // The real queue only lists rows that are still queued.
    listMessages: mock(async () => rows.filter(item => !terminal.has(item.id))),
    claimMessage: mock(async ({ id, worker_id }) => {
      if (terminal.has(id)) return null;
      const found = rows.find(item => item.id === id);
      return found
        ? { ...found, status: 'claimed' as const, lease_owner: worker_id, fencing_token: 1 }
        : null;
    }),
    postResult: mock(async input => {
      terminal.add(input.id);
      return null;
    }),
    releaseMessage: mock(async () => null),
    deferMessage: mock(async () => null),
    runAndSubmitReview: mock(async () => outcome),
    createSubmitDeps: mock(
      () =>
        ({
          reviewerIdentity: CONFIG.reviewerIdentity,
          submitReview,
        }) as unknown as SubmitDeps
    ),
    spoolLease: memoryLeaseStore(),
    logger: {
      warn: (data: Record<string, unknown>, message: string) => logs.push({ message, data }),
    },
  } as unknown as ReviewWorkerDeps;
  return { deps, comments, logs };
}

afterEach(() => stopReviewWorkerClock());

const NO_CHECKS: SubmitOutcome = { disposition: 'checks_pending', reason: 'checks_not_terminal' };

describe('zero reported checks and the bound', () => {
  test('1: below the bound the row is deferred as before and nothing is posted', async () => {
    const h = harness([row('young', 5 * MINUTE)], NO_CHECKS);
    await tickReviewWorkerClock(CONFIG, h.deps);
    expect(h.deps.deferMessage).toHaveBeenCalledTimes(1);
    expect(h.deps.postResult).not.toHaveBeenCalled();
    expect(h.comments).toEqual([]);
    expect(h.logs.map(l => l.message)).toEqual(['overseer_review_checks_pending_deferred']);
    expect(h.logs[0]?.data).toEqual(expect.objectContaining({ reason: 'no_checks_reported' }));
  });

  test('2: at the bound the outcome is visible and the row ends failed and blocked', async () => {
    const h = harness([row('old', 31 * MINUTE)], NO_CHECKS);
    await tickReviewWorkerClock(CONFIG, h.deps);
    expect(h.comments).toEqual([
      {
        body: 'Review incomplete: no_checks_reported. No approval was recorded.',
        commitId: 'e01e3236a9e7ced16f0d6a0fc31024128f98065f',
        event: 'COMMENT',
        owner: 'thinmansoftware',
        repo: 'bdc-xo',
        number: 4885,
      },
    ]);
    expect(h.deps.deferMessage).not.toHaveBeenCalled();
    expect(h.deps.releaseMessage).not.toHaveBeenCalled();
    expect(h.deps.postResult).toHaveBeenCalledTimes(1);
    const posted = (h.deps.postResult as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
      status: string;
      task_outcome: string;
      result_body: string;
    };
    expect(posted.status).toBe('failed');
    expect(posted.task_outcome).toBe('blocked');
    expect(JSON.parse(posted.result_body)).toEqual(
      expect.objectContaining({ disposition: 'review_incomplete', reason: 'no_checks_reported' })
    );
    expect(h.logs.map(l => l.message)).toEqual(['overseer_review_no_checks_bound_reached']);
    expect(h.logs[0]?.data).toEqual(
      expect.objectContaining({ messageId: 'old', prNumber: 4885, boundMs: 1_800_000 })
    );
  });

  test('3: the loop stops: a second tick neither claims nor logs the row again', async () => {
    const h = harness([row('old', 45 * MINUTE)], NO_CHECKS);
    await tickReviewWorkerClock(CONFIG, h.deps);
    const logged = h.logs.length;
    await tickReviewWorkerClock(CONFIG, h.deps);
    expect(h.deps.claimMessage).toHaveBeenCalledTimes(1);
    expect(h.deps.runAndSubmitReview).toHaveBeenCalledTimes(1);
    expect(h.logs.length).toBe(logged);
    expect(h.comments.length).toBe(1);
  });

  test('4: a head with reported checks is never ended by this rule, however old', async () => {
    for (const pendingChecks of [['test (ubuntu-latest)'], []]) {
      const h = harness([row('slow', 3 * 60 * MINUTE)], { ...NO_CHECKS, pendingChecks });
      await tickReviewWorkerClock(CONFIG, h.deps);
      expect(h.deps.deferMessage).toHaveBeenCalledTimes(1);
      expect(h.deps.postResult).not.toHaveBeenCalled();
      expect(h.comments).toEqual([]);
      expect(h.logs.map(l => l.message)).toEqual(['overseer_review_checks_pending_deferred']);
    }
  });

  test('5: the bound is configurable, floored at one minute, and safe', () => {
    const warnings: string[] = [];
    const logger = {
      warn: (_data: Record<string, unknown>, message: string) => warnings.push(message),
    };
    expect(resolveNoChecksMaxWaitMs('120000', logger)).toBe(120_000);
    expect(resolveNoChecksMaxWaitMs('5', logger)).toBe(60_000);
    expect(warnings).toEqual([]);
    expect(resolveNoChecksMaxWaitMs('abc', logger)).toBe(DEFAULT_NO_CHECKS_MAX_WAIT_MS);
    expect(warnings).toEqual(['overseer_review_no_checks_bound_invalid']);
    expect(resolveNoChecksMaxWaitMs('-3', logger)).toBe(DEFAULT_NO_CHECKS_MAX_WAIT_MS);
    expect(resolveNoChecksMaxWaitMs(undefined, logger)).toBe(1_800_000);
    expect(resolveNoChecksMaxWaitMs('', logger)).toBe(1_800_000);
    expect(DEFAULT_NO_CHECKS_MAX_WAIT_MS).toBe(1_800_000);
  });
});
