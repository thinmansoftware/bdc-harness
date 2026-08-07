import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  expireParkedActions,
  getActionsSince,
  getHealthSample,
  getPauseState,
  gradeAction,
  recordAction,
  recordUsageSample,
  setPauseState,
  updateActionOutcome,
  upsertHealthSample,
} from './taskmaster';

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

beforeEach(() => {
  currentDbPath = join(tmpdir(), `taskmaster-test-${Date.now()}-${Math.random()}.db`);
  db = new SqliteAdapter(currentDbPath);
});

afterEach(async () => {
  await db.close();
  cleanupDb(currentDbPath);
});

describe('tm_journal DAL', () => {
  test('recordAction writes a row-first pending entry and updateActionOutcome flips it', async () => {
    const row = await recordAction({
      thread_ref: 'gh:bluedevilcollectibles/bdc-harness#1',
      action_type: 'nudge',
      proposal_json: '{"type":"nudge"}',
      idempotency_key: 'tm:nudge:gh:bluedevilcollectibles/bdc-harness#1:1',
      before_hash: 'abc',
      proof_predicate: 'dispatch row exists',
      proof_deadline_at: new Date(Date.now() + 86_400_000).toISOString(),
      outcome: 'pending',
    });
    expect(row.id.length).toBeGreaterThan(0);
    expect(row.outcome).toBe('pending');
    expect(row.grade).toBeNull();

    const updated = await updateActionOutcome(row.id, 'sent');
    expect(updated?.outcome).toBe('sent');
  });

  test('getActionsSince filters by time and optionally by thread_ref', async () => {
    await recordAction({
      thread_ref: 'thread-a',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'sent',
    });
    await recordAction({
      thread_ref: 'thread-b',
      action_type: 'escalate_p0',
      proposal_json: '{}',
      outcome: 'sent',
    });

    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    const all = await getActionsSince(longAgo);
    expect(all.length).toBe(2);
    const onlyB = await getActionsSince(longAgo, 'thread-b');
    expect(onlyB.length).toBe(1);
    expect(onlyB[0]?.action_type).toBe('escalate_p0');

    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await getActionsSince(future)).length).toBe(0);
  });

  test('gradeAction stamps grade and graded_at after external verification', async () => {
    const row = await recordAction({
      thread_ref: 'thread-a',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      outcome: 'sent',
    });
    const graded = await gradeAction(row.id, 'useful');
    expect(graded?.grade).toBe('useful');
    expect(graded?.graded_at).not.toBeNull();
  });

  test('expireParkedActions expires parked and pending rows only', async () => {
    await recordAction({
      thread_ref: 't1',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'parked',
    });
    await recordAction({
      thread_ref: 't2',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'pending',
    });
    await recordAction({
      thread_ref: 't3',
      action_type: 'nudge',
      proposal_json: '{}',
      outcome: 'sent',
    });
    const expired = await expireParkedActions();
    expect(expired).toBe(2);
    const rows = await getActionsSince(new Date(Date.now() - 3_600_000).toISOString());
    expect(rows.filter(r => r.outcome === 'expired').length).toBe(2);
    expect(rows.filter(r => r.outcome === 'sent').length).toBe(1);
  });
});

describe('tm_control DAL', () => {
  test('getPauseState returns the seeded RUNNING singleton', async () => {
    const control = await getPauseState();
    expect(control.pause_state).toBe('RUNNING');
    expect(control.epoch).toBe(0);
  });

  test('setPauseState pauses without epoch change; resume increments epoch', async () => {
    const paused = await setPauseState({
      pause_state: 'PAUSED',
      pause_reason: 'operator request',
      pause_actor: 'john',
    });
    expect(paused.pause_state).toBe('PAUSED');
    expect(paused.epoch).toBe(0);

    const resumed = await setPauseState({
      pause_state: 'RUNNING',
      pause_actor: 'john',
      incrementEpoch: true,
    });
    expect(resumed.pause_state).toBe('RUNNING');
    expect(resumed.epoch).toBe(1);
  });

  test('HARD_PAUSE (auto-circuit) is a valid tightened state', async () => {
    const hard = await setPauseState({
      pause_state: 'HARD_PAUSE',
      pause_scope: 'effects',
      pause_reason: 'forbidden effect',
      pause_actor: 'taskmaster:auto-circuit',
    });
    expect(hard.pause_state).toBe('HARD_PAUSE');
    expect(hard.pause_scope).toBe('effects');
  });
});

describe('tm_health DAL', () => {
  test('upsert + read within expiry; expired samples read as null', async () => {
    await upsertHealthSample({
      provider: 'claude',
      state: 'healthy',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      evidence: 'probe ok',
    });
    const sample = await getHealthSample('claude');
    expect(sample?.state).toBe('healthy');

    await upsertHealthSample({
      provider: 'codex',
      state: 'dark',
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await getHealthSample('codex')).toBeNull();
  });
});

describe('tm_usage_sample DAL', () => {
  test('a failed meter is persisted as is_unknown=1 with null value, never zero', async () => {
    const sample = await recordUsageSample({
      provider: 'claude',
      window_kind: 'rolling',
      source: 'none',
      value_json: null,
      confidence: 'none',
      is_unknown: true,
    });
    expect(sample.is_unknown).toBe(1);
    expect(sample.value_json).toBeNull();
  });

  test('a real observation persists its value with is_unknown=0', async () => {
    const sample = await recordUsageSample({
      provider: 'claude',
      window_kind: 'rolling',
      source: 'local_artifacts',
      value_json: JSON.stringify({ tokensRemaining: 123_456 }),
      confidence: 'high',
      is_unknown: false,
    });
    expect(sample.is_unknown).toBe(0);
    expect(sample.value_json).toContain('123456');
  });
});
