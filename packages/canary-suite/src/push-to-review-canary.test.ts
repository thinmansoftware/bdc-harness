import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runPushToReviewCanary } from './push-to-review-canary';

const HEAD = 'c'.repeat(40);
const NOW = Date.parse('2026-09-14T12:00:00.000Z');
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

function insert(
  db: Database,
  input: {
    id: string;
    taskType: string;
    recipient: string;
    body: string;
    status: string;
    createdAt: string;
    correlationId?: string;
  }
): void {
  db.run(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key, repeat_reason)
     VALUES (?, ?, ?, ?, 'overseer', ?, ?, ?, ?, 'gh:thinmansoftware/bdc-harness#806', 'auto_rereview:head_moved:${HEAD}')`,
    [
      input.id,
      input.correlationId ?? `pr-review:thinmansoftware/bdc-harness#806@${HEAD}`,
      input.id,
      input.taskType,
      input.recipient,
      input.body,
      input.status,
      input.createdAt,
    ]
  );
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('C4 push-to-review canary', () => {
  test('GREEN: a synchronize ingest has a run_review row inside the window', async () => {
    const db = fixture();
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'review-1',
      taskType: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'queued',
      createdAt: '2026-09-14T11:59:55.000Z',
      body: JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 806,
        headSha: HEAD,
      }),
    });
    const result = await runPushToReviewCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('RED: deleting the run_review row fails with why_no_review', async () => {
    const db = fixture();
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    const result = await runPushToReviewCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes[0]?.startsWith('c4_review_not_queued:')).toBe(true);
    expect(result.reasonCodes[0]).toContain('no pull_request event received since');
  });

  test('RED: an older run_review at the same head created before the ingest fails with why_no_review', async () => {
    const db = fixture();
    insert(db, {
      id: 'review-old',
      taskType: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'queued',
      createdAt: '2026-09-14T11:59:40.000Z',
      body: JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 806,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    const result = await runPushToReviewCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes[0]?.startsWith('c4_review_not_queued:')).toBe(true);
    expect(result.evidenceRefs.some(value => value.startsWith('why_no_review='))).toBe(true);
  });

  test('RED: a run_review for a different PR at the same head fails with why_no_review', async () => {
    const db = fixture();
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'review-other-pr',
      taskType: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'queued',
      createdAt: '2026-09-14T11:59:55.000Z',
      correlationId: `pr-review:thinmansoftware/bdc-harness#999@${HEAD}`,
      body: JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 999,
        headSha: HEAD,
      }),
    });
    const result = await runPushToReviewCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes[0]?.startsWith('c4_review_not_queued:')).toBe(true);
    expect(result.evidenceRefs.some(value => value.startsWith('why_no_review='))).toBe(true);
  });

  test('named PR ignores a newer ingest on an unrelated PR', async () => {
    const db = fixture();
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'review-1',
      taskType: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'queued',
      createdAt: '2026-09-14T11:59:55.000Z',
      body: JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 806,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'ingest-999',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:59.000Z',
      correlationId: `pr-review:thinmansoftware/bdc-harness#999@${HEAD}`,
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 999,
      }),
    });
    const result = await runPushToReviewCanary({
      db,
      now: () => NOW,
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 806,
    });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('unscoped mode fails with the offending owner/repo#N', async () => {
    const db = fixture();
    insert(db, {
      id: 'ingest-1',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:50.000Z',
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'review-1',
      taskType: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'queued',
      createdAt: '2026-09-14T11:59:55.000Z',
      body: JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 806,
        headSha: HEAD,
      }),
    });
    insert(db, {
      id: 'ingest-999',
      taskType: 'run_report',
      recipient: 'operator',
      status: 'done',
      createdAt: '2026-09-14T11:59:59.000Z',
      correlationId: `pr-review:thinmansoftware/bdc-harness#999@${HEAD}`,
      body: JSON.stringify({
        kind: 'pr_review_ingest_receipt',
        disposition: 'queued',
        reason: null,
        headSha: HEAD,
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 999,
      }),
    });
    const result = await runPushToReviewCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes[0]).toBe(
      'c4_review_not_queued:thinmansoftware/bdc-harness#999:no pull_request event received since ' +
        HEAD
    );
  });
});
