// WO-HARNESS-OVERSEER-STAGING-REFIRE-BRIDGE-01
//
// Named staging Cauldron repair/refire bridge facade.
//
// This module is the WO-named, single-run-per-execution_id entry point for an
// authorized Overseer repair proposal into the EXISTING staging Cauldron run
// admission path. It adds NO new admission logic, NO new idempotency logic, and
// NO parallel abstraction: it delegates entirely to the already-audited
// adapters/cauldron-refire-bridge.ts (prepareAdmission / isExplicitStagingTarget)
// and actions/cauldron-refire-bridge.ts (executeCauldronRefireBridge), per M-42a
// Section 5.2 ("reuse the established run admission and binding path") and
// Section 3 ("wrap the existing admission path... rather than building a parallel
// admission mechanism").
//
// Boundaries enforced by the delegated implementation (see Section 5.2):
//  - refuses production Archon, production event stores, production worktrees, and
//    production credentials before any admission call, via isExplicitStagingTarget
//    (any non-'staging' environment/archon/event_store/worktree/credential fails
//    closed with reason 'non_staging_target' -- a production-effect classification
//    rejection recorded in the receipt);
//  - accepts only a named synthetic WO + workflow registered for the authorized
//    sandbox workload (unregistered names fail closed with 'unregistered_workload');
//  - preserves the original WO scope and exact repository binding through the
//    admission call (see bindingEvidence in the delegated adapter);
//  - creates at most one new run per execution_id: a repeat call with the same
//    execution_id returns the prior admission receipt idempotently (idempotency
//    begin/commit + getAdmissionByExecutionId replay guard) rather than admitting a
//    second run;
//  - records the admitted run id and binding evidence into the
//    SandboxActionResultV1-shaped receipt (admitted_run_id, binding_evidence,
//    provider_request_id, receipt_digest, rollback_recipe_digest);
//  - treats timeout / indeterminate admission as reconciliation-required (opens a
//    persistent circuit breaker, no blind automatic retry for the same execution_id);
//  - leaves the normal operator fire path (scripts/staging/staging-fire.ps1)
//    completely untouched.
//
// Build-only per M-42a / M-48: no production, deployment, or activation authority.

import {
  createCauldronRefireBridgeAdapter,
  isExplicitStagingTarget,
  prepareAdmission,
} from './adapters/cauldron-refire-bridge';
import { executeCauldronRefireBridge } from './actions/cauldron-refire-bridge';

import type {
  CauldronAdmissionBindingEvidenceV1,
  CauldronAdmissionDepsV1,
  CauldronAdmissionRequestV1,
  CauldronAdmissionResultV1,
  CauldronAdmissionStatusV1,
  CauldronAdmissionTargetV1,
  CauldronPrepareAdmissionInputV1,
  CauldronPreparedAdmissionV1,
  CauldronRefireBridgeAdapter,
  CauldronRefireBridgeRefusalReasonV1,
  CauldronRegisteredWorkloadV1,
} from './adapters/cauldron-refire-bridge';
import type {
  CauldronRefireBridgeExecutionDeps,
  CauldronRefireBridgeExecutionInput,
  CauldronRefireBridgeOutcomeV1,
  CauldronRefireBridgeReasonV1,
  CauldronRefireBridgeReceiptV1,
} from './actions/cauldron-refire-bridge';

// WO-named type aliases over the shared contract types. These are the same
// underlying shapes; the aliases exist so callers speak in staging-refire terms.
export type StagingRefireTargetV1 = CauldronAdmissionTargetV1;
export type StagingRefireRegisteredWorkloadV1 = CauldronRegisteredWorkloadV1;
export type StagingRefireBindingEvidenceV1 = CauldronAdmissionBindingEvidenceV1;
export type StagingRefireAdmissionRequestV1 = CauldronAdmissionRequestV1;
export type StagingRefireAdmissionResultV1 = CauldronAdmissionResultV1;
export type StagingRefireAdmissionStatusV1 = CauldronAdmissionStatusV1;
export type StagingRefireAdmissionDepsV1 = CauldronAdmissionDepsV1;
export type StagingRefireBridgeAdapterV1 = CauldronRefireBridgeAdapter;
export type StagingRefirePrepareInputV1 = CauldronPrepareAdmissionInputV1;
export type StagingRefirePreparedAdmissionV1 = CauldronPreparedAdmissionV1;
export type StagingRefireRefusalReasonV1 = CauldronRefireBridgeRefusalReasonV1;
export type StagingRefireExecutionInputV1 = CauldronRefireBridgeExecutionInput;
export type StagingRefireExecutionDepsV1 = CauldronRefireBridgeExecutionDeps;
export type StagingRefireOutcomeV1 = CauldronRefireBridgeOutcomeV1;
export type StagingRefireReasonV1 = CauldronRefireBridgeReasonV1;
export type StagingRefireReceiptV1 = CauldronRefireBridgeReceiptV1;

/**
 * Build the staging refire bridge adapter over the injected admission deps.
 *
 * Thin delegate to createCauldronRefireBridgeAdapter -- the returned adapter's
 * prepareAdmission fails closed on any non-staging (production) target and on any
 * unregistered synthetic WO / workflow name before an admission call is issued.
 */
export function createStagingRefireBridge(
  deps: StagingRefireAdmissionDepsV1
): StagingRefireBridgeAdapterV1 {
  return createCauldronRefireBridgeAdapter(deps);
}

/**
 * Execute one authorized staging refire for a single execution_id.
 *
 * Delegates to executeCauldronRefireBridge, which enforces at-most-one-run per
 * execution_id (idempotent replay of the prior receipt), production-target refusal
 * before dispatch, and reconciliation-required (no blind retry) on timeout /
 * indeterminate admission. Returns the SandboxActionResultV1-shaped receipt that
 * records the admitted run id and binding evidence for this execution_id.
 */
export function executeStagingRefire(
  input: StagingRefireExecutionInputV1,
  deps: StagingRefireExecutionDepsV1
): Promise<StagingRefireReceiptV1> {
  return executeCauldronRefireBridge(input, deps);
}

/**
 * True only when every target facet resolves to staging.
 *
 * Delegates to isExplicitStagingTarget: refuses any production Archon, production
 * event store, production worktree, or production credential. Exposed as the named
 * production-refusal predicate for the staging refire bridge.
 */
export function isStagingRefireTargetAllowed(target: StagingRefireTargetV1): boolean {
  return isExplicitStagingTarget(target);
}

/**
 * Prepare (validate + bind) an admission request without issuing it.
 *
 * Delegates to prepareAdmission. Used by callers that want the fail-closed
 * validation result (including production-target and unregistered-workload
 * refusals keyed by execution_id) prior to admission.
 */
export function prepareStagingRefireAdmission(
  input: StagingRefirePrepareInputV1
): StagingRefirePreparedAdmissionV1 {
  return prepareAdmission(input);
}
