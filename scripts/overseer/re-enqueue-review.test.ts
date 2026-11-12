/**
 * WO-HARNESS-OVERSEER-REREVIEW-FAILED-HEAD-COMMAND-01 (bdc-xo#5564): the operator command that
 * re-enqueues one exact head whose newest review row FAILED. Decision tests run on fixture rows;
 * Tests 5 and 6 run the real Dispatch insert path on a real SQLite store.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { SqliteAdapter } from '../../packages/core/src/db/adapters/sqlite';
import { DispatchNonSystemCapability } from '../../packages/core/src/db/dispatch-sender-authority';
import {
  isAutoRereviewReason,
  reviewCorrelationId,
} from '../../packages/overseer/src/pr-review-ingest';
import { reviewSubjectKey } from '../../packages/overseer/src/pr-review-wiring';
import {
  createHttpPort,
  decide,
  edgeSweep,
  EDGE_SWEEP_REASON,
  reEnqueue,
  show,
  type DispatchPort,
  type OutgoingMessage,
  type ReviewRow,
} from './re-enqueue-review';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('../../packages/core/src/db/connection', () => ({ getDatabase: () => db }));
const dispatch = await import('../../packages/core/src/db/dispatch');

const repository = 'thinmansoftware/bdc-xo';
const pr = 5518;
const head = 'db7f98818ee020b4fe7707233a358283ca424948';
const other = 'e'.repeat(40);
const reason = 'the credential guard fix is live';
const subject = `gh:${repository}#${pr}`;

function body(headSha: string): string {
  return JSON.stringify({
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    prNumber: pr,
    headSha,
    baseRef: 'main',
    baseSha: '',
    author: 'someone',
    headCiGreen: true,
  });
}
let counter = 0;
function row(status: string, headSha = head, extra: Partial<ReviewRow> = {}): ReviewRow {
  counter += 1;
  return {
    id: `row-${counter}`,
    status,
    body: body(headSha),
    created_at: new Date(Date.UTC(2026, 10, 11, 19, 0, counter)).toISOString(),
    seq: counter,
    task_type: 'run_review',
    ...extra,
  };
}
const input = { repository, prNumber: pr, head, reason };
function refusal(rows: ReviewRow[], over: Partial<typeof input> = {}): string | null {
  const d = decide(rows, { ...input, ...over });
  return d.ok ? null : d.refusal;
}

describe('decision', () => {
  test('1: a bad head or a short reason is refused before anything is read or sent', async () => {
    expect(refusal([row('failed')], { head: 'abc123' })).toContain('40-character hex');
    expect(refusal([row('failed')], { head: 'g'.repeat(40) })).toContain('40-character hex');
    expect(refusal([row('failed')], { reason: 'too short' })).toContain('at least 10 characters');
    expect(refusal([row('failed')], { reason: '  \t\n  ok  ' })).toContain(
      'at least 10 characters'
    );
    let sent = 0;
    const port: DispatchPort = {
      list: async () => [row('failed')],
      send: async () => {
        sent += 1;
        return { id: 'x', status: 'queued' };
      },
    };
    const r = await reEnqueue(port, { ...input, reason: 'short' });
    expect(r.code).toBe(2);
    expect(sent).toBe(0);
  });

  test('2: no row at the head is refused and says how many rows exist elsewhere', () => {
    expect(refusal([row('failed', other), row('done', other)])).toBe(
      'no review row at this head (2 rows on this pull request, all at other heads)'
    );
    expect(refusal([])).toContain('no review row at this head');
    // Rows that are not run_review (for example receipts) never count.
    expect(refusal([row('failed', head, { task_type: 'run_report' })])).toContain('no review row');
  });

  test('3: work already pending at the head is refused naming the row', () => {
    const failed = row('failed');
    const queued = row('queued');
    expect(refusal([failed, queued])).toBe(
      `a review is already pending at this head: row ${queued.id} is queued`
    );
    const claimed = row('claimed');
    expect(refusal([failed, claimed])).toContain(`row ${claimed.id} is claimed`);
    // A pending row at ANOTHER head does not block this head.
    expect(refusal([failed, row('queued', other)])).toBeNull();
  });

  test('4: only a failed newest row at the head qualifies', () => {
    expect(refusal([row('done')])).toContain('is done, not failed');
    expect(refusal([row('cancelled')])).toContain('every review row at this head is cancelled');
    expect(refusal([row('failed'), row('done')])).toContain('is done, not failed');
    expect(refusal([row('done'), row('failed')])).toBeNull();
    // Newest is decided by seq even when created_at is out of order.
    const older = row('done', head, { seq: 1, created_at: '2026-11-11T20:00:00.000Z' });
    const newer = row('failed', head, { seq: 2, created_at: '2026-11-11T19:00:00.000Z' });
    expect(refusal([newer, older])).toBeNull();
  });

  test('4b: a failed row followed by superseded_by_claim cancels is still failed (PR 101, 2026-11-12)', () => {
    // The exact shape read from hetzner-prod: one claim failed, then six duplicate deliveries created
    // AFTER it were cancelled as superseded_by_claim. Every one of them has a later seq and created_at.
    const failedRow = row('failed', head, {
      result_body: JSON.stringify({
        disposition: 'submission_failed',
        reason: 'head_recheck_failed:Service Unavailable',
      }),
    });
    const superseded = Array.from({ length: 6 }, () =>
      row('cancelled', head, {
        result_body: JSON.stringify({
          disposition: 'cancelled',
          reason: `superseded_by_claim ${failedRow.id}`,
        }),
      })
    );
    // A review of an older head is not part of this head's history.
    const olderHead = row('done', other);
    const d = decide([olderHead, failedRow, ...superseded], input);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.prior.id).toBe(failedRow.id);
      expect(d.rowsAtHead).toBe(7);
      // k counts every row at the head (cancelled included), so the key stays distinct per state.
      expect(d.message.idempotency_key).toBe(`pr-rereview:${repository}#${pr}@${head}:8`);
      expect(d.message.body).toBe(failedRow.body);
    }
    // A DONE row after the failure still wins: a review finished, so there is nothing to re-run.
    expect(refusal([failedRow, ...superseded, row('done')])).toContain('is done, not failed');
    // Cancelled rows alone are not a failure.
    expect(refusal(superseded)).toContain('every review row at this head is cancelled');
    // Pending work still refuses first.
    expect(refusal([failedRow, ...superseded, row('queued')])).toContain('already pending');
  });

  test('7: the reason is not an automatic re-review reason, and the message matches the intake naming', () => {
    const d = decide([row('failed')], input);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(isAutoRereviewReason(d.message.repeat_reason)).toBe(false);
    expect(d.message.repeat_reason).toBe(`operator_request:rereview_failed:${head} ${reason}`);
    expect(d.message.correlation_id).toBe(
      reviewCorrelationId({ owner: 'thinmansoftware', repo: 'bdc-xo', prNumber: pr, headSha: head })
    );
    expect(d.message.subject_key).toBe(reviewSubjectKey('thinmansoftware', 'bdc-xo', pr));
    expect(d.message.sender).toBe('operator');
    expect(d.message.idempotency_key).toBe(`pr-rereview:${repository}#${pr}@${head}:2`);
  });
});

describe('against the real Dispatch store', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    currentDbPath = join(
      import.meta.dir,
      `.test-rereview-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });
  afterEach(async () => {
    delete process.env.BUN_ENV;
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(currentDbPath + suffix);
      } catch {
        /* may not exist */
      }
    }
  });

  /** The same insert path the HTTP route uses for a post with no principal headers. */
  function storePort(): DispatchPort & { sent: OutgoingMessage[] } {
    const sent: OutgoingMessage[] = [];
    return {
      sent,
      list: async key =>
        (await dispatch.listMessages({
          recipient: 'overseer-reviewer',
          subject_key: key,
          limit: 500,
        })) as unknown as ReviewRow[],
      send: async message => {
        sent.push(message);
        // The host runs with sender auth off and a principal registry present; mirror that.
        const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
        const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
        let capability: ReturnType<
          typeof DispatchNonSystemCapability.fromHttpRequest
        >['capability'];
        try {
          delete process.env.DISPATCH_SENDER_AUTH_MODE;
          process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
            {
              credential_id: 'test-registry',
              principal_id: 'test-principal',
              token_sha256: '0'.repeat(64),
              status: 'active',
              send_as: ['claude'],
              receive_as: [],
              roles: ['send'],
            },
          ]);
          capability = DispatchNonSystemCapability.fromHttpRequest({
            requested_sender: message.sender,
          }).capability;
        } finally {
          if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
          else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
          if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
          else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
        }
        const created = await dispatch.createAuthenticatedMessage(capability, {
          correlation_id: message.correlation_id,
          idempotency_key: message.idempotency_key,
          task_type: message.task_type,
          recipient: message.recipient,
          body: message.body,
          subject_key: message.subject_key,
          repeat_reason: message.repeat_reason,
        });
        return { id: created.id, status: created.status };
      },
    };
  }

  /** A review row exactly as the push path writes it, then failed the way tonight's rows failed. */
  async function seedFailedRow(
    headSha: string,
    repeatReason: string | null = null,
    key = `pr-review:${repository}#${pr}@${headSha}`
  ) {
    const created = await dispatch.createAuthenticatedMessage(
      { kind: 'system', sender: 'overseer' },
      {
        correlation_id: key,
        idempotency_key: key,
        task_type: 'run_review',
        recipient: 'overseer-reviewer',
        body: body(headSha),
        subject_key: subject,
        repeat_reason: repeatReason,
      }
    );
    await db.query(
      `UPDATE agent_dispatch_messages
          SET status = 'failed', claimed_at = $2, completed_at = $3, result_body = $4
        WHERE id = $1`,
      [
        created.id,
        '2026-11-11T19:40:52.000Z',
        '2026-11-11T19:41:24.000Z',
        JSON.stringify({ disposition: 'review_incomplete', reason: 'review_body_credential_leak' }),
      ]
    );
    return created.id;
  }

  async function rowsAtHead(headSha: string) {
    return (
      await db.query<{
        id: string;
        status: string;
        sender: string;
        body: string;
        subject_key: string;
        recipient: string;
        task_type: string;
        idempotency_key: string;
        repeat_reason: string | null;
      }>(
        `SELECT id, status, sender, body, subject_key, recipient, task_type, idempotency_key, repeat_reason
           FROM agent_dispatch_messages WHERE subject_key = $1 ORDER BY seq`,
        [subject]
      )
    ).rows.filter(r => (JSON.parse(r.body) as { headSha: string }).headSha === headSha);
  }

  test('5: one new row at the same head carries the failed row body and the operator reason', async () => {
    const failedId = await seedFailedRow(head);
    await seedFailedRow(other, 'a new head was pushed');
    // The push path would only ever return the failed row for this head: prove the premise.
    const replay = await dispatch.createAuthenticatedMessage(
      { kind: 'system', sender: 'overseer' },
      {
        correlation_id: `pr-review:${repository}#${pr}@${head}`,
        idempotency_key: `pr-review:${repository}#${pr}@${head}`,
        task_type: 'run_review',
        recipient: 'overseer-reviewer',
        body: body(head),
        subject_key: subject,
        repeat_reason: 'reopened',
      }
    );
    expect(replay.id).toBe(failedId);
    expect((await rowsAtHead(head)).length).toBe(1);

    const port = storePort();
    const result = await reEnqueue(port, input);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(
      /^REENQUEUED row=\S+ head=db7f98818ee0\S+ prior=\S+:failed sender=operator$/
    );
    const rows = await rowsAtHead(head);
    expect(rows.length).toBe(2);
    const created = rows[1];
    expect(created?.id).not.toBe(failedId);
    expect(created?.status).toBe('queued');
    expect(created?.sender).toBe('operator');
    expect(created?.body).toBe(rows[0]?.body ?? '');
    expect(created?.subject_key).toBe(subject);
    expect(created?.recipient).toBe('overseer-reviewer');
    expect(created?.task_type).toBe('run_review');
    expect(created?.idempotency_key).toBe(`pr-rereview:${repository}#${pr}@${head}:2`);
    expect(created?.repeat_reason?.startsWith('operator_request:rereview_failed:')).toBe(true);
    expect(created?.repeat_reason?.endsWith(reason)).toBe(true);
    // The other head was not touched.
    expect((await rowsAtHead(other)).length).toBe(1);
    // --show reads the new row.
    const shown = await show(port, repository, pr, head);
    expect(shown.length).toBe(2);
    expect(shown[1]).toContain('queued');
    expect(shown[0]).toContain('review_incomplete/review_body_credential_leak');
  });

  test('6: it cannot pile up: a second run is refused and two at once create one row', async () => {
    await seedFailedRow(head);
    const first = await reEnqueue(storePort(), input);
    expect(first.lines.join(' | ')).toContain('REENQUEUED');
    expect(first.code).toBe(0);
    const second = await reEnqueue(storePort(), input);
    expect(second.code).toBe(2);
    expect(second.lines[0]).toContain('already pending');
    expect((await rowsAtHead(head)).length).toBe(2);

    await db.query('DELETE FROM agent_dispatch_messages');
    await seedFailedRow(head);
    const [a, b] = await Promise.all([
      reEnqueue(storePort(), input),
      reEnqueue(storePort(), input),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    expect((await rowsAtHead(head)).length).toBe(2);
  });

  test('a dry run reads and prints but sends nothing', async () => {
    await seedFailedRow(head);
    const port = storePort();
    const result = await reEnqueue(port, input, { dryRun: true });
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('DRY RUN');
    expect(port.sent.length).toBe(0);
    expect((await rowsAtHead(head)).length).toBe(1);
  });
});

