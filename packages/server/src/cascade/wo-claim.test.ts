import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { findActiveWoClaim, retainWoClaim } from '@archon/core/db/cascade-wo-claims';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { cascadeWoClaimDeps, reconcileRetainedWoClaims, type ClaimRunReader } from './wo-claim';

const oldArchonHome = process.env.ARCHON_HOME;
const oldDatabaseUrl = process.env.DATABASE_URL;
let currentHome = '';

type Rec = {
  status: string;
  attempts?: { runId?: string }[];
  frontierApproval?: { resumeCascadeId?: string };
};

function recordsReader(table: Record<string, Rec | null>): never {
  return (async (cascadeId: string) => table[cascadeId] ?? null) as never;
}

function runsReader(
  table: Record<string, { status: string; approvalHandOff?: boolean } | null>
): ClaimRunReader {
  return async runId => {
    const row = table[runId];
    return row ? { status: row.status, approvalHandOff: row.approvalHandOff === true } : null;
  };
}

async function claimRow(woId: string): Promise<Record<string, unknown> | undefined> {
  const res = await getDatabase().query(
    'SELECT * FROM cascade_wo_claims WHERE wo_id = $1 ORDER BY claimed_at DESC',
    [woId]
  );
  return res.rows[0] as Record<string, unknown> | undefined;
}

function plainDeps(holder: string, records = {}, runs = {}): ReturnType<typeof cascadeWoClaimDeps> {
  return cascadeWoClaimDeps(holder, undefined, {
    readRecord: recordsReader(records),
    readRun: runsReader(runs),
  });
}

