import type {
  acquireRepositoryMutationLease,
  admitOverseerParent,
  assertIndependentVerifier,
  heartbeatOverseerParent,
  heartbeatRepositoryMutationLease,
  linkOverseerChild,
  listOverseerControlEvents,
  markFusionBudgetCallStarted,
  reconcileExpiredParentCommitments,
  reconcileFusionBudget,
  registerVerifierRegistry,
  releaseFusionBudgetReservation,
  releaseOverseerParent,
  releaseRepositoryMutationLease,
  reserveFusionBudget,
  transitionOverseerChildState,
  transitionOverseerParentState,
} from '@archon/core/db/overseer-control-plane';

export interface OverseerControlPlaneServiceDependencies {
  readonly admitOverseerParent: typeof admitOverseerParent;
  readonly releaseOverseerParent: typeof releaseOverseerParent;
  readonly heartbeatOverseerParent: typeof heartbeatOverseerParent;
  readonly transitionOverseerParentState: typeof transitionOverseerParentState;
  readonly linkOverseerChild: typeof linkOverseerChild;
  readonly transitionOverseerChildState: typeof transitionOverseerChildState;
  readonly reconcileExpiredParentCommitments: typeof reconcileExpiredParentCommitments;
  readonly acquireRepositoryMutationLease: typeof acquireRepositoryMutationLease;
  readonly heartbeatRepositoryMutationLease: typeof heartbeatRepositoryMutationLease;
  readonly releaseRepositoryMutationLease: typeof releaseRepositoryMutationLease;
  readonly registerVerifierRegistry: typeof registerVerifierRegistry;
  readonly assertIndependentVerifier: typeof assertIndependentVerifier;
  readonly reserveFusionBudget: typeof reserveFusionBudget;
  readonly markFusionBudgetCallStarted: typeof markFusionBudgetCallStarted;
  readonly reconcileFusionBudget: typeof reconcileFusionBudget;
  readonly releaseFusionBudgetReservation: typeof releaseFusionBudgetReservation;
  readonly listOverseerControlEvents: typeof listOverseerControlEvents;
}

export type OverseerControlPlaneService = OverseerControlPlaneServiceDependencies;

export function createOverseerControlPlaneService(
  dependencies: OverseerControlPlaneServiceDependencies
): OverseerControlPlaneService {
  return Object.freeze({ ...dependencies });
}
