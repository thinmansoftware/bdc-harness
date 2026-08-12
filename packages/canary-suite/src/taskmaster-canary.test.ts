import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runTaskmasterCanarySuite,
  runTaskmasterHeartbeatCheck,
  runTaskmasterSyntheticIdempotencyCheck,
  writeTaskmasterCanaryArtifacts,
} from './taskmaster-canary';

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const REPO = 'bluedevilcollectibles/bdc-xo';
const ISSUE = 777;
const PREFIX = `tm:nudge:gh:${REPO}#${ISSUE}:`;
const databases: Database[] = [];

function fixture(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE tm_journal (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    thread_ref TEXT NOT NULL,
    action_type TEXT NOT NULL,
    idempotency_key TEXT,
    outcome TEXT NOT NULL
  )`);
  databases.push(db);
  return db;
}

function insert(
  db: Database,
  id: string,
  createdAt: number,
  idempotencyKey: string | null = null,
  outcome = 'sent'
): void {
  db.run(
    'INSERT INTO tm_journal (id, created_at, thread_ref, action_type, idempotency_key, outcome) VALUES (?, ?, ?, ?, ?, ?)',
    [id, new Date(createdAt).toISOString(), `gh:${REPO}#${ISSUE}`, 'nudge', idempotencyKey, outcome]
  );
}

const baseDeps = { now: () => NOW, intervalMs: 60_000, githubRepo: REPO, githubIssue: ISSUE };

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('Taskmaster Level 0 canaries', () => {
  test('heartbeat passes for a fresh journal row', async () => {
    const db = fixture();
    insert(db, 'fresh', NOW - 30_000);
    const result = await runTaskmasterHeartbeatCheck({ ...baseDeps, db });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('heartbeat fails with evidence for a stale journal row', async () => {
    const db = fixture();
    insert(db, 'stale', NOW - 300_000);
    const result = await runTaskmasterHeartbeatCheck({ ...baseDeps, db });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('tick_heartbeat_stale');
    expect(result.evidenceRefs).toContain('age_ms=300000');
  });

  test('heartbeat treats interval zero as the killed sentinel', async () => {
    const db = fixture();
    insert(db, 'pre-kill', NOW - 1);
    const result = await runTaskmasterHeartbeatCheck({ ...baseDeps, intervalMs: 0, db });
    expect(result.verdict).toBe('failed');
    expect(result.evidenceRefs).toContain('threshold_ms=0');
  });

  test('heartbeat fails closed when tm_journal is empty', async () => {
    const result = await runTaskmasterHeartbeatCheck({ ...baseDeps, db: fixture() });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('tm_journal_empty');
  });

  test('synthetic idempotency passes for one recent sent nudge', async () => {
    const db = fixture();
    insert(db, 'one', NOW - 60_000, `${PREFIX}123`);
    const result = await runTaskmasterSyntheticIdempotencyCheck({ ...baseDeps, db });
    expect(result.verdict).toBe('passed');
  });

  test('synthetic idempotency detects duplicate sent outcomes for one key', async () => {
    const db = fixture();
    insert(db, 'duplicate-1', NOW - 60_000, `${PREFIX}123`);
    insert(db, 'duplicate-2', NOW - 30_000, `${PREFIX}123`);
    const result = await runTaskmasterSyntheticIdempotencyCheck({ ...baseDeps, db });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('synthetic_target_duplicate_nudge_same_key');
  });

  test('synthetic idempotency fails when no target nudge exists', async () => {
    const result = await runTaskmasterSyntheticIdempotencyCheck({ ...baseDeps, db: fixture() });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('synthetic_target_no_nudge_in_window');
  });

  test('suite is non-mutating', async () => {
    const db = fixture();
    insert(db, 'immutable', NOW - 30_000, `${PREFIX}123`);
    const before = db.query<{ 'COUNT(*)': number }, []>('SELECT COUNT(*) FROM tm_journal').get()!;

    await runTaskmasterCanarySuite({ ...baseDeps, db });

    const after = db.query<{ 'COUNT(*)': number }, []>('SELECT COUNT(*) FROM tm_journal').get()!;
    expect(after['COUNT(*)']).toBe(before['COUNT(*)']);
  });

  test('writes the suite report beneath the canary artifact root', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'taskmaster-canary-'));
    const report = {
      verdict: 'failed' as const,
      reasonCodes: ['tick_heartbeat_stale'],
      evidenceRefs: ['threshold_ms=0'],
    };
    try {
      const paths = await writeTaskmasterCanaryArtifacts(outputRoot, report);
      expect(paths).toHaveLength(1);
      expect(paths[0]?.startsWith(outputRoot)).toBe(true);
      expect(JSON.parse(await readFile(paths[0]!, 'utf8'))).toEqual(report);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