describe('cascadeWoClaimDeps / reconcileRetainedWoClaims (real sqlite)', () => {
  beforeEach(async () => {
    await closeDatabase();
    resetDatabase();
    currentHome = mkdtempSync(join(tmpdir(), 'wo-claim-test-'));
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

  test('acquire records the holder and returns a db: path and running record', async () => {
    const deps = plainDeps('taskmaster');
    const res = await deps.acquireWoLock('WO-A-01', 'bdc-harness', 'casc-1', '/out');
    expect(res.acquired).toBe(true);
    expect(res.path).toBe('db:cascade_wo_claims:WO-A-01');
    expect(res.record).toMatchObject({
      woId: 'WO-A-01',
      project: 'bdc-harness',
      cascadeId: 'casc-1',
      status: 'running',
    });
    expect(await claimRow('WO-A-01')).toMatchObject({
      cascade_id: 'casc-1',
      holder: 'taskmaster',
      state: 'active',
      retained_reason: null,
    });
  });

  test('a second cascade for the same WO is refused and sees the first cascade as holder', async () => {
    const tm = plainDeps('taskmaster');
    const t3 = plainDeps('t3-consumer');
    expect((await tm.acquireWoLock('WO-A-01', 'bdc-harness', 'casc-1', '/out')).acquired).toBe(
      true
    );
    const refused = await t3.acquireWoLock('WO-A-01', 'bdc-harness', 'casc-2', '/out');
    expect(refused.acquired).toBe(false);
    expect(refused.record.cascadeId).toBe('casc-1');
    expect((await findActiveWoClaim('WO-A-01'))?.holder).toBe('taskmaster');
    // a different WO is independent
    expect((await t3.acquireWoLock('WO-B-01', 'bdc-harness', 'casc-3', '/out')).acquired).toBe(
      true
    );
  });

  test('replayed acquire by the same cascade is idempotent', async () => {
    const deps = plainDeps('taskmaster');
    expect((await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out')).acquired).toBe(true);
    expect((await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out')).acquired).toBe(true);
  });

  test('release on a terminal cascade whose runs are all terminal frees the WO', async () => {
    const deps = plainDeps(
      'taskmaster',
      { 'casc-1': { status: 'won', attempts: [{ runId: 'r1' }, { runId: 'r2' }, {}] } },
      { r1: { status: 'failed' }, r2: { status: 'completed' } }
    );
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await deps.releaseWoLock('WO-A-01', 'p', 'casc-1', '/out');
    expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    const row = await claimRow('WO-A-01');
    expect(row?.state).toBe('released');
    expect(typeof row?.released_at).toBe('string');
    // a different cascade can now take it
    expect((await deps.acquireWoLock('WO-A-01', 'p', 'casc-9', '/out')).acquired).toBe(true);
  });

  test.each(['running', 'pending-frontier-approval', 'frontier-approved', 'recovery-delegated'])(
    'release RETAINS the claim with reason %s and the run ids',
    async status => {
      const deps = plainDeps(
        'taskmaster',
        { 'casc-1': { status, attempts: [{ runId: 'r1' }] } },
        { r1: { status: 'completed' } }
      );
      await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
      await deps.releaseWoLock('WO-A-01', 'p', 'casc-1', '/out');
      const claim = await findActiveWoClaim('WO-A-01');
      expect(claim?.retained_reason).toBe(status);
      expect(claim?.run_ids_json).toBe('["r1"]');
    }
  );

  test('release retains with run_not_terminal when a run is still live', async () => {
    const deps = plainDeps(
      'taskmaster',
      { 'casc-1': { status: 'lost', attempts: [{ runId: 'r1' }, { runId: 'r2' }] } },
      { r1: { status: 'completed' }, r2: { status: 'running' } }
    );
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await deps.releaseWoLock('WO-A-01', 'p', 'casc-1', '/out');
    const claim = await findActiveWoClaim('WO-A-01');
    expect(claim?.retained_reason).toBe('run_not_terminal');
    expect(claim?.run_ids_json).toBe('["r1","r2"]');
  });

  test('release retains when a failed run is an approval hand-off or a run row is missing', async () => {
    const handOff = plainDeps(
      'taskmaster',
      { 'casc-1': { status: 'lost', attempts: [{ runId: 'r1' }] } },
      { r1: { status: 'failed', approvalHandOff: true } }
    );
    await handOff.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await handOff.releaseWoLock('WO-A-01', 'p', 'casc-1', '/out');
    expect((await findActiveWoClaim('WO-A-01'))?.retained_reason).toBe('run_not_terminal');

    const missing = plainDeps('taskmaster', {
      'casc-2': { status: 'lost', attempts: [{ runId: 'gone' }] },
    });
    await missing.acquireWoLock('WO-B-01', 'p', 'casc-2', '/out');
    await missing.releaseWoLock('WO-B-01', 'p', 'casc-2', '/out');
    expect((await findActiveWoClaim('WO-B-01'))?.retained_reason).toBe('run_not_terminal');
  });

  test('release retains with record_missing and empty run ids when the record cannot be read', async () => {
    const deps = cascadeWoClaimDeps('taskmaster', undefined, {
      readRecord: (async () => {
        throw new Error('disk gone');
      }) as never,
      readRun: runsReader({}),
    });
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await deps.releaseWoLock('WO-A-01', 'p', 'casc-1', '/out');
    const claim = await findActiveWoClaim('WO-A-01');
    expect(claim?.retained_reason).toBe('record_missing');
    expect(claim?.run_ids_json).toBe('[]');
  });

  test('releasing a cascade that does not hold the claim does not release the holder', async () => {
    const deps = plainDeps('taskmaster', { 'casc-other': { status: 'won', attempts: [] } });
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await deps.releaseWoLock('WO-A-01', 'p', 'casc-other', '/out');
    const claim = await findActiveWoClaim('WO-A-01');
    expect(claim?.cascade_id).toBe('casc-1');
    expect(claim?.retained_reason).toBeNull();
  });

  test('frontier-approved retained claim transfers to the resume cascade on acquire', async () => {
    const deps = plainDeps('taskmaster', {
      'casc-1': {
        status: 'frontier-approved',
        attempts: [{ runId: 'r1' }],
        frontierApproval: { resumeCascadeId: 'casc-resume' },
      },
    });
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await retainWoClaim({
      woId: 'WO-A-01',
      cascadeId: 'casc-1',
      reason: 'frontier-approved',
      runIds: ['r1'],
    });
    const resumed = await deps.acquireWoLock('WO-A-01', 'p', 'casc-resume', '/out');
    expect(resumed.acquired).toBe(true);
    expect(resumed.record.cascadeId).toBe('casc-resume');
    const claim = await findActiveWoClaim('WO-A-01');
    expect(claim?.cascade_id).toBe('casc-resume');
    expect(claim?.retained_reason).toBeNull();
  });

  test('retained claim is NOT transferred to a cascade other than the named resume cascade', async () => {
    const deps = plainDeps('taskmaster', {
      'casc-1': {
        status: 'frontier-approved',
        frontierApproval: { resumeCascadeId: 'casc-resume' },
      },
    });
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await retainWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', reason: 'x', runIds: [] });
    const intruder = await deps.acquireWoLock('WO-A-01', 'p', 'casc-intruder', '/out');
    expect(intruder.acquired).toBe(false);
    expect((await findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-1');
  });

  test('a retained claim whose record is pending-frontier-approval is not transferred', async () => {
    const deps = plainDeps('taskmaster', {
      'casc-1': {
        status: 'pending-frontier-approval',
        frontierApproval: { resumeCascadeId: 'casc-resume' },
      },
    });
    await deps.acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
    await retainWoClaim({ woId: 'WO-A-01', cascadeId: 'casc-1', reason: 'x', runIds: [] });
    expect((await deps.acquireWoLock('WO-A-01', 'p', 'casc-resume', '/out')).acquired).toBe(false);
  });

  describe('reconcileRetainedWoClaims', () => {
    async function seedRetained(woId: string, cascadeId: string, runIds: string[]): Promise<void> {
      await plainDeps('taskmaster').acquireWoLock(woId, 'p', cascadeId, '/out');
      await retainWoClaim({ woId, cascadeId, reason: 'run_not_terminal', runIds });
    }

    test('releases a retained claim whose every run is now terminal and returns its WO id', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1', 'r2']);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'lost' } }),
        readRun: runsReader({ r1: { status: 'completed' }, r2: { status: 'cancelled' } }),
      });
      expect(released).toEqual(['WO-A-01']);
      expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    });

    test('releases a claim retained at frontier approval once the operator rejects the tier', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1']);
      const pending = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'pending-frontier-approval' } }),
        readRun: runsReader({ r1: { status: 'completed' } }),
      });
      expect(pending).toEqual([]);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'frontier-rejected' } }),
        readRun: runsReader({ r1: { status: 'completed' } }),
      });
      expect(released).toEqual(['WO-A-01']);
      expect(await findActiveWoClaim('WO-A-01')).toBeNull();
    });

    test('also releases when the record is missing but runs are terminal', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1']);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({}),
        readRun: runsReader({ r1: { status: 'escalated' } }),
      });
      expect(released).toEqual(['WO-A-01']);
    });

    test('keeps the claim while any run is still live', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1', 'r2']);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'lost' } }),
        readRun: runsReader({ r1: { status: 'completed' }, r2: { status: 'running' } }),
      });
      expect(released).toEqual([]);
      expect((await findActiveWoClaim('WO-A-01'))?.cascade_id).toBe('casc-1');
    });

    test('keeps the claim when a run is an approval hand-off or its row is missing', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1']);
      await seedRetained('WO-B-01', 'casc-2', ['gone']);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({}),
        readRun: runsReader({ r1: { status: 'failed', approvalHandOff: true } }),
      });
      expect(released).toEqual([]);
    });

    test.each(['pending-frontier-approval', 'frontier-approved', 'recovery-delegated'])(
      'keeps the claim when the cascade record is still resumable (%s) even if runs are terminal',
      async status => {
        await seedRetained('WO-A-01', 'casc-1', ['r1']);
        const released = await reconcileRetainedWoClaims(undefined, {
          readRecord: recordsReader({ 'casc-1': { status } }),
          readRun: runsReader({ r1: { status: 'completed' } }),
        });
        expect(released).toEqual([]);
        expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
      }
    );

    test('a record in status running does NOT block reconcile (only run proof counts)', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1']);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'running' } }),
        readRun: runsReader({ r1: { status: 'completed' } }),
      });
      expect(released).toEqual(['WO-A-01']);
    });

    test('a retained claim with no run ids is left for operator release', async () => {
      await seedRetained('WO-A-01', 'casc-1', []);
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'lost' } }),
        readRun: runsReader({}),
      });
      expect(released).toEqual([]);
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });

    test('a corrupt run_ids_json is skipped, not released', async () => {
      await seedRetained('WO-A-01', 'casc-1', ['r1']);
      await getDatabase().query(
        "UPDATE cascade_wo_claims SET run_ids_json = 'not json' WHERE wo_id = 'WO-A-01'"
      );
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'lost' } }),
        readRun: runsReader({ r1: { status: 'completed' } }),
      });
      expect(released).toEqual([]);
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });

    test('active claims that were never retained are ignored', async () => {
      await plainDeps('taskmaster').acquireWoLock('WO-A-01', 'p', 'casc-1', '/out');
      const released = await reconcileRetainedWoClaims(undefined, {
        readRecord: recordsReader({ 'casc-1': { status: 'lost' } }),
        readRun: runsReader({}),
      });
      expect(released).toEqual([]);
      expect(await findActiveWoClaim('WO-A-01')).not.toBeNull();
    });
  });
});
