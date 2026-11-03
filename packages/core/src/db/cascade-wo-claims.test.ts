import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import * as claims from './cascade-wo-claims';

const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
let currentHome = '';

const T0 = '2026-11-03T12:00:00.000Z';
const T1 = '2026-11-03T12:00:05.000Z';

function acquire(woId: string, cascadeId: string, holder = 'taskmaster') {
  return claims.acquireWoClaim({ woId, project: 'bdc-harness', cascadeId, holder, now: T0 });
}

describe('cascade WO claims (real sqlite, WO-HARNESS-T3-COMMAND-CONSUMER-01 A5.0)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-cascade-wo-claims-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = currentHome;
    delete process.env.DATABASE_URL;
    expect(getDatabase().dialect).toBe('sqlite');
  });

  afterEach(async () => {
    await closeDatabase();
    resetDatabase();
    if (oldArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = oldArchonHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    removeTempDirWithRetry(currentHome);
  });

  test('acquire creates an active claim that findActiveWoClaim returns', async () => {
    expect(await claims.findActiveWoClaim('WO-A-01')).toBeNull();
    const res = await acquire('WO-A-01', 'casc-1');
    expect(res.acquired).toBe(true);
    expect(res.claim).toMatchObject({
      wo_id: 'WO-A-01',
      project: 'bdc-harness',
      cascade_id: 'casc-1',
      holder: 'taskmaster',
      state: 'active',
      claimed_at: T0,
      released_at: null,
      retained_reason: null,
      run_ids_json: '[]',
    });
    expect((await claims.findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-1');
  });

  test('same cascade re-acquires idempotently; a different cascade is refused and sees the holder', async () => {
    await acquire('WO-A-01', 'casc-1');
    const replay = await acquire('WO-A-01', 'casc-1');
    expect(replay.acquired).toBe(true);
    expect(replay.claim?.cascade_id).toBe('casc-1');

    const other = await acquire('WO-A-01', 'casc-2', 't3-consumer');
    expect(other.acquired).toBe(false);
    expect(other.claim).toMatchObject({ cascade_id: 'casc-1', holder: 'taskmaster' });

    const rows = await getDatabase().query('SELECT * FROM cascade_wo_claims WHERE wo_id = $1', [
      'WO-A-01',
    ]);
    expect(rows.rows.length).toBe(1);
  });

  test('different WOs are independent', async () => {
    expect((await acquire('WO-A-01', 'casc-1')).acquired).toBe(true);
    expect((await acquire('WO-B-01', 'casc-2')).acquired).toBe(true);
  });

  test('release: wrong cascade cannot release; holder releases once; row is retained as released', async () => {
    await acquire('WO-A-01', 'casc-1');
    expect(await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-2', now: T1 })).toBe(
      false
    );
    expect((await claims.findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-1');

    expect(await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', now: T1 })).toBe(
      true
    );
    expect(await claims.findActiveWoClaim('WO-A-01')).toBeNull();
    expect(await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', now: T1 })).toBe(
      false
    );
    const rows = await getDatabase().query<{ state: string; released_at: string }>(
      'SELECT state, released_at FROM cascade_wo_claims WHERE wo_id = $1',
      ['WO-A-01']
    );
    expect(rows.rows).toEqual([{ state: 'released', released_at: T1 }]);
  });

  test('after release a new cascade can claim the WO and history rows accumulate', async () => {
    await acquire('WO-A-01', 'casc-1');
    await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', now: T1 });
    const next = await acquire('WO-A-01', 'casc-2');
    expect(next.acquired).toBe(true);
    const rows = await getDatabase().query('SELECT * FROM cascade_wo_claims WHERE wo_id = $1', [
      'WO-A-01',
    ]);
    expect(rows.rows.length).toBe(2);
  });

  test('retainWoClaim records reason and run ids for the holder only; listRetainedWoClaims returns it', async () => {
    await acquire('WO-A-01', 'casc-1');
    await acquire('WO-B-01', 'casc-2');
    expect(await claims.listRetainedWoClaims()).toEqual([]);
    expect(
      await claims.retainWoClaim({
        woId: 'WO-A-01',
        cascadeId: 'casc-other',
        reason: 'nope',
        runIds: ['x'],
      })
    ).toBe(false);
    expect(
      await claims.retainWoClaim({
        woId: 'WO-A-01',
        cascadeId: 'casc-1',
        reason: 'paused_for_approval',
        runIds: ['run-1', 'run-2'],
      })
    ).toBe(true);
    const retained = await claims.listRetainedWoClaims();
    expect(retained.length).toBe(1);
    expect(retained[0]).toMatchObject({
      wo_id: 'WO-A-01',
      retained_reason: 'paused_for_approval',
    });
    expect(JSON.parse(retained[0].run_ids_json)).toEqual(['run-1', 'run-2']);
  });

  test('retain on a released claim is a no-op and released claims are not listed as retained', async () => {
    await acquire('WO-A-01', 'casc-1');
    await claims.retainWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', reason: 'r', runIds: [] });
    await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', now: T1 });
    expect(
      await claims.retainWoClaim({
        woId: 'WO-A-01',
        cascadeId: 'casc-1',
        reason: 'again',
        runIds: [],
      })
    ).toBe(false);
    expect(await claims.listRetainedWoClaims()).toEqual([]);
  });

  test('transferWoClaim moves the active claim from the original cascade and clears retention', async () => {
    await acquire('WO-A-01', 'casc-1');
    await claims.retainWoClaim({
      woId: 'WO-A-01',
      cascadeId: 'casc-1',
      reason: 'r',
      runIds: ['a'],
    });
    expect(
      await claims.transferWoClaim({
        woId: 'WO-A-01',
        fromCascadeId: 'wrong',
        toCascadeId: 'casc-2',
      })
    ).toBe(false);
    expect(
      await claims.transferWoClaim({
        woId: 'WO-A-01',
        fromCascadeId: 'casc-1',
        toCascadeId: 'casc-2',
      })
    ).toBe(true);
    const claim = await claims.findActiveWoClaim('WO-A-01');
    expect(claim?.cascade_id).toBe('casc-2');
    expect(claim?.retained_reason).toBeNull();
    // run_ids_json is NOT cleared by transfer
    expect(JSON.parse(claim?.run_ids_json ?? '[]')).toEqual(['a']);
  });

  describe('takeOverWoClaimForResume', () => {
    const base = {
      woId: 'WO-A-01',
      project: 'bdc-harness',
      originalCascadeId: 'casc-1',
      resumeCascadeId: 'casc-2',
      holder: 't3-consumer',
      now: T1,
    };

    test('transfers when the original cascade still holds the claim (holder column unchanged)', async () => {
      await acquire('WO-A-01', 'casc-1', 'taskmaster');
      expect(await claims.takeOverWoClaimForResume(base)).toBe(true);
      const claim = await claims.findActiveWoClaim('WO-A-01');
      expect(claim?.cascade_id).toBe('casc-2');
      expect(claim?.holder).toBe('taskmaster');
    });

    test('claims fresh when no cascade holds the WO (never claimed, or released)', async () => {
      expect(await claims.takeOverWoClaimForResume(base)).toBe(true);
      expect(await claims.findActiveWoClaim('WO-A-01')).toMatchObject({
        cascade_id: 'casc-2',
        holder: 't3-consumer',
        claimed_at: T1,
      });
      await claims.releaseWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-2', now: T1 });
      expect(await claims.takeOverWoClaimForResume({ ...base, resumeCascadeId: 'casc-3' })).toBe(
        true
      );
      expect((await claims.findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-3');
    });

    test('is refused when a different cascade holds the WO and leaves the claim untouched', async () => {
      await acquire('WO-A-01', 'casc-9', 'taskmaster');
      expect(await claims.takeOverWoClaimForResume(base)).toBe(false);
      expect((await claims.findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-9');
    });

    test('is idempotent when the resume cascade already holds the claim', async () => {
      await acquire('WO-A-01', 'casc-2', 't3-consumer');
      expect(await claims.takeOverWoClaimForResume(base)).toBe(true);
      expect((await claims.findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-2');
    });
  });
});
