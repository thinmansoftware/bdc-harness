import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runOrphanedRecipientCanary } from './orphaned-recipient-canary';

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const databases: Database[] = [];

function fixture(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE agent_dispatch_messages (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL DEFAULT 'c',
    idempotency_key TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'run_review',
    sender TEXT NOT NULL DEFAULT 'overseer',
    recipient TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE agent_dispatch_workers (
    worker_id TEXT PRIMARY KEY,
    host TEXT NOT NULL DEFAULT 'test',
    capabilities TEXT NOT NULL DEFAULT '{}',
    max_concurrency INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    last_heartbeat_at TEXT NOT NULL
  )`);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('C5 orphaned-recipient canary', () => {
  test('GREEN: a 25h queued row with a live worker is not orphaned', async () => {
    const db = fixture();
    db.run(
      `INSERT INTO agent_dispatch_messages (id, idempotency_key, recipient, status, created_at)
       VALUES ('q1', 'k1', 'overseer-review-route', 'queued', ?)`,
      [new Date(NOW - 25 * 60 * 60 * 1000).toISOString()]
    );
    db.run(
      `INSERT INTO agent_dispatch_workers (worker_id, capabilities, status, last_heartbeat_at)
       VALUES ('overseer-review-route', '{"principal":"overseer-review-route"}', 'available', ?)`,
      [new Date(NOW).toISOString()]
    );
    const result = await runOrphanedRecipientCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('RED: a 25h queued overseer-review-route row with no live worker fails', async () => {
    const db = fixture();
    db.run(
      `INSERT INTO agent_dispatch_messages (id, idempotency_key, recipient, status, created_at)
       VALUES ('q1', 'k1', 'overseer-review-route', 'queued', ?)`,
      [new Date(NOW - 25 * 60 * 60 * 1000).toISOString()]
    );
    const result = await runOrphanedRecipientCanary({ db, now: () => NOW });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c5_orphaned_recipient:overseer-review-route');
  });
});
