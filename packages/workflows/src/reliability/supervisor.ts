import { randomUUID } from 'node:crypto';
import type { IWorkflowStore } from '../store';
import type {
  SupervisorIncidentRecord,
  SupervisorObservationRecord,
  SupervisorRepairLeaseRecord,
} from './types';

export interface SupervisorAssessment {
  readonly assessment: string;
  readonly evidenceRefs: readonly string[];
}

export interface SupervisorObserver {
  readonly supervisorId: string;
  observe(): Promise<SupervisorAssessment>;
}

export interface CoordinateSupervisorRecoveryInput {
  readonly incident: SupervisorIncidentRecord;
  readonly supervisors: readonly SupervisorObserver[];
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly actionType: string;
  repair(owner: SupervisorRepairLeaseRecord): Promise<SupervisorAssessment>;
}

export interface CoordinateSupervisorRecoveryResult {
  readonly incident: SupervisorIncidentRecord;
  readonly observations: readonly SupervisorObservationRecord[];
  readonly repairOwner: SupervisorRepairLeaseRecord | null;
  readonly repaired: boolean;
}

type SupervisorStore = Required<
  Pick<
    IWorkflowStore,
    | 'createSupervisorIncident'
    | 'appendSupervisorObservation'
    | 'listSupervisorObservations'
    | 'claimSupervisorRepairLease'
    | 'authorizeSupervisorMutation'
    | 'reserveSupervisorAction'
    | 'finalizeSupervisorAction'
    | 'releaseSupervisorRepairLease'
  >
>;

function requireSupervisorStore(store: IWorkflowStore): SupervisorStore {
  const methods: readonly (keyof SupervisorStore)[] = [
    'createSupervisorIncident',
    'appendSupervisorObservation',
    'listSupervisorObservations',
    'claimSupervisorRepairLease',
    'authorizeSupervisorMutation',
    'reserveSupervisorAction',
    'finalizeSupervisorAction',
    'releaseSupervisorRepairLease',
  ];
  for (const method of methods) {
    if (typeof store[method] !== 'function') {
      throw new Error(`supervisor_store_unavailable: ${method}`);
    }
  }
  return store as SupervisorStore;
}

/**
 * Run all observers concurrently, then let the database select one repair owner.
 * No model or transport is privileged here: Sol and Fable are ordinary IDs.
 */
export async function coordinateSupervisorRecovery(
  workflowStore: IWorkflowStore,
  input: CoordinateSupervisorRecoveryInput
): Promise<CoordinateSupervisorRecoveryResult> {
  const store = requireSupervisorStore(workflowStore);
  const leaseDurationMs = Date.parse(input.expiresAt) - Date.parse(input.acquiredAt);
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error('supervisor_lease_duration_invalid');
  }
  const incident = await store.createSupervisorIncident(input.incident);
  await Promise.all(
    input.supervisors.map(async supervisor => {
      const assessment = await supervisor.observe();
      await store.appendSupervisorObservation({
        observationId: randomUUID(),
        incidentId: incident.incidentId,
        supervisorId: supervisor.supervisorId,
        assessment: assessment.assessment,
        evidenceRefs: assessment.evidenceRefs,
        createdAt: input.acquiredAt,
      });
    })
  );

  const claims = await Promise.all(
    input.supervisors.map(supervisor =>
      store.claimSupervisorRepairLease({
        incidentId: incident.incidentId,
        ownerId: supervisor.supervisorId,
        leaseDurationMs,
      })
    )
  );
  const repairOwner = claims.find((claim): claim is SupervisorRepairLeaseRecord => claim !== null);
  const observations = await store.listSupervisorObservations(incident.incidentId);
  if (!repairOwner) return { incident, observations, repairOwner: null, repaired: false };

  const authorized = await store.authorizeSupervisorMutation({
    incidentId: incident.incidentId,
    ownerId: repairOwner.ownerId,
    fencingToken: repairOwner.fencingToken,
  });
  if (!authorized) return { incident, observations, repairOwner, repaired: false };

  const actionId = randomUUID();
  const reserved = await store.reserveSupervisorAction({
    actionId,
    incidentId: incident.incidentId,
    ownerId: repairOwner.ownerId,
    fencingToken: repairOwner.fencingToken,
    actionType: input.actionType,
    outcome: 'reserved',
    evidenceRefs: [],
    createdAt: input.acquiredAt,
  });
  const releaseRepairOwner = (): Promise<boolean> =>
    store.releaseSupervisorRepairLease({
      incidentId: incident.incidentId,
      ownerId: repairOwner.ownerId,
      fencingToken: repairOwner.fencingToken,
      releasedAt: input.acquiredAt,
    });
  const releaseRepairOwnerBestEffort = async (): Promise<void> => {
    await releaseRepairOwner().catch(() => false);
  };
  if (!reserved) {
    await releaseRepairOwnerBestEffort();
    return { incident, observations, repairOwner, repaired: false };
  }

  try {
    const result = await input.repair(repairOwner);
    const finalized = await store.finalizeSupervisorAction({
      actionId,
      incidentId: incident.incidentId,
      ownerId: repairOwner.ownerId,
      fencingToken: repairOwner.fencingToken,
      status: 'completed',
      outcome: result.assessment,
      evidenceRefs: result.evidenceRefs,
      completedAt: input.acquiredAt,
    });
    if (!finalized) {
      await releaseRepairOwnerBestEffort();
      return { incident, observations, repairOwner, repaired: false };
    }
    await releaseRepairOwnerBestEffort();
    return { incident, observations, repairOwner, repaired: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.finalizeSupervisorAction({
      actionId,
      incidentId: incident.incidentId,
      ownerId: repairOwner.ownerId,
      fencingToken: repairOwner.fencingToken,
      status: 'failed',
      outcome: message,
      evidenceRefs: [],
      completedAt: input.acquiredAt,
    });
    await releaseRepairOwnerBestEffort();
    throw error;
  }
}
