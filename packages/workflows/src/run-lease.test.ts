import { expect, mock, test } from 'bun:test';
import type { IWorkflowStore } from './store';
import { withRunLease } from './run-lease';

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
