import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PriorReviewWork } from '@archon/overseer/pr-review-ingest';
import {
  AUTO_REREVIEW_REASON_PREFIX,
  MAX_REREVIEW_ATTEMPTS_ENV,
} from '@archon/overseer/pr-review-ingest';
import { runConvergingPrCanary } from './converging-pr-canary';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const SUBJECT_KEY = 'gh:thinmansoftware/bdc-harness#806';
const databases: Database[] = [];

function fixture(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE agent_dispatch_messages (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    task_type TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    subject_key TEXT,
    repeat_reason TEXT
  )`);
  databases.push(db);
  return db;
}

function insertReview(
  db: Database,
  input: { id: string; headSha: string; createdAt: string; repeatReason: string | null }
): void {
  db.run(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key, repeat_reason)
     VALUES (?, ?, ?, 'run_review', 'overseer', 'overseer-reviewer', ?, 'done', ?, ?, ?)`,
    [
      input.id,
      `pr-review:thinmansoftware/bdc-harness#806@${input.headSha}`,
      input.id,
      JSON.stringify({ headSha: input.headSha, headCiGreen: true }),
      input.createdAt,
      SUBJECT_KEY,
      input.repeatReason,
    ]
  );
  db.run(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key, repeat_reason)
     VALUES (?, ?, ?, 'run_report', 'overseer', 'operator', ?, 'queued', ?, ?, NULL)`,
    [
      `submit-${input.id}`,
      `pr-review:thinmansoftware/bdc-harness#806@${input.headSha}`,
      `submit-${input.id}`,
      JSON.stringify({
        kind: 'pr_review_submit_receipt',
        messageId: input.id,
        disposition: 'changes_requested',
      }),
      input.createdAt,
      SUBJECT_KEY,
    ]
  );
}

function insertExhaustedReceipt(db: Database, headSha: string, createdAt: string): void {
  db.run(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key, repeat_reason)
     VALUES (?, ?, ?, 'run_report', 'overseer', 'operator', ?, 'queued', ?, ?, NULL)`,
    [
      `exhausted-${createdAt}`,
      `pr-review:thinmansoftware/bdc-harness#806@${headSha}`,
      `exhausted-${createdAt}`,
      JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        headSha,
        disposition: 'blocked',
        reason: 'rereview_attempts_exhausted',
      }),
      createdAt,
      SUBJECT_KEY,
    ]
  );
}

// initial (non-auto) at A, then two judged automatic re-reviews at B and C: converging.
function seedConvergingHistory(db: Database): void {
  insertReview(db, {
    id: 'initial',
    headSha: HEAD_A,
    createdAt: '2026-09-14T10:00:00.000Z',
    repeatReason: null,
  });
  insertReview(db, {
    id: 'auto-1',
    headSha: HEAD_B,
    createdAt: '2026-09-14T11:00:00.000Z',
    repeatReason: `${AUTO_REREVIEW_REASON_PREFIX}${HEAD_B} re-review`,
  });
  insertReview(db, {
    id: 'auto-2',
    headSha: HEAD_C,
    createdAt: '2026-09-14T12:00:00.000Z',
    repeatReason: `${AUTO_REREVIEW_REASON_PREFIX}${HEAD_C} re-review`,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function work(overrides: Partial<PriorReviewWork>): PriorReviewWork {
  return {
    messageId: 'review-1',
    headSha: HEAD_A,
    status: 'done',
    verdict: 'changes_requested',
    verdictId: 'verdict-1',
    isAutoRereview: false,
    headCiGreen: false,
    ...overrides,
  };
}

function convergingPrior(): PriorReviewWork[] {
  return [
    work({
      messageId: 'auto-2',
      headSha: HEAD_C,
      isAutoRereview: true,
      headCiGreen: true,
    }),
    work({
      messageId: 'auto-1',
      headSha: HEAD_B,
      isAutoRereview: true,
      headCiGreen: true,
    }),
    work({ messageId: 'initial', headSha: HEAD_A }),
  ];
}

const subject = {
  id: 'gh:thinmansoftware/bdc-harness#806',
  prior: convergingPrior(),
  currentHead: HEAD_C,
  currentHeadCiGreen: true,
};

describe('C1 converging-PR canary', () => {
  test('GREEN: a converging PR stays under the default consecutive budget', async () => {
    const result = await runConvergingPrCanary({ subjects: [subject], env: {} });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('an exhaustion receipt at the CURRENT head with nothing after it fails the subject', async () => {
    const db = fixture();
    seedConvergingHistory(db);
    insertExhaustedReceipt(db, HEAD_C, '2026-09-14T12:30:00.000Z');
    const result = await runConvergingPrCanary({ db, env: {} });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c1_budget_exhausted_on_converging_pr');
    expect(result.evidenceRefs).toContain('exhausted_receipt=true');
  });

  test('an exhaustion receipt for an OLDER head is history, not exhaustion', async () => {
    const db = fixture();
    seedConvergingHistory(db);
    insertExhaustedReceipt(db, HEAD_B, '2026-09-14T11:30:00.000Z');
    const result = await runConvergingPrCanary({ db, env: {} });
    expect(result.verdict).toBe('passed');
    expect(result.evidenceRefs).toContain('exhausted_receipt=false');
  });

  test('a later non-automatic review re-arms the budget and retires the receipt', async () => {
    const db = fixture();
    seedConvergingHistory(db);
    insertExhaustedReceipt(db, HEAD_C, '2026-09-14T12:30:00.000Z');
    insertReview(db, {
      id: 'operator-1',
      headSha: HEAD_C,
      createdAt: '2026-09-14T13:00:00.000Z',
      repeatReason: 'operator_request:rearm',
    });
    const result = await runConvergingPrCanary({ db, env: {} });
    expect(result.verdict).toBe('passed');
    expect(result.evidenceRefs).toContain('exhausted_receipt=false');
    expect(result.evidenceRefs).toContain('consecutive=0');
  });

  test('RED: OVERSEER_MAX_REREVIEW_ATTEMPTS=1 exhausts a converging PR', async () => {
    const result = await runConvergingPrCanary({
      subjects: [subject],
      env: { [MAX_REREVIEW_ATTEMPTS_ENV]: '1' },
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c1_budget_exhausted_on_converging_pr');
  });
});