describe('http port', () => {
  test('lists the review rows of the subject and posts the message with the operator token header', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return Response.json({ id: 'new-row', status: 'queued' });
      return Response.json([row('failed')]);
    }) as unknown as typeof fetch;
    const port = createHttpPort('http://localhost:3090', 'placeholder-token', fakeFetch);
    const r = await reEnqueue(port, input);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toContain('REENQUEUED row=new-row');
    expect(calls[0]?.url).toBe(
      `http://localhost:3090/api/dispatch/messages?recipient=overseer-reviewer&subject_key=${encodeURIComponent(subject)}&limit=500`
    );
    expect((calls[0]?.init?.headers as Record<string, string>)['x-archon-operator-token']).toBe(
      'placeholder-token'
    );
    expect(JSON.parse(String(calls[1]?.init?.body)).sender).toBe('operator');
    // The token never appears in the output.
    expect(r.lines.join('\n')).not.toContain('placeholder-token');
  });

  test('a refused sender stops with a plain line and never retries as the system sender', async () => {
    const fakeFetch = (async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response('{}', { status: 403 })
        : Response.json([row('failed')])) as unknown as typeof fetch;
    const r = await reEnqueue(createHttpPort('http://localhost:3090', undefined, fakeFetch), input);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain('refused the sender operator');
    expect(r.lines[0]).toContain('does not use the system sender');
  });
});

