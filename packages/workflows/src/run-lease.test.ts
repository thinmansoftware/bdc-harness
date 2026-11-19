import { expect, mock, test } from 'bun:test';
import type { IWorkflowStore } from './store';
import { clearRunLeaseLossesForTests, getRunLeaseLoss, withRunLease } from './run-lease';

test('legacy run without authority executes without claiming a lease', async () => {
  const store = {
    getRunAuthority: mock(async () => null),
    claimRunLease: mock(async () => null),
  } as unknown as IWorkflowStore;

  await expect(withRunLease(store, 'run-1', async () => 'ok')).resolves.toBe('ok');
  expect(store.claimRunLease).not.toHaveBeenCalled();
});

test('authority-bound run claims and releases its lease around execution', async () => {
  const store = {
    getRunAuthority: mock(async () => ({ runId: 'run-1' })),
    claimRunLease: mock(async lease => lease),
    heartbeatRunLease: mock(async () => true),
    releaseRunLease: mock(async () => true),
    getWorkflowRun: mock(async () => ({
      id: 'run-1',
      status: 'completed',
      metadata: { teardown_confirmed_at: '2026-07-09T20:00:00.000Z', teardown_survivors: [] },
    })),
  } as unknown as IWorkflowStore;
  const now = mock(() => new Date('2026-07-09T20:00:00.000Z'));

  await expect(
    withRunLease(store, 'run-1', async isValid => isValid(), {
      ownerId: 'worker-1',
      leaseToken: 'token-1',
      now,
    })
  ).resolves.toBe(true);
  expect(store.claimRunLease).toHaveBeenCalledTimes(1);
  expect(store.releaseRunLease).toHaveBeenCalledWith({
    runId: 'run-1',
    ownerId: 'worker-1',
    leaseToken: 'token-1',
    releasedAt: '2026-07-09T20:00:00.000Z',
  });
});

test('competing worker cannot enter the operation', async () => {
  const operation = mock(async () => 'should-not-run');
  const store = {
    getRunAuthority: mock(async () => ({ runId: 'run-1' })),
    claimRunLease: mock(async () => null),
  } as unknown as IWorkflowStore;

  await expect(
    withRunLease(store, 'run-1', operation, {
      ownerId: 'worker-2',
      leaseToken: 'token-2',
    })
  ).rejects.toThrow('run_lease_conflict');
  expect(operation).not.toHaveBeenCalled();
});

test('lost heartbeat stops the validity guard and preserves the expired lease for recovery', async () => {
  const releaseRunLease = mock(async () => true);
  const store = {
    getRunAuthority: mock(async () => ({ runId: 'run-1' })),
    claimRunLease: mock(async lease => lease),
    heartbeatRunLease: mock(async () => false),
    releaseRunLease,
  } as unknown as IWorkflowStore;

  const valid = await withRunLease(
    store,
    'run-1',
    async isValid => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return isValid();
    },
    { heartbeatIntervalMs: 5 }
  );

  expect(valid).toBe(false);
  expect(store.heartbeatRunLease).toHaveBeenCalled();
  expect(releaseRunLease).not.toHaveBeenCalled();
});

test('release failure cannot replace a successful workflow result', async () => {
  const store = {
    getRunAuthority: mock(async () => ({ runId: 'run-1' })),
    claimRunLease: mock(async lease => lease),
    heartbeatRunLease: mock(async () => true),
    releaseRunLease: mock(async () => {
      throw new Error('database unavailable');
    }),
  } as unknown as IWorkflowStore;

  await expect(withRunLease(store, 'run-1', async () => 'completed')).resolves.toBe('completed');
});

test('unknown final run state keeps the lease (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01)', async () => {
  for (const getWorkflowRun of [
    mock(async () => {
      throw new Error('database unavailable');
    }),
    mock(async () => null),
  ]) {
    const releaseRunLease = mock(async () => true);
    const store = {
      getRunAuthority: mock(async () => ({ runId: 'run-1' })),
      claimRunLease: mock(async lease => lease),
      heartbeatRunLease: mock(async () => true),
      releaseRunLease,
      getWorkflowRun,
    } as unknown as IWorkflowStore;
    await expect(withRunLease(store, 'run-1', async isValid => isValid())).resolves.toBe(true);
    expect(getWorkflowRun).toHaveBeenCalled();
    expect(releaseRunLease).not.toHaveBeenCalled();
  }
});

// WO-HARNESS-RUN-LEASE-LOST-SAYS-SO-01 (bdc-xo#5695): a lost lease is recorded with the measured numbers.
const BASE = Date.parse('2026-11-12T17:50:41.372Z');

function leaseStore(heartbeat: () => Promise<boolean>): IWorkflowStore {
  return {
    getRunAuthority: mock(async () => ({ runId: 'run-1' })),
    claimRunLease: mock(async lease => lease),
    heartbeatRunLease: mock(heartbeat),
    releaseRunLease: mock(async () => true),
    getWorkflowRun: mock(async () => ({ id: 'run-1', status: 'running', metadata: {} })),
  } as unknown as IWorkflowStore;
}

async function untilInvalid(isValid: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && isValid(); i += 1)
    await new Promise(resolve => setTimeout(resolve, 5));
}

test('a refused renewal records reason, last renewal, expiry and detection time', async () => {
  clearRunLeaseLossesForTests();
  let heartbeats = 0;
  const store = leaseStore(async () => {
    heartbeats += 1;
    return heartbeats === 1;
  });
  // The clock moves 20 s on every read: acquire = BASE, first heartbeat = BASE + 20 s (renewed, expiry
  // BASE + 80 s), second heartbeat = BASE + 40 s (refused), detection read = BASE + 60 s.
  let reads = 0;
  const now = (): Date => new Date(BASE + 20_000 * reads++);

  const loss = await withRunLease(
    store,
    'run-1',
    async (isValid, getLoss) => {
      await untilInvalid(isValid);
      return getLoss();
    },
    { ownerId: 'w', leaseToken: 't', heartbeatIntervalMs: 5, now }
  );

  expect(loss).toEqual({
    reason: 'renewal_refused',
    lastRenewedAt: new Date(BASE + 20_000).toISOString(),
    expiresAt: new Date(BASE + 80_000).toISOString(),
    detectedAt: new Date(BASE + 60_000).toISOString(),
  });
  expect(getRunLeaseLoss('run-1')).toEqual(loss);
});

test('a renewal that throws records reason renewal_error', async () => {
  clearRunLeaseLossesForTests();
  const store = leaseStore(async () => {
    throw new Error('store down');
  });

  const loss = await withRunLease(
    store,
    'run-1',
    async (isValid, getLoss) => {
      await untilInvalid(isValid);
      return getLoss();
    },
    { ownerId: 'w', leaseToken: 't', heartbeatIntervalMs: 5 }
  );

  expect(loss?.reason).toBe('renewal_error');
});

test('a healthy lease records nothing', async () => {
  clearRunLeaseLossesForTests();
  const store = leaseStore(async () => true);
  const loss = await withRunLease(
    store,
    'run-1',
    async (_isValid, getLoss) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return getLoss();
    },
    { ownerId: 'w', leaseToken: 't', heartbeatIntervalMs: 5 }
  );
  expect(loss).toBeNull();
  expect(getRunLeaseLoss('run-1')).toBeNull();
});
