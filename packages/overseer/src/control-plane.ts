/**
 * Overseer control-plane service wrapper (WO-HARNESS-OVERSEER-CONTROL-PLANE-01).
 *
 * Thin cohesive surface over the @archon/core control-plane persistence functions.
 * It performs NO provider call, network I/O, credential handling, or activation; it
 * only binds the persistence operations to a database and forwards typed results.
 * Slice 8 owns wiring this service into the running Overseer runtime.
 */
import type { IDatabase } from '@archon/core';
import {
  admitOverseerParent,
  heartbeatOverseerParent,
  transitionOverseerParentState,
  linkOverseerChild,
  transitionOverseerChildState,
  releaseOverseerParent,
  reconcileExpiredParentCommitments,
  acquireRepositoryMutationLease,
  heartbeatRepositoryMutationLease,
  releaseRepositoryMutationLease,
  registerVerifierRegistry,
  assertIndependentVerifier,
  computeVerifierRegistryDigest,
  reserveFusionBudget,
  markFusionBudgetCallStarted,
  reconcileFusionBudget,
  releaseFusionBudgetReservation,
  listOverseerControlEvents,
  type AdmitOverseerParentInput,
  type HeartbeatOverseerParentInput,
  type TransitionOverseerParentStateInput,
  type LinkOverseerChildInput,
  type TransitionOverseerChildStateInput,
  type ReleaseOverseerParentInput,
  type AcquireRepositoryMutationLeaseInput,
  type HeartbeatRepositoryMutationLeaseInput,
  type ReleaseRepositoryMutationLeaseInput,
  type RegisterVerifierRegistryInput,
  type AssertIndependentVerifierInput,
  type ReserveFusionBudgetInput,
  type MarkFusionBudgetCallStartedInput,
  type ReconcileFusionBudgetInput,
  type ReleaseFusionBudgetReservationInput,
  type ListOverseerControlEventsFilter,
  type ControlResult,
  type IndependentVerifierDecision,
  type OverseerParentCommitment,
  type OverseerParentChild,
  type OverseerRepositoryLease,
  type OverseerVerifierRegistry,
  type OverseerVerifierEntry,
  type OverseerFusionReservation,
  type OverseerControlEvent,
} from '@archon/core/db/overseer-control-plane';

export { computeVerifierRegistryDigest };

/**
 * A control-plane service bound to a specific database. Every method forwards a
 * discriminated `{ ok, ... }` result from the persistence layer without throwing
 * on contract denials.
 */
export interface OverseerControlPlaneService {
  admitParent(input: AdmitOverseerParentInput): Promise<ControlResult<OverseerParentCommitment>>;
  heartbeatParent(
    input: HeartbeatOverseerParentInput
  ): Promise<ControlResult<OverseerParentCommitment>>;
  transitionParentState(
    input: TransitionOverseerParentStateInput
  ): Promise<ControlResult<OverseerParentCommitment>>;
  linkChild(input: LinkOverseerChildInput): Promise<ControlResult<OverseerParentChild>>;
  transitionChildState(
    input: TransitionOverseerChildStateInput
  ): Promise<ControlResult<OverseerParentChild>>;
  releaseParent(
    input: ReleaseOverseerParentInput
  ): Promise<ControlResult<OverseerParentCommitment>>;
  reconcileExpiredParents(): Promise<{ readonly reconciled: number }>;
  acquireRepositoryLease(
    input: AcquireRepositoryMutationLeaseInput
  ): Promise<ControlResult<OverseerRepositoryLease>>;
  heartbeatRepositoryLease(
    input: HeartbeatRepositoryMutationLeaseInput
  ): Promise<ControlResult<OverseerRepositoryLease>>;
  releaseRepositoryLease(
    input: ReleaseRepositoryMutationLeaseInput
  ): Promise<ControlResult<OverseerRepositoryLease>>;
  registerVerifierRegistry(
    input: RegisterVerifierRegistryInput
  ): Promise<ControlResult<OverseerVerifierRegistry>>;
  assertIndependentVerifier(
    input: AssertIndependentVerifierInput
  ): Promise<ControlResult<IndependentVerifierDecision>>;
  reserveFusionBudget(
    input: ReserveFusionBudgetInput
  ): Promise<ControlResult<OverseerFusionReservation>>;
  markFusionBudgetCallStarted(
    input: MarkFusionBudgetCallStartedInput
  ): Promise<ControlResult<OverseerFusionReservation>>;
  reconcileFusionBudget(
    input: ReconcileFusionBudgetInput
  ): Promise<ControlResult<OverseerFusionReservation>>;
  releaseFusionBudgetReservation(
    input: ReleaseFusionBudgetReservationInput
  ): Promise<ControlResult<OverseerFusionReservation>>;
  listControlEvents(
    filter?: ListOverseerControlEventsFilter
  ): Promise<readonly OverseerControlEvent[]>;
  /** Pure helper: compute the content-addressed digest for a set of entries. */
  computeRegistryDigest(entries: readonly OverseerVerifierEntry[]): string;
}

/**
 * Build a control-plane service bound to `db`. When `db` is omitted, each operation
 * resolves the ambient database via the core layer's default.
 */
export function createOverseerControlPlaneService(db?: IDatabase): OverseerControlPlaneService {
  return {
    admitParent: input => admitOverseerParent(input, db),
    heartbeatParent: input => heartbeatOverseerParent(input, db),
    transitionParentState: input => transitionOverseerParentState(input, db),
    linkChild: input => linkOverseerChild(input, db),
    transitionChildState: input => transitionOverseerChildState(input, db),
    releaseParent: input => releaseOverseerParent(input, db),
    reconcileExpiredParents: () => reconcileExpiredParentCommitments(db),
    acquireRepositoryLease: input => acquireRepositoryMutationLease(input, db),
    heartbeatRepositoryLease: input => heartbeatRepositoryMutationLease(input, db),
    releaseRepositoryLease: input => releaseRepositoryMutationLease(input, db),
    registerVerifierRegistry: input => registerVerifierRegistry(input, db),
    assertIndependentVerifier: input => assertIndependentVerifier(input, db),
    reserveFusionBudget: input => reserveFusionBudget(input, db),
    markFusionBudgetCallStarted: input => markFusionBudgetCallStarted(input, db),
    reconcileFusionBudget: input => reconcileFusionBudget(input, db),
    releaseFusionBudgetReservation: input => releaseFusionBudgetReservation(input, db),
    listControlEvents: filter => listOverseerControlEvents(filter ?? {}, db),
    computeRegistryDigest: computeVerifierRegistryDigest,
  };
}
