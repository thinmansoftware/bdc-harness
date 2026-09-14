import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runRepeatSendCanary } from './repeat-send-canary';

const SUBJECT = 'gh:thinmansoftware/bdc-harness#806';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
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
    headSha: string;
    status: string;
    repeatReason: string | null;
    createdAt: string;
  }
): void {
  db.run(
    `INSERT INTO agent_dispatch_messages
     (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, subject_key, repeat_reason)
     VALUES (?, ?, ?, 'run_review', 'overseer', 'overseer-reviewer', ?, ?, ?, ?, ?)`,
    [
      input.id,
      `pr-review:thinmansoftware/bdc-harness#806@${input.headSha}`,
      input.id,
      JSON.stringify({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        prNumber: 806,
        headSha: input.headSha,
      }),
      input.status,
      input.createdAt,
      SUBJECT,
      input.repeatReason,
    ]
  );
}

function enqueueWithReason(db: Database, repeatReason: string | null): () => Promise<void> {
  return async () => {
    const prior = db
      .query<
        { id: string },
        [string]
      >(`SELECT id FROM agent_dispatch_messages WHERE subject_key = ? AND status IN ('done', 'failed') LIMIT 1`)
      .get(SUBJECT);
    if (prior && !repeatReason?.trim()) {
      throw new Error('enqueue_failed:repeat_reason_required');
    }
    insert(db, {
      id: 'queued-1',
      headSha: HEAD_B,
      status: 'queued',
      repeatReason,
      createdAt: '2026-09-14T12:00:01.000Z',
    });
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('C2 repeat-send canary', () => {
  test('GREEN: enqueue at a terminal subject keeps a queued row with repeat_reason', async () => {
    const db = fixture();
    insert(db, {
      id: 'done-1',
      headSha: HEAD_A,
      status: 'done',
      repeatReason: null,
      createdAt: '2026-09-14T11:00:00.000Z',
    });
    const result = await runRepeatSendCanary({
      db,
      subjectKey: SUBJECT,
      enqueue: enqueueWithReason(db, 'operator_request:canary'),
    });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('RED: stripping repeat_reason refuses the enqueue', async () => {
    const db = fixture();
    insert(db, {
      id: 'done-1',
      headSha: HEAD_A,
      status: 'done',
      repeatReason: null,
      createdAt: '2026-09-14T11:00:00.000Z',
    });
    const result = await runRepeatSendCanary({
      db,
      subjectKey: SUBJECT,
      enqueue: enqueueWithReason(db, null),
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c2_repeat_send_refused');
  });
});
