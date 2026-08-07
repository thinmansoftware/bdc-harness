import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAdapter } from './adapters/sqlite';

let db: SqliteAdapter;
let currentDbPath = '';

mock.module('./connection', () => ({
  getDatabase: () => db,
}));

import {
  countInterventionsSince,
  getActionByIdempotencyKey,
  getActionsSince,
  getHealthSample,
  getPauseState,
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
  const dir = mkdtempSync(join(tmpdir(), 'tm-dal-'));
  currentDbPath = join(dir, 'tm.db');
  db = new SqliteAdapter(currentDbPath);
});

afterEach(async () => {
  await db.close();
  cleanupDb(currentDbPath);
});

describe('taskmaster DAL: tm_journal', () => {
  test('recordAction writes a row-first tm_journal entry then dedupes on idempotency_key', async () => {
    const first = await recordAction({
      thread_ref: 'wo/42',
      action_type: 'nudge',
      proposal_json: JSON.stringify({ kind: 'nudge' }),
      idempotency_key: 'tm:nudge:wo/42:1',
    });
    expect(first.outcome).toBe('proposed');
    expect(first.action_type).toBe('nudge');

    // Same key -> returns the SAME row, no second insert (restart-safe).
    const second = await recordAction({
      thread_ref: 'wo/42',
      action_type: 'nudge',
      proposal_json: JSON.stringify({ kind: 'nudge' }),
      idempotency_key: 'tm:nudge:wo/42:1',
    });
    expect(second.id).toBe(first.id);

    const all = await getActionsSince('1970-01-01T00:00:00.000Z');
    expect(all.length).toBe(1);
  });

  test('updateActionOutcome flips outcome and stamps grade', async () => {
    const row = await recordAction({
      thread_ref: 'wo/7',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver:wo/7:1',
    });
    await updateActionOutcome(row.id, 'sent', 'useful');
    const found = await getActionByIdempotencyKey('tm:deliver:wo/7:1');
    expect(found?.outcome).toBe('sent');
    expect(found?.grade).toBe('useful');
    expect(found?.graded_at).not.toBeNull();
  });

  test('countInterventionsSince counts only sent rows for the thread', async () => {
    const a = await recordAction({
      thread_ref: 'wo/9',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:wo/9:1',
    });
    await updateActionOutcome(a.id, 'sent');
    // A parked proposal must NOT spend the 24h budget.
    const b = await recordAction({
      thread_ref: 'wo/9',
      action_type: 'nudge',
      proposal_json: '{}',
      idempotency_key: 'tm:nudge:wo/9:2',
    });
    await updateActionOutcome(b.id, 'parked');
    const count = await countInterventionsSince('wo/9', '1970-01-01T00:00:00.000Z');
    expect(count).toBe(1);
  });
});

describe('taskmaster DAL: tm_control pause/epoch', () => {
  test('control singleton defaults to RUNNING at epoch 0', async () => {
    const state = await getPauseState();
    expect(state.pause_state).toBe('RUNNING');
    expect(state.epoch).toBe(0);
  });

  test('pausing does not change epoch; resume increments epoch (expire, never replay)', async () => {
    await setPauseState({ pause_state: 'PAUSED', pause_actor: 'john' });
    const paused = await getPauseState();
    expect(paused.pause_state).toBe('PAUSED');
    expect(paused.epoch).toBe(0);

    const resumed = await setPauseState({ pause_state: 'RUNNING', pause_actor: 'john' });
    expect(resumed.pause_state).toBe('RUNNING');
    expect(resumed.epoch).toBe(1);
  });
});

describe('taskmaster DAL: tm_health', () => {
  test('getHealthSample returns latest non-expired sample and ignores expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    await upsertHealthSample({ provider: 'claude', state: 'dark', expires_at: past });
    expect(await getHealthSample('claude')).toBeNull();

    const future = new Date(Date.now() + 60_000).toISOString();
    await upsertHealthSample({ provider: 'claude', state: 'healthy', expires_at: future });
    const sample = await getHealthSample('claude');
    expect(sample?.state).toBe('healthy');
  });
});

describe('taskmaster DAL: tm_usage_sample', () => {
  test('recordUsageSample persists is_unknown for a failed meter read', async () => {
    await recordUsageSample({ provider: 'claude', source: 'ledger', is_unknown: true });
    const result = await db.query<{ is_unknown: number }>(
      'SELECT is_unknown FROM tm_usage_sample ORDER BY observed_at DESC LIMIT 1'
    );
    expect(Number(result.rows[0]?.is_unknown)).toBe(1);
  });
});
