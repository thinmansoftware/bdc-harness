/**
 * WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01: reviews of one PR head run one
 * at a time. A run_review row whose head already has a review in flight is
 * deferred (claimed -> queued with a future not_before), never dropped, and a
 * defer cap stops a stuck claim from starving a head.
 *
 * The store below is a small in-memory dispatch mailbox with the same fencing
 * and not_before rules as packages/core/src/db/dispatch.ts: claim bumps the
 * fence, defer/postResult require the current owner + fence on a claimed row,
 * and a queued row is invisible until its not_before passes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DispatchMessage, SeqCursorMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import type { ReviewWorkItem } from '@archon/overseer/pr-review-submit';
import {
  resetReviewSerializeDeferCounts,
  resolveReviewSerializeBackoffMs,
  resolveReviewSerializeMaxDefers,
  tickReviewWorkerClock,
  type ReviewSpoolLeaseStore,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};
const OTHER_WORKER = 'overseer-review-worker-other-process';
const HEAD = 'a'.repeat(40);

interface Row extends DispatchMessage {
  seq: number;
}

interface LogLine {
  message: string;
  data: Record<string, unknown>;
}

function newRow(seq: number, id: string, body: Record<string, unknown>): Row {
  return {
    seq,
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `pr-recheck:${id}`,
    task_type: 'run_review',
    sender: 'overseer',
    sender_principal_id: null,
    recipient: 'overseer-reviewer',
    body: JSON.stringify(body),
    status: 'queued',
    result_body: null,
    created_at: new Date(seq * 1000).toISOString(),
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
    subject_key: `gh:${String(body.owner)}/${String(body.repo)}#${String(body.prNumber)}`,
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  } as Row;
}

/** In-memory mailbox with dispatch.ts fencing + not_before semantics. */
class Mailbox {
  rows = new Map<string, Row>();
  private seq = 0;
  /** Every (id, event) transition, in order. */
  events: { id: string; event: 'claim' | 'defer' | 'done' }[] = [];

  enqueue(
    id: string,
    overrides: Partial<{ prNumber: number; headSha: string; repo: string }> = {}
  ) {
    this.seq += 1;
    const row = newRow(this.seq, id, {
      owner: 'thinmansoftware',
      repo: overrides.repo ?? 'bdc-harness',
      prNumber: overrides.prNumber ?? 1457,
      headSha: overrides.headSha ?? HEAD,
      baseRef: 'dev',
      baseSha: 'b'.repeat(40),
      author: 'contributor',
    });
    this.rows.set(id, row);
    return row;
  }

