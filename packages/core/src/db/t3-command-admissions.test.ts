import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { removeTempDirWithRetry } from '../test/temp-dir';
import { closeDatabase, getDatabase, resetDatabase } from './connection';
import * as adm from './t3-command-admissions';

const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
let currentHome = '';

const T0 = '2026-11-03T12:00:00.000Z';
const T1 = '2026-11-03T12:00:05.000Z';
const T2 = '2026-11-03T12:01:00.000Z';

function fireInput(requestId: string, woId: string, extra: Record<string, unknown> = {}) {
  return {
    request_id: requestId,
    actor_principal_id: 't3-bridge',
    verb: 'fire' as const,
    payload_sha256: 'a'.repeat(64),
    wo_id: woId,
    project: 'bdc-harness',
    source_message_id: `msg-${requestId}`,
    now: T0,
    ...extra,
  };
}

function runCmdInput(requestId: string, verb: 'cancel-own' | 'approve', runId: string) {
  return {
    request_id: requestId,
    actor_principal_id: 't3-bridge',
    verb,
    payload_sha256: 'b'.repeat(64),
    target_run_id: runId,
    source_message_id: `msg-${requestId}`,
    now: T0,
  };
}

describe('t3 command admissions (real sqlite, WO-HARNESS-T3-COMMAND-CONSUMER-01)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = join(
      import.meta.dir,
      `.test-t3-admissions-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

  describe('reserveAdmission', () => {
    test('inserts a reserved row with the supplied identity and null outcome fields', async () => {
      const res = await adm.reserveAdmission(fireInput('r1', 'WO-A-01', { pr_ref: 'o/r#5' }));
      expect(res.status).toBe('reserved');
      if (res.status !== 'reserved') throw new Error('unreachable');
      expect(res.row.state).toBe('reserved');
      expect(res.row.wo_id).toBe('WO-A-01');
      expect(res.row.pr_ref).toBe('o/r#5');
      expect(res.row.head_sha).toBeNull();
      expect(res.row.status_code).toBeNull();
      expect(res.row.effect_started_at).toBeNull();
      expect(res.row.created_at).toBe(T0);
      expect(res.row.updated_at).toBe(T0);
      expect((await adm.getByRequestId('r1'))?.request_id).toBe('r1');
      expect(await adm.getByRequestId('missing')).toBeNull();
    });

    test('duplicate request_id returns exists with the original row, not a lock status', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      const again = await adm.reserveAdmission(
        fireInput('r1', 'WO-OTHER', { payload_sha256: 'c'.repeat(64) })
      );
      expect(again.status).toBe('exists');
      if (again.status !== 'exists') throw new Error('unreachable');
      expect(again.row.wo_id).toBe('WO-A-01');
      expect(again.row.payload_sha256).toBe('a'.repeat(64));
    });

    test('wo_fire_lock: a second fire for the same WO is wo_fire_locked and writes no row', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      const loser = await adm.reserveAdmission(fireInput('r2', 'WO-A-01'));
      expect(loser.status).toBe('wo_fire_locked');
      expect(await adm.getByRequestId('r2')).toBeNull();
      expect((await adm.reserveAdmission(fireInput('r3', 'WO-B-01'))).status).toBe('reserved');
    });

    test('wo_fire_lock is released by admitted but held by unknown', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      expect(await adm.markAdmitted('r1', { status_code: 200, code: 'ok', now: T1 })).toBe(true);
      expect((await adm.reserveAdmission(fireInput('r2', 'WO-A-01'))).status).toBe('reserved');
      expect(await adm.markUnknown('r2', { status_code: 503, code: 'crash', now: T1 })).toBe(true);
      expect((await adm.reserveAdmission(fireInput('r3', 'WO-A-01'))).status).toBe(
        'wo_fire_locked'
      );
    });

    test('run_lock: second cancel-own/approve for the same run is run_locked; other runs are free', async () => {
      expect((await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'))).status).toBe(
        'reserved'
      );
      expect((await adm.reserveAdmission(runCmdInput('c2', 'approve', 'run-1'))).status).toBe(
        'run_locked'
      );
      expect((await adm.reserveAdmission(runCmdInput('c3', 'cancel-own', 'run-2'))).status).toBe(
        'reserved'
      );
      expect(await adm.getByRequestId('c2')).toBeNull();
    });

    test('run_lock releases once the holder is refused', async () => {
      await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'));
      expect(await adm.markRefused('c1', { status_code: 409, code: 'nope', now: T1 })).toBe(true);
      expect((await adm.reserveAdmission(runCmdInput('c2', 'approve', 'run-1'))).status).toBe(
        'reserved'
      );
    });
  });

  describe('state transitions (CAS)', () => {
    test('markAdmitted: reserved -> admitted persists outcome; second call is a lost CAS', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      expect(
        await adm.markAdmitted('r1', {
          status_code: 200,
          code: 'ok',
          cascade_id: 'casc-1',
          run_id: 'run-1',
          now: T1,
        })
      ).toBe(true);
      expect(await adm.getByRequestId('r1')).toMatchObject({
        state: 'admitted',
        status_code: 200,
        code: 'ok',
        cascade_id: 'casc-1',
        run_id: 'run-1',
        updated_at: T1,
      });
      expect(await adm.markAdmitted('r1', { status_code: 201, code: 'x', now: T2 })).toBe(false);
      expect((await adm.getByRequestId('r1'))?.code).toBe('ok');
      expect(await adm.markAdmitted('absent', { status_code: 200, code: 'ok', now: T2 })).toBe(
        false
      );
    });

    test('markRefused: stale CAS from admitted returns false; from reserved persists outcome', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.markAdmitted('r1', { status_code: 200, code: 'ok', now: T1 });
      expect(await adm.markRefused('r1', { status_code: 409, code: 'late', now: T2 })).toBe(false);
      expect((await adm.getByRequestId('r1'))?.state).toBe('admitted');

      await adm.reserveAdmission(fireInput('r2', 'WO-B-01'));
      expect(
        await adm.markRefused('r2', {
          status_code: 409,
          code: 'live_run',
          run_id: 'run-9',
          cascade_id: 'c9',
          now: T1,
        })
      ).toBe(true);
      expect(await adm.getByRequestId('r2')).toMatchObject({
        state: 'refused',
        status_code: 409,
        code: 'live_run',
        run_id: 'run-9',
        cascade_id: 'c9',
      });
    });

    test('markUnknown: COALESCE only adds identity and never clears it', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await getDatabase().query(
        "UPDATE t3_command_admissions SET cascade_id='casc-keep', run_id='run-keep' WHERE request_id='r1'"
      );
      expect(await adm.markUnknown('r1', { status_code: 503, code: 'recover', now: T1 })).toBe(
        true
      );
      expect(await adm.getByRequestId('r1')).toMatchObject({
        state: 'unknown',
        cascade_id: 'casc-keep',
        run_id: 'run-keep',
      });

      await adm.reserveAdmission(fireInput('r2', 'WO-B-01'));
      await adm.markUnknown('r2', {
        status_code: 503,
        code: 'x',
        cascade_id: 'c2',
        run_id: 'run-2',
        now: T1,
      });
      expect(await adm.getByRequestId('r2')).toMatchObject({ cascade_id: 'c2', run_id: 'run-2' });
    });

    test('markUnknown from a non-reserved state is a lost CAS', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.markRefused('r1', { status_code: 409, code: 'x', now: T1 });
      expect(await adm.markUnknown('r1', { status_code: 503, code: 'y', now: T2 })).toBe(false);
      expect((await adm.getByRequestId('r1'))?.state).toBe('refused');
    });

    test('markEffectStarted: CAS only while reserved and unset', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      expect(await adm.markEffectStarted('r1', T1)).toBe(true);
      expect((await adm.getByRequestId('r1'))?.effect_started_at).toBe(T1);
      expect(await adm.markEffectStarted('r1', T2)).toBe(false);
      expect((await adm.getByRequestId('r1'))?.effect_started_at).toBe(T1);

      await adm.reserveAdmission(fireInput('r2', 'WO-B-01'));
      await adm.markRefused('r2', { status_code: 409, code: 'x', now: T1 });
      expect(await adm.markEffectStarted('r2', T2)).toBe(false);
      expect(await adm.markEffectStarted('absent', T2)).toBe(false);
    });

    test('insertRefused writes a terminal refused row and is a no-op on duplicate request_id', async () => {
      const row = await adm.insertRefused({
        ...fireInput('r1', 'WO-A-01'),
        status_code: 409,
        code: 'wo_fire_locked',
      });
      expect(row).toMatchObject({ state: 'refused', status_code: 409, code: 'wo_fire_locked' });
      const dup = await adm.insertRefused({
        ...fireInput('r1', 'WO-A-01'),
        status_code: 500,
        code: 'other',
        now: T2,
      });
      expect(dup.code).toBe('wo_fire_locked');
      expect(dup.created_at).toBe(T0);
      // refused rows do not hold the WO fire lock
      expect((await adm.reserveAdmission(fireInput('r2', 'WO-A-01'))).status).toBe('reserved');
    });

    test('recordReply stores the reply id without changing state', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.recordReply('r1', 'reply-1', T1);
      const row = await adm.getByRequestId('r1');
      expect(row?.reply_message_id).toBe('reply-1');
      expect(row?.state).toBe('reserved');
      expect(row?.updated_at).toBe(T1);
    });
  });

  describe('adjudication', () => {
    async function unknownFire(id: string, wo: string) {
      await adm.reserveAdmission(fireInput(id, wo));
      await adm.markUnknown(id, { status_code: 503, code: 'unproven', now: T1 });
    }

    test('adjudicateUnknownFire no_run -> refused 409 and releases the WO lock', async () => {
      await unknownFire('r1', 'WO-A-01');
      expect((await adm.reserveAdmission(fireInput('r2', 'WO-A-01'))).status).toBe(
        'wo_fire_locked'
      );
      const res = await adm.adjudicateUnknownFire('r1', {
        resolution: 'no_run',
        adjudicated_by: ' john ',
        now: T2,
      });
      expect(res.status).toBe('adjudicated');
      if (res.status !== 'adjudicated') throw new Error('unreachable');
      expect(res.row).toMatchObject({
        state: 'refused',
        status_code: 409,
        code: 'adjudicated_no_run:john',
      });
      expect((await adm.reserveAdmission(fireInput('r3', 'WO-A-01'))).status).toBe('reserved');
    });

    test('adjudicateUnknownFire run -> admitted 200 with trimmed run id; ownsRun becomes true', async () => {
      await unknownFire('r1', 'WO-A-01');
      const res = await adm.adjudicateUnknownFire('r1', {
        resolution: 'run',
        run_id: ' run-77 ',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(res.status).toBe('adjudicated');
      expect(await adm.getByRequestId('r1')).toMatchObject({
        state: 'admitted',
        status_code: 200,
        code: 'ok',
        run_id: 'run-77',
      });
      expect(await adm.ownsRun('t3-bridge', 'run-77')).toBe(true);
    });

    test('adjudicateUnknownFire: not_unknown for admitted rows, not_found for missing, throws on blank input', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.markAdmitted('r1', { status_code: 200, code: 'ok', run_id: 'run-1', now: T1 });
      const notUnknown = await adm.adjudicateUnknownFire('r1', {
        resolution: 'no_run',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(notUnknown.status).toBe('not_unknown');
      if (notUnknown.status === 'not_unknown') expect(notUnknown.row.state).toBe('admitted');
      expect(
        (
          await adm.adjudicateUnknownFire('nope', {
            resolution: 'no_run',
            adjudicated_by: 'john',
            now: T2,
          })
        ).status
      ).toBe('not_found');
      await expect(
        adm.adjudicateUnknownFire('r1', { resolution: 'no_run', adjudicated_by: '  ', now: T2 })
      ).rejects.toThrow('t3_adjudicated_by_required');
      await expect(
        adm.adjudicateUnknownFire('r1', {
          resolution: 'run',
          run_id: ' ',
          adjudicated_by: 'john',
          now: T2,
        })
      ).rejects.toThrow('t3_adjudicated_run_id_required');
    });

    test('adjudicateUnknownFire refuses a cancel-own row (verb guard)', async () => {
      await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'));
      await adm.markUnknown('c1', { status_code: 503, code: 'x', now: T1 });
      const res = await adm.adjudicateUnknownFire('c1', {
        resolution: 'no_run',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(res.status).toBe('not_unknown');
      expect((await adm.getByRequestId('c1'))?.state).toBe('unknown');
    });

    test('adjudicateUnknownRunCommand effect_applied: cancel-own -> ok, approve -> approved_not_resumed, run_id from target', async () => {
      await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'));
      await adm.markUnknown('c1', { status_code: 503, code: 'x', now: T1 });
      await adm.reserveAdmission(runCmdInput('c2', 'approve', 'run-2'));
      await adm.markUnknown('c2', { status_code: 503, code: 'x', now: T1 });

      const a = await adm.adjudicateUnknownRunCommand('c1', {
        resolution: 'effect_applied',
        adjudicated_by: 'john',
        now: T2,
      });
      const b = await adm.adjudicateUnknownRunCommand('c2', {
        resolution: 'effect_applied',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(a.status).toBe('adjudicated');
      expect(b.status).toBe('adjudicated');
      expect(await adm.getByRequestId('c1')).toMatchObject({
        state: 'admitted',
        status_code: 200,
        code: 'ok',
        run_id: 'run-1',
      });
      expect(await adm.getByRequestId('c2')).toMatchObject({
        state: 'admitted',
        code: 'approved_not_resumed',
        run_id: 'run-2',
      });
    });

    test('adjudicateUnknownRunCommand no_effect releases the run lock; repeats and fire rows are not_unknown', async () => {
      await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'));
      await adm.markUnknown('c1', { status_code: 503, code: 'x', now: T1 });
      expect((await adm.reserveAdmission(runCmdInput('c2', 'approve', 'run-1'))).status).toBe(
        'run_locked'
      );
      const res = await adm.adjudicateUnknownRunCommand('c1', {
        resolution: 'no_effect',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(res.status).toBe('adjudicated');
      expect((await adm.getByRequestId('c1'))?.code).toBe('adjudicated_no_effect:john');
      expect((await adm.reserveAdmission(runCmdInput('c3', 'approve', 'run-1'))).status).toBe(
        'reserved'
      );
      const repeat = await adm.adjudicateUnknownRunCommand('c1', {
        resolution: 'no_effect',
        adjudicated_by: 'john',
        now: T2,
      });
      expect(repeat.status).toBe('not_unknown');

      await adm.reserveAdmission(fireInput('f1', 'WO-A-01'));
      await adm.markUnknown('f1', { status_code: 503, code: 'x', now: T1 });
      expect(
        (
          await adm.adjudicateUnknownRunCommand('f1', {
            resolution: 'no_effect',
            adjudicated_by: 'john',
            now: T2,
          })
        ).status
      ).toBe('not_unknown');
      await expect(
        adm.adjudicateUnknownRunCommand('c1', {
          resolution: 'no_effect',
          adjudicated_by: '',
          now: T2,
        })
      ).rejects.toThrow('t3_adjudicated_by_required');
    });
  });

  describe('queries', () => {
    test('findLiveFireForWo returns reserved/unknown, excludes own request_id and admitted rows', async () => {
      expect(await adm.findLiveFireForWo('WO-A-01')).toBeNull();
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      expect((await adm.findLiveFireForWo('WO-A-01'))?.request_id).toBe('r1');
      expect(await adm.findLiveFireForWo('WO-A-01', 'r1')).toBeNull();
      expect((await adm.findLiveFireForWo('WO-A-01', 'other'))?.request_id).toBe('r1');
      await adm.markUnknown('r1', { status_code: 503, code: 'x', now: T1 });
      expect((await adm.findLiveFireForWo('WO-A-01'))?.state).toBe('unknown');
      await adm.adjudicateUnknownFire('r1', {
        resolution: 'run',
        run_id: 'run-1',
        adjudicated_by: 'j',
        now: T2,
      });
      expect(await adm.findLiveFireForWo('WO-A-01')).toBeNull();
    });

    test('findRunLockHolder returns the unresolved holder and honors exclusion', async () => {
      expect(await adm.findRunLockHolder('run-1')).toBeNull();
      await adm.reserveAdmission(runCmdInput('c1', 'approve', 'run-1'));
      expect((await adm.findRunLockHolder('run-1'))?.request_id).toBe('c1');
      expect(await adm.findRunLockHolder('run-1', 'c1')).toBeNull();
      expect(await adm.findRunLockHolder('run-2')).toBeNull();
    });

    test('listReservedFires returns only reserved fires oldest first', async () => {
      await adm.reserveAdmission({ ...fireInput('r2', 'WO-B-01'), now: T1 });
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.reserveAdmission(runCmdInput('c1', 'cancel-own', 'run-1'));
      await adm.reserveAdmission(fireInput('r3', 'WO-C-01'));
      await adm.markAdmitted('r3', { status_code: 200, code: 'ok', now: T1 });
      const rows = await adm.listReservedFires();
      expect(rows.map(r => r.request_id)).toEqual(['r1', 'r2']);
    });

    test('listStaleReservations is strictly older-than, any verb, reserved only', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.reserveAdmission({ ...runCmdInput('c1', 'approve', 'run-1'), now: T2 });
      await adm.reserveAdmission(fireInput('r2', 'WO-B-01'));
      await adm.markAdmitted('r2', { status_code: 200, code: 'ok', now: T0 });
      expect((await adm.listStaleReservations(T1)).map(r => r.request_id)).toEqual(['r1']);
      expect(await adm.listStaleReservations(T0)).toEqual([]);
      const all = await adm.listStaleReservations('2027-01-01T00:00:00.000Z');
      expect(all.map(r => r.request_id)).toEqual(['r1', 'c1']);
    });

    test('listAdmittedFiresForActor is scoped to actor and admitted fires, newest first', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.markAdmitted('r1', { status_code: 200, code: 'ok', now: T1 });
      await adm.reserveAdmission({ ...fireInput('r2', 'WO-B-01'), now: T1 });
      await adm.markAdmitted('r2', { status_code: 200, code: 'ok', now: T2 });
      await adm.reserveAdmission(
        fireInput('r3', 'WO-C-01', { actor_principal_id: 'someone-else' })
      );
      await adm.markAdmitted('r3', { status_code: 200, code: 'ok', now: T1 });
      await adm.reserveAdmission(fireInput('r4', 'WO-D-01'));
      const rows = await adm.listAdmittedFiresForActor('t3-bridge');
      expect(rows.map(r => r.request_id)).toEqual(['r2', 'r1']);
    });
  });

  describe('run custody and ownership', () => {
    test('appendRunCustody round trip, idempotent per run_id, listed oldest first', async () => {
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01'));
      await adm.appendRunCustody({ admission_id: 'r1', run_id: 'run-b', tier: 'opus', now: T1 });
      await adm.appendRunCustody({ admission_id: 'r1', run_id: 'run-a', tier: null, now: T0 });
      await adm.appendRunCustody({ admission_id: 'r1', run_id: 'run-b', tier: 'other', now: T2 });
      expect(await adm.listRunCustody('r1')).toEqual([
        { admission_id: 'r1', run_id: 'run-a', tier: null, discovered_at: T0 },
        { admission_id: 'r1', run_id: 'run-b', tier: 'opus', discovered_at: T1 },
      ]);
      expect(await adm.listRunCustody('nobody')).toEqual([]);
      expect(await adm.hasRunCustody('run-a')).toBe(true);
      expect(await adm.hasRunCustody('run-zzz')).toBe(false);
    });

    test('a run in custody of one admission cannot be re-claimed by another', async () => {
      await adm.appendRunCustody({ admission_id: 'r1', run_id: 'run-a', tier: null, now: T0 });
      await adm.appendRunCustody({ admission_id: 'r2', run_id: 'run-a', tier: null, now: T1 });
      expect(await adm.listRunCustody('r2')).toEqual([]);
      expect((await adm.listRunCustody('r1')).length).toBe(1);
    });

    test('ownsRun / findOwningFireAdmission: admission run_id, custody, actor-scoped, admitted-only', async () => {
      expect(await adm.ownsRun('t3-bridge', '')).toBe(false);
      await adm.reserveAdmission(fireInput('r1', 'WO-A-01', { project: 'proj-1' }));
      await adm.appendRunCustody({ admission_id: 'r1', run_id: 'run-c', tier: null, now: T0 });
      expect(await adm.ownsRun('t3-bridge', 'run-c')).toBe(false);
      expect(await adm.findOwningFireAdmission('t3-bridge', 'run-c')).toBeNull();
      await adm.markAdmitted('r1', { status_code: 200, code: 'ok', run_id: 'run-1', now: T1 });
      expect(await adm.ownsRun('t3-bridge', 'run-1')).toBe(true);
      expect(await adm.ownsRun('t3-bridge', 'run-c')).toBe(true);
      expect(await adm.ownsRun('intruder', 'run-1')).toBe(false);
      expect(await adm.ownsRun('t3-bridge', 'run-unknown')).toBe(false);
      const owner = await adm.findOwningFireAdmission('t3-bridge', 'run-c');
      expect(owner?.request_id).toBe('r1');
      expect(owner?.project).toBe('proj-1');
      expect(await adm.findOwningFireAdmission('intruder', 'run-c')).toBeNull();
    });
  });

  describe('consumer lease', () => {
    async function lease() {
      const r = await getDatabase().query<{ holder: string; expires_at: string }>(
        'SELECT holder, expires_at FROM t3_consumer_lease WHERE id = 1'
      );
      return r.rows[0];
    }

    test('first acquire wins, holder renews and extends expiry', async () => {
      expect(await adm.acquireConsumerLease('A', T0, 30_000)).toBe(true);
      expect(await adm.acquireConsumerLease('A', T1, 60_000)).toBe(true);
      const row = await lease();
      expect(row.holder).toBe('A');
      expect(row.expires_at).toBe(new Date(Date.parse(T1) + 60_000).toISOString());
    });

    test('a second holder is refused while the lease is unexpired and A keeps it unchanged', async () => {
      await adm.acquireConsumerLease('A', T0, 30_000);
      expect(await adm.acquireConsumerLease('B', T1, 30_000)).toBe(false);
      const row = await lease();
      expect(row.holder).toBe('A');
      expect(row.expires_at).toBe(new Date(Date.parse(T0) + 30_000).toISOString());
    });

    test('takeover succeeds after expiry and the old holder is then refused', async () => {
      await adm.acquireConsumerLease('A', T0, 30_000);
      expect(await adm.acquireConsumerLease('B', T2, 30_000)).toBe(true);
      expect(await adm.acquireConsumerLease('A', T2, 30_000)).toBe(false);
    });
  });

  describe('failed attempts', () => {
    test('recordFailedAttempt increments per message, keeps latest error, truncates to 120 chars', async () => {
      expect(await adm.recordFailedAttempt('m1', 'boom', T0)).toBe(1);
      expect(await adm.recordFailedAttempt('m1', 'bang', T1)).toBe(2);
      expect(await adm.recordFailedAttempt('m2', 'x'.repeat(300), T0)).toBe(1);
      expect(await adm.recordFailedAttempt('m1', 'last', T2)).toBe(3);
      const r = await getDatabase().query<{
        message_id: string;
        attempts: number;
        last_error: string;
        updated_at: string;
      }>('SELECT * FROM t3_command_attempts ORDER BY message_id');
      expect(r.rows[0]).toMatchObject({
        message_id: 'm1',
        attempts: 3,
        last_error: 'last',
        updated_at: T2,
      });
      expect(r.rows[1].last_error.length).toBe(120);
    });
  });
});
