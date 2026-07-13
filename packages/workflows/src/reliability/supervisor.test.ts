import { describe, expect, mock, test } from 'bun:test';
import type { IWorkflowStore } from '../store';
import type {
  SupervisorActionRecord,
  SupervisorIncidentRecord,
  SupervisorObservationRecord,
  SupervisorRepairLeaseRecord,
} from './types';
import { coordinateSupervisorRecovery } from './supervisor';

const incident: SupervisorIncidentRecord = {
  incidentId: '11111111-1111-4111-8111-111111111111',
  incidentKey: 'run-1:terminal-failure',
  runId: '22222222-2222-4222-8222-222222222222',
  woId: 'WO-TEST-1',
  status: 'open',
  createdAt: '2026-07-10T12:00:00.000Z',
  updatedAt: '2026-07-10T12:00:00.000Z',
};

function makeSupervisorStore() {
  const observations: SupervisorObservationRecord[] = [];
  const actions: SupervisorActionRecord[] = [];
  let lease: SupervisorRepairLeaseRecord | null = null;
  const callOrder: string[] = [];
  const store = {
    createSupervisorIncident: mock(async () => incident),
    appendSupervisorObservation: mock(async (observation: SupervisorObservationRecord) => {
      observations.push(observation);
      return true;
    }),
    listSupervisorObservations: mock(async () => observations),
    claimSupervisorRepairLease: mock(
      async (data: { incidentId: string; ownerId: string; leaseDurationMs: number }) => {
        if (lease !== null) return null;
        lease = {
          incidentId: data.incidentId,
          ownerId: data.ownerId,
          fencingToken: 1,
          acquiredAt: '2026-07-10T12:00:01.000Z',
          lastHeartbeatAt: '2026-07-10T12:00:01.000Z',
          expiresAt: '2026-07-10T12:01:01.000Z',
          releasedAt: null,
        };
        return lease;
      }
    ),
    authorizeSupervisorMutation: mock(
      async (data: { ownerId: string; fencingToken: number }) =>
        lease?.ownerId === data.ownerId && lease.fencingToken === data.fencingToken
    ),
    reserveSupervisorAction: mock(async (action: SupervisorActionRecord) => {
      callOrder.push('reserve');
      actions.push(action);
      return 'applied';
    }),
    finalizeSupervisorAction: mock(async () => {
      callOrder.push('finalize');
      return true;
    }),
    appendSupervisorAction: mock(async (action: SupervisorActionRecord) => {
      actions.push(action);
      return true;
    }),
    releaseSupervisorRepairLease: mock(async () => true),
  };
  return { store: store as unknown as IWorkflowStore, observations, actions, callOrder };
}

describe('dual supervisor recovery coordination', () => {
  test('Sol and Fable observe concurrently while only one lease winner repairs', async () => {
    const { store, observations, actions, callOrder } = makeSupervisorStore();
    let started = 0;
    let releaseObservers: (() => void) | undefined;
    const bothStarted = new Promise<void>(resolve => {
      releaseObservers = resolve;
    });
    const observe = (name: string) => async () => {
      started += 1;
      if (started === 2) releaseObservers?.();
      await bothStarted;
      return { assessment: `${name}-assessment`, evidenceRefs: [`event:${name}`] };
    };
    const repair = mock(async (owner: SupervisorRepairLeaseRecord) => {
      callOrder.push('repair');
      return {
        assessment: `repaired-by-${owner.ownerId}`,
        evidenceRefs: ['action:repair'],
      };
    });

    const result = await coordinateSupervisorRecovery(store, {
      incident,
      supervisors: [
        { supervisorId: 'sol', observe: observe('sol') },
        { supervisorId: 'fable', observe: observe('fable') },
      ],
      acquiredAt: '2026-07-10T12:00:01.000Z',
      expiresAt: '2026-07-10T12:01:01.000Z',
      actionType: 'repair_or_refire',
      repair,
    });

    expect(observations.map(item => item.supervisorId).sort()).toEqual(['fable', 'sol']);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.fencingToken).toBe(1);
    expect(callOrder).toEqual(['reserve', 'repair', 'finalize']);
    expect(result.repaired).toBe(true);
  });

  test('does not run the external repair when action reservation loses the race', async () => {
    const { store } = makeSupervisorStore();
    (store.reserveSupervisorAction as ReturnType<typeof mock>).mockResolvedValue('conflict');
    const repair = mock(async () => ({ assessment: 'must-not-run', evidenceRefs: [] }));

    const result = await coordinateSupervisorRecovery(store, {
      incident,
      supervisors: [
        {
          supervisorId: 'sol',
          observe: async () => ({ assessment: 'repairable', evidenceRefs: [] }),
        },
      ],
      acquiredAt: '2026-07-10T12:00:01.000Z',
      expiresAt: '2026-07-10T12:01:01.000Z',
      actionType: 'repair_or_refire',
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(result.repaired).toBe(false);
    expect(store.releaseSupervisorRepairLease).toHaveBeenCalledTimes(1);
  });

  test('releases the lease when repair succeeds but fenced finalization loses', async () => {
    const { store } = makeSupervisorStore();
    (store.finalizeSupervisorAction as ReturnType<typeof mock>).mockResolvedValue(false);

    const result = await coordinateSupervisorRecovery(store, {
      incident,
      supervisors: [
        {
          supervisorId: 'sol',
          observe: async () => ({ assessment: 'repairable', evidenceRefs: [] }),
        },
      ],
      acquiredAt: '2026-07-10T12:00:01.000Z',
      expiresAt: '2026-07-10T12:01:01.000Z',
      actionType: 'repair_or_refire',
      repair: async () => ({ assessment: 'repaired', evidenceRefs: [] }),
    });

    expect(result.repaired).toBe(false);
    expect(store.releaseSupervisorRepairLease).toHaveBeenCalledTimes(1);
  });

  test('does not replace a repair failure when best-effort lease release also fails', async () => {
    const { store } = makeSupervisorStore();
    (store.releaseSupervisorRepairLease as ReturnType<typeof mock>).mockRejectedValue(
      new Error('release unavailable')
    );

    await expect(
      coordinateSupervisorRecovery(store, {
        incident,
        supervisors: [
          {
            supervisorId: 'sol',
            observe: async () => ({ assessment: 'repairable', evidenceRefs: [] }),
          },
        ],
        acquiredAt: '2026-07-10T12:00:01.000Z',
        expiresAt: '2026-07-10T12:01:01.000Z',
        actionType: 'repair_or_refire',
        repair: async () => {
          throw new Error('repair failed');
        },
      })
    ).rejects.toThrow('repair failed');
  });
});