  /** Another worker process claims a row (the review that is "in flight"). */
  claimElsewhere(id: string): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    row.status = 'claimed';
    row.lease_owner = OTHER_WORKER;
    row.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
    row.fencing_token += 1;
    this.events.push({ id, event: 'claim' });
  }

  finishElsewhere(id: string): void {
    const row = this.rows.get(id);
    if (!row || row.lease_owner !== OTHER_WORKER) throw new Error(`not claimed elsewhere: ${id}`);
    row.status = 'done';
    row.lease_owner = null;
    row.lease_expires_at = null;
    this.events.push({ id, event: 'done' });
  }

  /** Make every deferred row claimable now (time passing past not_before). */
  elapseBackoff(): void {
    for (const row of this.rows.values()) {
      if (row.status === 'queued' && row.not_before) {
        row.not_before = new Date(Date.now() - 1).toISOString();
      }
    }
  }

  claimedFor(headSha: string, prNumber: number): Row[] {
    return [...this.rows.values()].filter(row => {
      const body = JSON.parse(row.body) as { headSha: string; prNumber: number };
      return row.status === 'claimed' && body.headSha === headSha && body.prNumber === prNumber;
    });
  }

  deps(
    runReview: (work: ReviewWorkItem) => Promise<SubmitOutcome>,
    logs: LogLine[]
  ): ReviewWorkerDeps {
    const visible = (row: Row): boolean =>
      row.not_before === null || Date.parse(row.not_before) <= Date.now();
    return {
      registerWorker: async data => ({
        ...data,
        status: 'available' as const,
        registered_at: new Date(0).toISOString(),
        last_heartbeat_at: new Date(0).toISOString(),
      }),
      heartbeatWorker: async data => ({
        worker_id: data.worker_id,
        host: 'test',
        capabilities: {},
        max_concurrency: 1,
        status: data.status ?? 'available',
        registered_at: new Date(0).toISOString(),
        last_heartbeat_at: new Date(0).toISOString(),
      }),
      listMessages: async filters =>
        [...this.rows.values()]
          .filter(row => row.recipient === filters.recipient && row.status === filters.status)
          .filter(row => filters.status !== 'queued' || visible(row))
          .sort((a, b) => a.seq - b.seq)
          .map(row => ({ ...row })),
      listClaimedReviews: async filters =>
        [...this.rows.values()]
          .filter(
            row =>
              row.recipient === filters.recipient &&
              row.task_type === filters.task_type &&
              row.status === filters.status &&
              (filters.afterSeq === undefined || row.seq > filters.afterSeq)
          )
          .sort((a, b) => a.seq - b.seq)
          .slice(0, filters.limit)
          .map(row => ({ ...row, cursor_seq: row.seq }) as SeqCursorMessage),
      claimMessage: async ({ id, worker_id }) => {
        const row = this.rows.get(id);
        if (!row || row.status !== 'queued' || !visible(row)) return null;
        row.status = 'claimed';
        row.lease_owner = worker_id;
        row.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
        row.fencing_token += 1;
        this.events.push({ id, event: 'claim' });
        return { ...row };
      },
      deferMessage: async input => {
        const row = this.rows.get(input.id);
        if (
          !row ||
          row.status !== 'claimed' ||
          row.lease_owner !== input.worker_id ||
          row.fencing_token !== input.fencing_token
        ) {
          return null;
        }
        row.status = 'queued';
        row.lease_owner = null;
        row.lease_expires_at = null;
        row.not_before = input.defer_until;
        this.events.push({ id: input.id, event: 'defer' });
        return { ...row };
      },
      releaseMessage: async () => null,
      postResult: async input => {
        const row = this.rows.get(input.id);
        if (
          !row ||
          row.status !== 'claimed' ||
          row.lease_owner !== input.worker_id ||
          row.fencing_token !== input.fencing_token
        ) {
          return null;
        }
        row.status = input.status ?? 'done';
        row.task_outcome = input.task_outcome ?? null;
        row.result_body = input.result_body ?? null;
        row.lease_owner = null;
        row.lease_expires_at = null;
        this.events.push({ id: input.id, event: 'done' });
        return { ...row };
      },
      runAndSubmitReview: async work => runReview(work),
      createSubmitDeps: () => ({ reviewerIdentity: CONFIG.reviewerIdentity }) as SubmitDeps,
      logger: {
        warn: (data, message): void => {
          logs.push({ message, data });
        },
      },
      spoolLease: memoryLeaseStore(),
    };
  }
}