describe('packaging', () => {
  test('8: the image carries the script', () => {
    const dockerfile = readFileSync(join(import.meta.dir, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('scripts/overseer/re-enqueue-review.ts');
  });
});

describe('rebuild-edge sweep', () => {
  const since = '2026-11-12T14:58:52.000Z';
  const until = '2026-11-12T15:03:31.000Z';
  const transport = JSON.stringify({
    disposition: 'submission_failed',
    reason: 'head_recheck_failed:Service Unavailable',
  });

  function failedRow(
    headSha: string,
    completedAt: string,
    resultBody: string,
    id: string
  ): ReviewRow {
    counter += 1;
    return {
      id,
      status: 'failed',
      body: body(headSha),
      created_at: new Date(Date.UTC(2026, 10, 12, 14, 58, counter)).toISOString(),
      seq: counter,
      task_type: 'run_review',
      completed_at: completedAt,
      result_body: resultBody,
    };
  }

  function sweepPort(all: ReviewRow[]): { port: DispatchPort; sent: OutgoingMessage[] } {
    const sent: OutgoingMessage[] = [];
    const port: DispatchPort = {
      list: async subjectKey => all.filter(() => subjectKey === subject),
      listFailed: async () => all.filter(row => row.status === 'failed'),
      send: async message => {
        sent.push(message);
        return { id: `new-${sent.length}`, status: 'queued' };
      },
    };
    return { port, sent };
  }

  test('re-enqueues a head that failed on a transport reason inside the window, once, with the edge reason', async () => {
    // The shape read from PR 101: a failed row, then cancelled duplicates created after it.
    const failed = failedRow(head, '2026-11-12T15:01:51.732Z', transport, 'failed-1');
    const duplicates = Array.from({ length: 3 }, () => row('cancelled', head));
    const { port, sent } = sweepPort([failed, ...duplicates]);

    const result = await edgeSweep(port, { since, until }, { dryRun: false });

    expect(result.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].repeat_reason).toContain(EDGE_SWEEP_REASON);
    expect(sent[0].body).toBe(failed.body);
    expect(result.lines.at(-1)).toBe(
      `EDGE_SWEEP window=${since}..${until} candidates=1 reenqueued=1 refused=0 errors=0`
    );
  });

  test('ignores a failure outside the window and a failure that is a verdict, not transport', async () => {
    const before = failedRow(head, '2026-11-12T14:00:00.000Z', transport, 'before');
    const after = failedRow('c'.repeat(40), '2026-11-12T16:00:00.000Z', transport, 'after');
    const verdict = failedRow(
      'd'.repeat(40),
      '2026-11-12T15:01:00.000Z',
      JSON.stringify({ disposition: 'review_incomplete', reason: 'review_body_credential_leak' }),
      'verdict'
    );
    const { port, sent } = sweepPort([before, after, verdict]);
    const result = await edgeSweep(port, { since, until }, { dryRun: false });
    expect(sent).toHaveLength(0);
    expect(result.lines.at(-1)).toContain('candidates=0 reenqueued=0');
  });

  test('a head that already has a newer finished review is refused and left alone', async () => {
    const failed = failedRow(head, '2026-11-12T15:01:51.732Z', transport, 'failed-2');
    const newer = row('done', head);
    const { port, sent } = sweepPort([failed, newer]);
    const result = await edgeSweep(port, { since, until }, { dryRun: false });
    expect(sent).toHaveLength(0);
    expect(result.code).toBe(0);
    expect(result.lines.at(-1)).toContain('candidates=1 reenqueued=0 refused=1 errors=0');
  });

  test('the same head failing twice is swept once, and a dry run sends nothing', async () => {
    const a = failedRow(head, '2026-11-12T15:00:00.000Z', transport, 'a');
    const b = failedRow(head, '2026-11-12T15:01:00.000Z', transport, 'b');
    const real = sweepPort([a, b]);
    await edgeSweep(real.port, { since, until }, { dryRun: false });
    expect(real.sent).toHaveLength(1);
    const dry = sweepPort([a, b]);
    const result = await edgeSweep(dry.port, { since, until }, { dryRun: true });
    expect(dry.sent).toHaveLength(0);
    expect(result.lines.at(-1)).toContain('(dry run)');
  });

  test('a bad window or a port that cannot list failed rows stops with a plain line', async () => {
    const { port } = sweepPort([]);
    expect((await edgeSweep(port, { since: 'x', until }, { dryRun: false })).code).toBe(2);
    expect((await edgeSweep(port, { since: until, until: since }, { dryRun: false })).code).toBe(2);
    const noList: DispatchPort = {
      list: async () => [],
      send: async () => ({ id: 'x', status: 'queued' }),
    };
    expect((await edgeSweep(noList, { since, until }, { dryRun: false })).code).toBe(1);
  });

  test('the http port pages through the cursor form of the list route', async () => {
    const urls: string[] = [];
    const pages = [
      { messages: [row('failed')], next_after_seq: 7, page_full: true },
      { messages: [row('failed')], next_after_seq: 9, page_full: false },
    ];
    const fetchStub = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    const port = createHttpPort('http://x', 'tok', fetchStub);
    const rows = await port.listFailed?.();
    expect(rows).toHaveLength(2);
    expect(urls[0]).toContain('recipient=overseer-reviewer&after_seq=0&status=failed&limit=500');
    expect(urls[1]).toContain('after_seq=7&status=failed');
  });
});
