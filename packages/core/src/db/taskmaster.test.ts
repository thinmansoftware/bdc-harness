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
  abandonAdoptionSnapshot,
  beginAdoptionSnapshot,
  commitAdoptionSnapshot,
  expireParkedActions,
  getActionByIdempotencyKey,
  getActionsSince,
  getAdoption,
  getAdoptionMeta,
  getHealthSample,
  getPauseState,
  gradeAction,
  recordAction,
  recordUsageSample,
  setPauseState,
  updateActionOutcome,
  upsertAdoptionRow,
  upsertHealthSample,
  type TmAdoptionRow,
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
      thread_ref: 'gh:thinmansoftware/bdc-harness#1',
      action_type: 'nudge',
      proposal_json: '{"type":"nudge"}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-harness#1:1',
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

  test('recordAction returns one logical row for repeated idempotency keys', async () => {
    const input = {
      thread_ref: 'digest:2026-08-09',
      action_type: 'digest' as const,
      proposal_json: '{"type":"digest"}',
      idempotency_key: 'tm:digest:2026-08-09',
      proof_deadline_at: new Date(Date.now() + 86_400_000).toISOString(),
      outcome: 'pending' as const,
    };

    const first = await recordAction(input);
    const second = await recordAction(input);

    expect(second.id).toBe(first.id);
    expect(
      (await getActionsSince(new Date(0).toISOString())).filter(
        row => row.idempotency_key === input.idempotency_key
      )
    ).toHaveLength(1);
  });

  test('recordAction remains compatible with a live-style unique idempotency index', async () => {
    await db.query(
      'CREATE UNIQUE INDEX uq_tm_journal_idempotency_test ON tm_journal(idempotency_key) WHERE idempotency_key IS NOT NULL'
    );
    const input = {
      thread_ref: 'gh:thinmansoftware/bdc-xo#1450',
      action_type: 'nudge' as const,
      proposal_json: '{"type":"nudge"}',
      idempotency_key: 'tm:nudge:gh:thinmansoftware/bdc-xo#1450:1',
      outcome: 'pending' as const,
    };

    const first = await recordAction(input);
    const second = await recordAction(input);

    expect(second.id).toBe(first.id);
    expect(
      (await getActionsSince(new Date(0).toISOString())).filter(
        row => row.idempotency_key === input.idempotency_key
      )
    ).toHaveLength(1);
  });

  test('getActionByIdempotencyKey is not limited by journal lookback time', async () => {
    const row = await recordAction({
      thread_ref: 'dispatch:old-ruling',
      action_type: 'deliver_ruling',
      proposal_json: '{}',
      idempotency_key: 'tm:deliver_ruling:old-ruling',
      outcome: 'sent',
    });
    await db.query('UPDATE tm_journal SET created_at = $1 WHERE id = $2', [
      '2020-01-01T00:00:00.000Z',
      row.id,
    ]);

    expect((await getActionByIdempotencyKey('tm:deliver_ruling:old-ruling'))?.id).toBe(row.id);
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

function baseAdoptionRow(
  overrides: Partial<Omit<TmAdoptionRow, 'snapshot_id'>> & { thread_ref: string }
): Omit<TmAdoptionRow, 'snapshot_id'> {
  return {
    repo: 'thinmansoftware/bdc-xo',
    issue_number: 1,
    title: 't',
    priority: 'P2',
    labels_json: '[]',
    owner_login: null,
    is_blocked: 0,
    blocked_reason: null,
    next_action: null,
    latest_marker_kind: null,
    latest_marker_at: null,
    state: 'open',
    last_movement_at: null,
    last_movement_kind: null,
    attempts_24h: 0,
    attempts_total: 0,
    evidence_observed_at: new Date().toISOString(),
    source_updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('tm_adoption DAL', () => {
  test('adoption: begin upsert commit exposes rows via getAdoption', async () => {
    const snap = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({
        thread_ref: 'gh:thinmansoftware/bdc-xo#1',
        title: 'One',
        issue_number: 1,
      })
    );
    await upsertAdoptionRow(
      snap,
      baseAdoptionRow({
        thread_ref: 'gh:thinmansoftware/bdc-xo#2',
        title: 'Two',
        issue_number: 2,
      })
    );
    // Uncommitted snapshot is not readable via getAdoption.
    expect(await getAdoption()).toHaveLength(0);

    await commitAdoptionSnapshot(snap, 'abc123');
    const rows = await getAdoption();
    expect(rows).toHaveLength(2);
    const meta = await getAdoptionMeta();
    expect(meta?.committed_snapshot_id).toBe(snap);
    expect(meta?.row_count).toBe(2);
    expect(meta?.source_commit).toBe('abc123');
    expect(meta?.complete).toBe(1);
  });

  test('adoption: abandon drops partial rows and leaves committed snapshot', async () => {
    const good = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      good,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#9', title: 'Good' })
    );
    await commitAdoptionSnapshot(good);

    const bad = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      bad,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#10', title: 'Partial' })
    );
    await abandonAdoptionSnapshot(bad);

    const meta = await getAdoptionMeta();
    expect(meta?.committed_snapshot_id).toBe(good);
    const rows = await getAdoption();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Good');

    // Ensure abandoned snapshot rows are gone.
    const leftover = await db.query<{ c: number }>(
      'SELECT COUNT(*) AS c FROM tm_adoption WHERE snapshot_id = $1',
      [bad]
    );
    expect(Number(leftover.rows[0].c)).toBe(0);
  });

  test('adoption: commit retires prior snapshot rows atomically via withTransaction', async () => {
    const first = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      first,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#1', title: 'First' })
    );
    await commitAdoptionSnapshot(first);

    const second = await beginAdoptionSnapshot();
    await upsertAdoptionRow(
      second,
      baseAdoptionRow({ thread_ref: 'gh:thinmansoftware/bdc-xo#1', title: 'Second' })
    );
    await commitAdoptionSnapshot(second);

    const rows = await getAdoption();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Second');
    expect(rows[0].snapshot_id).toBe(second);

    const all = await db.query<{ c: number }>('SELECT COUNT(*) AS c FROM tm_adoption');
    expect(Number(all.rows[0].c)).toBe(1);
  });

  test('adoption: rebuild from empty reproduces deterministic state', async () => {
    const deterministic = {
      thread_ref: 'gh:thinmansoftware/bdc-xo#42',
      repo: 'thinmansoftware/bdc-xo',
      issue_number: 42,
      title: 'Rebuild me',
      priority: 'P1',
      labels_json: '["wo","prio:P1"]',
      owner_login: 'major-build',
      is_blocked: 1,
      blocked_reason: '[BLOCKED] waiting',
      next_action: null,
      latest_marker_kind: 'BLOCKED' as const,
      last_movement_at: '2026-08-01T00:00:00.000Z',
      last_movement_kind: 'assigned' as const,
      source_updated_at: '2026-08-02T00:00:00.000Z',
      state: 'open',
    };

    const snap1 = await beginAdoptionSnapshot();
    await upsertAdoptionRow(snap1, baseAdoptionRow(deterministic));
    await commitAdoptionSnapshot(snap1);
    const first = await getAdoption();
    expect(first).toHaveLength(1);

    // Delete all adoption state (simulates wipe).
    await db.query('DELETE FROM tm_adoption');
    await db.query(
      `UPDATE tm_adoption_meta
       SET committed_snapshot_id = NULL, rebuilt_at = NULL, row_count = NULL,
           source_commit = NULL, complete = 0
       WHERE id = 1`
    );
    expect(await getAdoption()).toHaveLength(0);

    // Rebuild from the same deterministic inputs.
    const snap2 = await beginAdoptionSnapshot();
    await upsertAdoptionRow(snap2, baseAdoptionRow(deterministic));
    await commitAdoptionSnapshot(snap2);
    const second = await getAdoption();
    expect(second).toHaveLength(1);

    const cols = [
      'thread_ref',
      'repo',
      'issue_number',
      'title',
      'state',
      'priority',
      'labels_json',
      'owner_login',
      'is_blocked',
      'blocked_reason',
      'next_action',
      'latest_marker_kind',
      'last_movement_at',
      'last_movement_kind',
      'source_updated_at',
    ] as const;
    for (const col of cols) {
      expect(second[0][col]).toEqual(first[0][col]);
    }
    // snapshot_id differs by construction
    expect(second[0].snapshot_id).not.toBe(first[0].snapshot_id);
  });
});
