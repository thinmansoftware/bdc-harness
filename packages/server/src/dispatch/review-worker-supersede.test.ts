/**
 * WO-HARNESS-OVERSEER-RECHECK-DEDUPE-PER-HEAD-01: when the review worker claims
 * a run_review row for (owner, repo, PR, head), every OTHER row for that head
 * still QUEUED and created BEFORE the claim is superseded (cancelled with
 * route_disposition 'superseded' and reason `superseded_by_claim <id>`), so the
 * redundant reviews never run. Rows created after the claim survive.
 *
 * The store is an in-memory dispatch mailbox with the same rules as
 * packages/core/src/db/dispatch.ts for the transitions used here: every insert
 * gets the next rowid and (unless it is a legacy NULL-seq row) seq = rowid;
 * claim bumps the fence and returns claimBoundarySeq = MAX(seq) taken at the
 * claim; postResult needs the current owner + fence; supersedeQueuedMessageByClaim
 * touches only a row still 'queued' with a non-NULL seq <= the boundary.
 * created_at is deliberately settable: another writer's clock can put a row
 * inserted after the claim at an EARLIER created_at, and that row must survive.
 * The real-SQLite proof of the boundary itself is
 * packages/core/src/db/dispatch-supersede-by-claim.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { DispatchMessage, SeqCursorMessage } from '@archon/core/db/dispatch';
import type { ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import type { ReviewWorkItem, SubmitDeps, SubmitOutcome } from '@archon/overseer/pr-review-submit';
import {
  tickReviewWorkerClock,
  type ReviewSpoolLeaseStore,
  type ReviewWorkerDeps,
} from './review-worker-clock';

const CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};
const HEAD = 'a'.repeat(40);

interface Row extends DispatchMessage {
  rowid: number;
  seq: number | null;
}

interface LogLine {
  message: string;
  data: Record<string, unknown>;
}

interface Target {
  prNumber?: number;
  headSha?: string;
  repo?: string;
  repeatReason?: string;
  /** Legacy/import row whose seq was never assigned. */
  nullSeq?: boolean;
  /** Override the row's created_at (another writer's clock). */
  createdAt?: string;
}

class Mailbox {
  rows = new Map<string, Row>();
  private seq = 0;
  private clock = Date.now() - 3_600_000;
  /** Runs inside the claim, after the boundary is taken (another writer). */
  afterClaim: ((claimedId: string) => void) | null = null;

  now(): string {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }

  enqueue(id: string, target: Target = {}): Row {
    this.seq += 1;
    const body = {
      owner: 'thinmansoftware',
      repo: target.repo ?? 'bdc-harness',
      prNumber: target.prNumber ?? 1457,
      headSha: target.headSha ?? HEAD,
      baseRef: 'dev',
      baseSha: 'b'.repeat(40),
      author: 'contributor',
    };
    const row = {
      rowid: this.seq,
      seq: target.nullSeq ? null : this.seq,
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
      created_at: target.createdAt ?? this.now(),
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
      subject_key: `gh:thinmansoftware/${body.repo}#${body.prNumber}`,
      route_disposition: null,
      supersedes_id: null,
      repeat_reason: target.repeatReason ?? null,
    } as Row;
    this.rows.set(id, row);
    return row;
  }

  get(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  deps(
    runReview: (work: ReviewWorkItem) => Promise<SubmitOutcome>,
    logs: LogLine[],
    overrides: Partial<ReviewWorkerDeps> = {}
  ): ReviewWorkerDeps {
    const open = (row: Row): boolean =>
      row.route_disposition === null &&
      (row.not_before === null || Date.parse(row.not_before) <= Date.now());
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
          .filter(row => filters.status !== 'queued' || open(row))
          .sort((a, b) => a.rowid - b.rowid)
          .map(row => ({ ...row })),
      listQueuedReviews: async filters =>
        [...this.rows.values()]
          .filter(
            row =>
              row.recipient === filters.recipient &&
              row.task_type === filters.task_type &&
              row.status === filters.status &&
              (filters.afterSeq === undefined || row.rowid > filters.afterSeq)
          )
          .sort((a, b) => a.rowid - b.rowid)
          .slice(0, filters.limit)
          .map(row => ({ ...row, cursor_seq: row.rowid }) as SeqCursorMessage),
      supersedeQueuedReview: async input => {
        const row = this.rows.get(input.id);
        if (
          !row ||
          row.status !== 'queued' ||
          input.id === input.claimed_id ||
          row.seq === null ||
          row.seq > input.boundary_seq
        ) {
          return null;
        }
        row.status = 'cancelled';
        row.route_disposition = 'superseded';
        row.completed_at = this.now();
        row.result_body = JSON.stringify({
          reason: input.reason,
          superseded_by: input.claimed_id,
        });
        return { ...row };
      },
      claimMessage: async ({ id, worker_id }) => {
        const row = this.rows.get(id);
        if (!row || row.status !== 'queued' || !open(row)) return null;
        row.status = 'claimed';
        row.claimed_at = this.now();
        row.lease_owner = worker_id;
        row.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
        row.fencing_token += 1;
        const seqs = [...this.rows.values()].map(r => r.seq).filter((v): v is number => v !== null);
        const claimBoundarySeq = seqs.length > 0 ? Math.max(...seqs) : undefined;
        this.afterClaim?.(id);
        return claimBoundarySeq === undefined ? { ...row } : { ...row, claimBoundarySeq };
      },
      deferMessage: async () => null,
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
        row.completed_at = this.now();
        row.lease_owner = null;
        row.lease_expires_at = null;
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
      ...overrides,
    };
  }
}

