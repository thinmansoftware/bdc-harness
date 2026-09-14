import { afterEach, describe, expect, mock, test } from 'bun:test';
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

  test('observe mode (no --c2-live-enqueue): never POSTs, blocked when nothing is queued', async () => {
    const db = fixture();
    const fetcher = mock(async () => new Response('{}', { status: 200 }));
    const result = await runRepeatSendCanary({
      db,
      subjectKey: SUBJECT,
      requestUrl: 'http://localhost:3090/api/overseer/pr-review/request',
      operatorToken: 'operator-token',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 806,
      headSha: HEAD_B,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCodes).toEqual(['c2_live_enqueue_not_enabled']);
  });

  test('observe mode passes on an already-queued row that carries repeat_reason', async () => {
    const db = fixture();
    insert(db, {
      id: 'queued-1',
      headSha: HEAD_B,
      status: 'queued',
      repeatReason: 'operator_request:earlier',
      createdAt: '2026-09-14T12:00:01.000Z',
    });
    const fetcher = mock(async () => new Response('{}', { status: 200 }));
    const result = await runRepeatSendCanary({
      db,
      subjectKey: SUBJECT,
      requestUrl: 'http://localhost:3090/api/overseer/pr-review/request',
      operatorToken: 'operator-token',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 806,
      headSha: HEAD_B,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.verdict).toBe('passed');
    expect(result.evidenceRefs).toContain('mode=observe');
  });

  test('--c2-live-enqueue POSTs the request with the operator token', async () => {
    const db = fixture();
    const fetcher = mock(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { headSha: string };
      insert(db, {
        id: 'queued-live',
        headSha: body.headSha,
        status: 'queued',
        repeatReason: 'operator_request:canary_repeat_send',
        createdAt: '2026-09-14T12:00:02.000Z',
      });
      return new Response('{"ok":true}', { status: 200 });
    });
    const result = await runRepeatSendCanary({
      db,
      c2LiveEnqueue: true,
      subjectKey: SUBJECT,
      requestUrl: 'http://localhost:3090/api/overseer/pr-review/request',
      operatorToken: 'operator-token',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 806,
      headSha: HEAD_B,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3090/api/overseer/pr-review/request');
    expect((init.headers as Record<string, string>)['x-archon-operator-token']).toBe(
      'operator-token'
    );
    expect(result.verdict).toBe('passed');
    expect(result.evidenceRefs).toContain('mode=enqueue');
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
