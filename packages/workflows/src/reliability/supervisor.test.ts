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
    appendSupervisorAction: mock(async (action: SupervisorActionRecord) => {
      actions.push(action);
      return true;
    }),
    releaseSupervisorRepairLease: mock(async () => true),
  };
  return { store: store as unknown as IWorkflowStore, observations, actions };
}

describe('dual supervisor recovery coordination', () => {
  test('Sol and Fable observe concurrently while only one lease winner repairs', async () => {
    const { store, observations, actions } = makeSupervisorStore();
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
    const repair = mock(async (owner: SupervisorRepairLeaseRecord) => ({
      assessment: `repaired-by-${owner.ownerId}`,
      evidenceRefs: ['action:repair'],
    }));

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
    expect(result.repaired).toBe(true);
  });
});