function memoryLeaseStore(): ReviewSpoolLeaseStore {
  let held = false;
  const lease = (input: { spool_key: string; holder_id: string }) => ({
    spool_key: input.spool_key,
    holder_id: input.holder_id,
    fencing_token: 1,
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return {
    acquire: async input => {
      if (held) return null;
      held = true;
      return lease(input);
    },
    renew: async id => (held ? lease(id) : null),
    release: async () => {
      held = false;
      return true;
    },
    check: async () => held,
  };
}

function reasonOf(row: Row): unknown {
  return row.result_body ? (JSON.parse(row.result_body) as { reason?: unknown }).reason : null;
}

describe('review worker supersedes queued reviews of the head it claims', () => {
  test('rows_created_before_claim_are_superseded_with_reason', async () => {
    const mailbox = new Mailbox();
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, []);

    // Three check completions on one head, all queued before any claim.
    mailbox.enqueue('c1');
    mailbox.enqueue('c2');
    mailbox.enqueue('c3');

    await tickReviewWorkerClock(CONFIG, deps);

    expect(ran).toEqual(['c1']);
    expect(mailbox.get('c1').status).toBe('done');
    for (const id of ['c2', 'c3']) {
      const row = mailbox.get(id);
      expect(row.status).toBe('cancelled');
      expect(row.route_disposition).toBe('superseded');
      expect(reasonOf(row)).toBe('superseded_by_claim c1');
      expect(JSON.parse(row.result_body ?? '{}')).toEqual({
        reason: 'superseded_by_claim c1',
        superseded_by: 'c1',
      });
      expect(row.seq).not.toBeNull();
      // Inserted before c1's claim: seq <= the claim boundary MAX(seq) = 3.
      expect(row.seq ?? Infinity).toBeLessThanOrEqual(3);
    }

    // Nothing left to run on the next tick.
    await tickReviewWorkerClock(CONFIG, deps);
    expect(ran).toEqual(['c1']);
  });

  test('rows_created_after_claim_survive_a_then_b_race', async () => {
    const mailbox = new Mailbox();
    // Live check state on head H: B is failing when A's review starts.
    const checks: Record<string, 'success' | 'failure'> = { A: 'success', B: 'failure' };
    const observed: { id: string; checks: Record<string, string> }[] = [];
    const deps = mailbox.deps(async work => {
      observed.push({ id: work.messageId, checks: { ...checks } });
      return checks.B === 'success' && work.messageId === 'recheck-B'
        ? { disposition: 'approved' }
        : { disposition: 'changes_requested' };
    }, []);

    const rowA = mailbox.enqueue('recheck-A');
    // THE REVIEWER'S CASE: right after A is claimed -- before the worker's
    // supersede pass even reads the queue -- another writer whose clock runs
    // behind inserts B's recheck. B is inserted AFTER the claim (higher seq) but
    // carries a created_at EARLIER than A's claimed_at (earlier even than A's
    // created_at). A timestamp test would supersede it; the seq boundary must not.
    let claimedAtWhenBInserted = '';
    mailbox.afterClaim = claimedId => {
      if (claimedId !== 'recheck-A') return;
      claimedAtWhenBInserted = mailbox.get('recheck-A').claimed_at ?? '';
      checks.B = 'failure';
      mailbox.enqueue('recheck-B', {
        createdAt: new Date(Date.parse(rowA.created_at) - 60_000).toISOString(),
      });
    };
    // A's review snapshots B as failed; B passes while A's review runs.
    const run = deps.runAndSubmitReview;
    deps.runAndSubmitReview = async (work, submitDeps) => {
      const outcome = await run(work, submitDeps);
      if (work.messageId === 'recheck-A') checks.B = 'success';
      return outcome;
    };

    await tickReviewWorkerClock(CONFIG, deps);

    const rowB = mailbox.get('recheck-B');
    expect(Date.parse(rowB.created_at)).toBeLessThan(Date.parse(claimedAtWhenBInserted));
    expect(rowB.seq ?? 0).toBeGreaterThan(mailbox.get('recheck-A').seq ?? Infinity);
    // A ran on the stale snapshot; B's row was NOT superseded.
    expect(observed).toEqual([{ id: 'recheck-A', checks: { A: 'success', B: 'failure' } }]);
    expect(rowB.status).toBe('queued');
    expect(rowB.route_disposition).toBeNull();

    await tickReviewWorkerClock(CONFIG, deps);

    expect(observed[1]).toEqual({ id: 'recheck-B', checks: { A: 'success', B: 'success' } });
    expect(mailbox.get('recheck-B').status).toBe('done');
    expect(JSON.parse(mailbox.get('recheck-B').result_body ?? '{}')).toEqual({
      disposition: 'approved',
    });
  });

  test('null_seq_row_is_never_superseded', async () => {
    const mailbox = new Mailbox();
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, []);

    // A legacy row with no seq, queued before the claim, same head.
    mailbox.enqueue('legacy', { nullSeq: true });
    mailbox.enqueue('claimed-first');
    mailbox.enqueue('dup');
    // Make claimed-first the first claim of the tick.
    mailbox.get('legacy').not_before = new Date(Date.now() + 60_000).toISOString();

    await tickReviewWorkerClock(CONFIG, deps);

    expect(ran).toEqual(['claimed-first']);
    expect(mailbox.get('dup').route_disposition).toBe('superseded');
    const legacy = mailbox.get('legacy');
    expect(legacy.status).toBe('queued');
    expect(legacy.route_disposition).toBeNull();
    expect(legacy.result_body).toBeNull();
  });

  test('claim_without_boundary_skips_superseding', async () => {
    const mailbox = new Mailbox();
    const ran: string[] = [];
    const base = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, []);
    const claim = base.claimMessage;
    const deps: ReviewWorkerDeps = {
      ...base,
      // An adapter that cannot report a boundary.
      claimMessage: async input => {
        const claimed = await claim(input);
        if (!claimed) return null;
        const { claimBoundarySeq: _omit, ...rest } = claimed;
        return rest;
      },
    };

    mailbox.enqueue('first');
    mailbox.enqueue('second');

    await tickReviewWorkerClock(CONFIG, deps);

    // Fail safe: nothing superseded, both reviews run.
    expect(ran).toEqual(['first', 'second']);
    expect(mailbox.get('second').route_disposition).toBeNull();
  });

  test('other_heads_and_prs_untouched', async () => {
    const mailbox = new Mailbox();
    const ran: string[] = [];
    const deps = mailbox.deps(async work => {
      ran.push(work.messageId);
      return { disposition: 'approved' };
    }, []);

    mailbox.enqueue('claimed-first');
    mailbox.enqueue('other-head', { headSha: 'c'.repeat(40) });
    mailbox.enqueue('other-pr', { prNumber: 1453 });
    mailbox.enqueue('other-repo', { repo: 'bdc-xo' });
    mailbox.enqueue('operator', { repeatReason: 'operator_request:ladder_restored' });

    await tickReviewWorkerClock(CONFIG, deps);

    expect(ran).toEqual(['claimed-first', 'other-head', 'other-pr', 'other-repo', 'operator']);
    for (const id of ['other-head', 'other-pr', 'other-repo', 'operator']) {
      expect(mailbox.get(id).route_disposition).toBeNull();
      expect(mailbox.get(id).status).toBe('done');
    }
  });

  test('supersede_failure_does_not_block_the_claimed_review', async () => {
    for (const failure of ['write', 'read'] as const) {
      const mailbox = new Mailbox();
      const logs: LogLine[] = [];
      const ran: string[] = [];
      const base = mailbox.deps(async work => {
        ran.push(work.messageId);
        return { disposition: 'approved' };
      }, logs);
      const deps: ReviewWorkerDeps =
        failure === 'write'
          ? {
              ...base,
              supersedeQueuedReview: async () => {
                throw new Error('database is locked');
              },
            }
          : {
              ...base,
              listQueuedReviews: async () => {
                throw new Error('database is locked');
              },
            };

      mailbox.enqueue('claimed');
      mailbox.enqueue('duplicate');

      await tickReviewWorkerClock(CONFIG, deps);

      // The claimed review ran and was recorded despite the supersede failure.
      expect(ran[0]).toBe('claimed');
      expect(mailbox.get('claimed').status).toBe('done');
      // The duplicate was not superseded; it is not lost either -- it simply
      // runs as it would have without this change.
      expect(mailbox.get('duplicate').route_disposition).toBeNull();
      expect(ran).toEqual(['claimed', 'duplicate']);
      const failed = logs.filter(l => l.message === 'overseer.pr_review.supersede_failed');
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(failed[0]?.data).toEqual(
        expect.objectContaining({
          messageId: 'claimed',
          prNumber: 1457,
          headSha: HEAD,
          error: 'database is locked',
        })
      );
    }
  });
});