function memoryLeaseStore(): ReviewSpoolLeaseStore {
  let held = false;
  let token = 0;
  const lease = (input: { spool_key: string; holder_id: string }) => ({
    spool_key: input.spool_key,
    holder_id: input.holder_id,
    fencing_token: token,
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return {
    acquire: async input => {
      if (held) return null;
      held = true;
      token += 1;
      return lease(input);
    },
    renew: async (id, _ttl) =>
      held ? lease({ spool_key: id.spool_key, holder_id: id.holder_id }) : null,
    release: async () => {
      held = false;
      return true;
    },
    check: async () => held,
  };
}

const ENV_KEYS = ['OVERSEER_REVIEW_SERIALIZE_MAX_DEFERS', 'OVERSEER_REVIEW_SERIALIZE_BACKOFF_MS'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetReviewSerializeDeferCounts();
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('review worker serializes reviews of one head', () => {
  test('a_then_b_race_b_gets_a_later_review_that_sees_b_passed', async () => {
    const mailbox = new Mailbox();
    const logs: LogLine[] = [];
    // Live check state on head H. B is still failing when A's review starts.
    const checks: Record<string, 'success' | 'failure'> = { A: 'success', B: 'failure' };
    const observed: { id: string; checks: Record<string, string> }[] = [];
    const deps = mailbox.deps(async work => {
      observed.push({ id: work.messageId, checks: { ...checks } });
      return checks.B === 'success'
        ? { disposition: 'approved' }
        : { disposition: 'changes_requested' };
    }, logs);

    // A completes -> row recheck-A; its review is claimed and running (it
    // snapshotted B as failed) in another worker process.
    mailbox.enqueue('recheck-A');
    mailbox.claimElsewhere('recheck-A');
    // B passes before A's review writes its verdict -> its own row (#782 key).
    checks.B = 'success';
    mailbox.enqueue('recheck-B');

    // Tick while A is still in flight: B is claimed, then DEFERRED, not run.
    await tickReviewWorkerClock(CONFIG, deps);
    const rowB = mailbox.rows.get('recheck-B');
    expect(observed).toEqual([]);
    expect(rowB?.status).toBe('queued');
    expect(rowB?.not_before).not.toBeNull();
    expect(Date.parse(rowB?.not_before ?? '')).toBeGreaterThan(Date.now());
    expect(logs.map(l => l.message)).toContain('overseer.pr_review.serialize_deferred');
    expect(logs.find(l => l.message === 'overseer.pr_review.serialize_deferred')?.data).toEqual(
      expect.objectContaining({
        messageId: 'recheck-B',
        inFlightMessageId: 'recheck-A',
        prNumber: 1457,
        headSha: HEAD,
        deferCount: 1,
      })
    );

    // A's (stale) review finishes. B's row is still in the mailbox -- deferred,
    // not dropped -- and runs once its backoff passes.
    mailbox.finishElsewhere('recheck-A');
    mailbox.elapseBackoff();
    await tickReviewWorkerClock(CONFIG, deps);

    expect(observed).toEqual([{ id: 'recheck-B', checks: { A: 'success', B: 'success' } }]);
    expect(mailbox.rows.get('recheck-B')?.status).toBe('done');
    const order = mailbox.events.map(e => `${e.id}:${e.event}`);
    expect(order).toEqual([
      'recheck-A:claim',
      'recheck-B:claim',
      'recheck-B:defer',
      'recheck-A:done',
      'recheck-B:claim',
      'recheck-B:done',
    ]);
  });

  test('parallel_completions_run_one_at_a_time', async () => {
    const mailbox = new Mailbox();
    const logs: LogLine[] = [];
    let running = 0;
    let maxRunning = 0;
    const siblingsClaimedDuringRun: number[] = [];
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      siblingsClaimedDuringRun.push(mailbox.claimedFor(HEAD, 1457).length);
      ran.push(work.messageId);
      await Promise.resolve();
      running -= 1;
      return { disposition: 'approved' };
    }, logs);

    // Three check completions on one head at once. The first one's review is
    // already in flight in another worker process.
    mailbox.enqueue('c1');
    mailbox.enqueue('c2');
    mailbox.enqueue('c3');
    mailbox.claimElsewhere('c1');

    // Both c2 and c3 hold back while c1 runs.
    await tickReviewWorkerClock(CONFIG, deps);
    expect(ran).toEqual([]);
    expect(mailbox.rows.get('c2')?.status).toBe('queued');
    expect(mailbox.rows.get('c3')?.status).toBe('queued');
    expect(logs.filter(l => l.message === 'overseer.pr_review.serialize_deferred')).toHaveLength(2);

    mailbox.finishElsewhere('c1');
    mailbox.elapseBackoff();
    await tickReviewWorkerClock(CONFIG, deps);

    // c2 then c3, never overlapping, and at each run the only claimed review of
    // this head is the one running.
    expect(ran).toEqual(['c2', 'c3']);
    expect(maxRunning).toBe(1);
    expect(siblingsClaimedDuringRun).toEqual([1, 1]);
    expect(mailbox.rows.get('c2')?.status).toBe('done');
    expect(mailbox.rows.get('c3')?.status).toBe('done');
  });

  test('different_heads_or_prs_do_not_block_each_other', async () => {
    const mailbox = new Mailbox();
    const logs: LogLine[] = [];
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, logs);

    mailbox.enqueue('inflight');
    mailbox.claimElsewhere('inflight');
    mailbox.enqueue('other-head', { headSha: 'c'.repeat(40) });
    mailbox.enqueue('other-pr', { prNumber: 1453 });
    mailbox.enqueue('other-repo', { repo: 'bdc-xo' });

    await tickReviewWorkerClock(CONFIG, deps);

    expect(ran).toEqual(['other-head', 'other-pr', 'other-repo']);
    expect(logs.filter(l => l.message.startsWith('overseer.pr_review.serialize'))).toEqual([]);
  });

  test('an expired claim does not hold back a head', async () => {
    const mailbox = new Mailbox();
    const logs: LogLine[] = [];
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, logs);

    mailbox.enqueue('abandoned');
    mailbox.claimElsewhere('abandoned');
    const abandoned = mailbox.rows.get('abandoned');
    if (abandoned) abandoned.lease_expires_at = new Date(Date.now() - 1).toISOString();
    mailbox.enqueue('next');

    await tickReviewWorkerClock(CONFIG, deps);
    expect(ran).toEqual(['next']);
  });

  test('defer_cap_runs_anyway_and_logs', async () => {
    process.env.OVERSEER_REVIEW_SERIALIZE_MAX_DEFERS = '3';
    const mailbox = new Mailbox();
    const logs: LogLine[] = [];
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, logs);

    // A claim that never finishes (stuck worker, lease kept alive).
    mailbox.enqueue('stuck');
    mailbox.claimElsewhere('stuck');
    mailbox.enqueue('waiting');

    for (let tick = 1; tick <= 3; tick += 1) {
      await tickReviewWorkerClock(CONFIG, deps);
      expect(ran).toEqual([]);
      expect(mailbox.rows.get('waiting')?.status).toBe('queued');
      mailbox.elapseBackoff();
    }
    expect(logs.filter(l => l.message === 'overseer.pr_review.serialize_deferred')).toHaveLength(3);
    expect(logs.some(l => l.message === 'overseer.pr_review.serialize_cap_reached')).toBe(false);

    // Fourth claim: the cap (3 defers) is reached, so the review runs anyway.
    await tickReviewWorkerClock(CONFIG, deps);
    expect(ran).toEqual(['waiting']);
    expect(mailbox.rows.get('waiting')?.status).toBe('done');
    const cap = logs.filter(l => l.message === 'overseer.pr_review.serialize_cap_reached');
    expect(cap).toHaveLength(1);
    expect(cap[0]?.data).toEqual(
      expect.objectContaining({
        messageId: 'waiting',
        inFlightMessageId: 'stuck',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 1457,
        headSha: HEAD,
        deferCount: 3,
      })
    );
  });

  test('a deferred row waits the configured backoff', async () => {
    process.env.OVERSEER_REVIEW_SERIALIZE_BACKOFF_MS = '120000';
    const mailbox = new Mailbox();
    const deps = mailbox.deps(async () => ({ disposition: 'approved' }), []);
    mailbox.enqueue('inflight');
    mailbox.claimElsewhere('inflight');
    mailbox.enqueue('later');
    const before = Date.now();
    await tickReviewWorkerClock(CONFIG, deps);
    const notBefore = Date.parse(mailbox.rows.get('later')?.not_before ?? '');
    expect(notBefore - before).toBeGreaterThanOrEqual(120_000);
    expect(notBefore - before).toBeLessThan(130_000);
  });

  test('serialize env defaults and junk handling', () => {
    expect(resolveReviewSerializeMaxDefers(undefined)).toBe(10);
    expect(resolveReviewSerializeMaxDefers('')).toBe(10);
    expect(resolveReviewSerializeMaxDefers('abc')).toBe(10);
    expect(resolveReviewSerializeMaxDefers('-1')).toBe(10);
    expect(resolveReviewSerializeMaxDefers('0')).toBe(0);
    expect(resolveReviewSerializeMaxDefers('4')).toBe(4);
    expect(resolveReviewSerializeBackoffMs(undefined)).toBe(60_000);
    expect(resolveReviewSerializeBackoffMs('0')).toBe(60_000);
    expect(resolveReviewSerializeBackoffMs('5000')).toBe(5_000);
  });
});
