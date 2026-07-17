import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import type {
  CauldronAdmissionBindingEvidenceV1,
  CauldronAdmissionResultV1,
  CauldronRefireBridgeAdapter,
  CauldronRefireBridgeRefusalReasonV1,
  CauldronRegisteredWorkloadV1,
  CauldronAdmissionTargetV1,
} from '../adapters/cauldron-refire-bridge';
import type { SandboxExecutionContextV1 } from '../adapters/sandbox-types';

export type CauldronRefireBridgeOutcomeV1 = 'admitted' | 'rejected' | 'reconciliation_required';

export type CauldronRefireBridgeReasonV1 =
  | CauldronRefireBridgeRefusalReasonV1
  | 'permit_failed'
  | 'denied'
  | 'reservation_failed'
  | 'idempotency_conflict'
  | 'admitted'
  | 'admission_replayed'
  | 'admission_timeout'
  | 'admission_indeterminate'
  | 'admission_rejected'
  | 'invalid_admission_result';

export interface CauldronRefireBridgeReceiptV1 {
  readonly schema_version: 'cauldron-refire-bridge-receipt-v1';
  readonly execution_id: string;
  readonly attempted: boolean;
  readonly provider_request_id: string | null;
  readonly before_sha: string;
  readonly after_sha: string | null;
  readonly normalized_outcome: CauldronRefireBridgeOutcomeV1;
  readonly side_effect_count: number;
  readonly started_at: string;
  readonly completed_at: string;
  readonly receipt_digest: string;
  readonly rollback_recipe_digest: string;
  readonly reason: CauldronRefireBridgeReasonV1;
  readonly admitted_run_id: string | null;
  readonly binding_evidence: CauldronAdmissionBindingEvidenceV1 | null;
  readonly circuit_breaker_opened: boolean;
}

export interface CauldronRefireAssessmentInput {
  readonly action_gate_enabled: boolean;
  readonly evidence_complete: boolean;
  readonly has_authorized_repair_proposal: boolean;
  readonly has_sandbox_execution_context: boolean;
  readonly has_registered_workload: boolean;
}

export interface CauldronRefireAssessment {
  readonly admissible: boolean;
  readonly reason:
    | 'accepted'
    | 'gate_disabled'
    | 'evidence_incomplete'
    | 'proposal_missing'
    | 'context_missing'
    | 'workload_missing';
}

export interface CauldronRefireBridgeExecutionInput {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly registered_workload: CauldronRegisteredWorkloadV1;
  readonly target: CauldronAdmissionTargetV1;
  readonly requested_wo_id: string;
  readonly requested_workflow_name: string;
  readonly conversation_id: string;
  readonly message: string;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface CauldronRefireBridgeGateDeps {
  preparePermit(input: {
    readonly proposal_id: string;
  }): Promise<{ readonly ok: boolean; readonly reason: string }>;
  authorizeAction(input: {
    readonly requested_capability: 'repair';
    readonly proposal_id: string;
    readonly execution_id: string;
    readonly actor: string;
    readonly correlation_id: string;
  }): Promise<{ readonly allowed: boolean; readonly reason: string }>;
  reserveEffect(input: {
    readonly proposal_id: string;
    readonly execution_id: string;
    readonly adapter_name: string;
  }): Promise<{ readonly ok: boolean; readonly reason: string }>;
  appendOutcome(input: {
    readonly execution_id: string;
    readonly outcome: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';
    readonly reason: string;
    readonly external_effect_reference: string | null;
  }): Promise<{ readonly ok: boolean }>;
}

export type CauldronRefireIdempotencyState =
  | { readonly status: 'fresh' }
  | { readonly status: 'replay'; readonly receipt: CauldronRefireBridgeReceiptV1 }
  | { readonly status: 'conflict' };

export interface CauldronRefireIdempotencyStore {
  begin(executionId: string, requestDigest: string): Promise<CauldronRefireIdempotencyState>;
  commit(executionId: string, receipt: CauldronRefireBridgeReceiptV1): Promise<void>;
}

export interface CauldronRefireCircuitDeps {
  openRefireCircuit(reason: string): Promise<void>;
}

export interface CauldronRefireBridgeExecutionDeps {
  readonly gate: CauldronRefireBridgeGateDeps;
  readonly adapter: CauldronRefireBridgeAdapter;
  readonly idempotency: CauldronRefireIdempotencyStore;
  readonly circuit: CauldronRefireCircuitDeps;
  readonly sha256hex: (input: string) => string;
  readonly now: () => string;
}

const ADAPTER_NAME = 'cauldron-refire-bridge';

export function assessCauldronRefireCandidate(
  input: CauldronRefireAssessmentInput
): CauldronRefireAssessment {
  if (!input.action_gate_enabled) return { admissible: false, reason: 'gate_disabled' };
  if (!input.evidence_complete) return { admissible: false, reason: 'evidence_incomplete' };
  if (!input.has_authorized_repair_proposal) {
    return { admissible: false, reason: 'proposal_missing' };
  }
  if (!input.has_sandbox_execution_context) return { admissible: false, reason: 'context_missing' };
  if (!input.has_registered_workload) return { admissible: false, reason: 'workload_missing' };
  return { admissible: true, reason: 'accepted' };
}

export async function executeCauldronRefireBridge(
  input: CauldronRefireBridgeExecutionInput,
  deps: CauldronRefireBridgeExecutionDeps
): Promise<CauldronRefireBridgeReceiptV1> {
  const startedAt = deps.now();
  const proposalId = input.context.proposal.proposal_id;
  const executionId = input.context.proposal.execution_id;

  const permit = await deps.gate.preparePermit({ proposal_id: proposalId });
  if (!permit.ok) return receipt(input, deps, startedAt, false, 'rejected', 'permit_failed');

  const authorization = await deps.gate.authorizeAction({
    requested_capability: 'repair',
    proposal_id: proposalId,
    execution_id: executionId,
    actor: input.actor,
    correlation_id: input.correlation_id,
  });
  if (!authorization.allowed) return receipt(input, deps, startedAt, false, 'rejected', 'denied');

  const prepared = deps.adapter.prepareAdmission({
    context: input.context,
    permit: input.permit,
    target: input.target,
    registered_workload: input.registered_workload,
    requested_wo_id: input.requested_wo_id,
    requested_workflow_name: input.requested_workflow_name,
    conversation_id: input.conversation_id,
    message: input.message,
  });
  if (!prepared.ok) return receipt(input, deps, startedAt, false, 'rejected', prepared.reason);

  const requestDigest = deps.sha256hex(canonicalStringify(prepared.request));
  const begin = await deps.idempotency.begin(executionId, requestDigest);
  if (begin.status === 'conflict') {
    return receipt(input, deps, startedAt, false, 'rejected', 'idempotency_conflict');
  }
  if (begin.status === 'replay') return begin.receipt;

  const existing = await deps.adapter.getAdmissionByExecutionId(executionId);
  if (existing) {
    const replayed = fromAdmission(input, deps, startedAt, existing, 'admission_replayed', false);
    await deps.idempotency.commit(executionId, replayed);
    return replayed;
  }

  const reservation = await deps.gate.reserveEffect({
    proposal_id: proposalId,
    execution_id: executionId,
    adapter_name: ADAPTER_NAME,
  });
  if (!reservation.ok) {
    return receipt(input, deps, startedAt, false, 'rejected', 'reservation_failed');
  }

  let admitted: CauldronAdmissionResultV1;
  try {
    admitted = await deps.adapter.admitRun(prepared.request);
  } catch {
    const indeterminate = receipt(
      input,
      deps,
      startedAt,
      true,
      'reconciliation_required',
      'admission_indeterminate',
      null,
      null,
      true
    );
    await deps.gate.appendOutcome({
      execution_id: executionId,
      outcome: 'effect_indeterminate',
      reason: indeterminate.reason,
      external_effect_reference: null,
    });
    await deps.circuit.openRefireCircuit(indeterminate.reason);
    await deps.idempotency.commit(executionId, indeterminate);
    return indeterminate;
  }

  const outcome = normalizeAdmission(input, deps, startedAt, admitted);
  await deps.gate.appendOutcome({
    execution_id: executionId,
    outcome:
      outcome.normalized_outcome === 'admitted' ? 'effect_succeeded' : 'effect_indeterminate',
    reason: outcome.reason,
    external_effect_reference: outcome.provider_request_id,
  });
  if (outcome.circuit_breaker_opened) {
    await deps.circuit.openRefireCircuit(outcome.reason);
  }
  await deps.idempotency.commit(executionId, outcome);
  return outcome;
}

function normalizeAdmission(
  input: CauldronRefireBridgeExecutionInput,
  deps: CauldronRefireBridgeExecutionDeps,
  startedAt: string,
  admitted: CauldronAdmissionResultV1
): CauldronRefireBridgeReceiptV1 {
  if (
    admitted.status === 'admitted' &&
    admitted.runId &&
    admitted.bindingEvidence?.execution_id === input.context.proposal.execution_id &&
    admitted.bindingEvidence.repository === input.context.repository.full_name
  ) {
    return fromAdmission(input, deps, startedAt, admitted, 'admitted', false, 'admitted');
  }
  if (admitted.status === 'timeout') {
    return fromAdmission(input, deps, startedAt, admitted, 'admission_timeout', true);
  }
  if (admitted.status === 'indeterminate') {
    return fromAdmission(input, deps, startedAt, admitted, 'admission_indeterminate', true);
  }
  if (admitted.status === 'rejected') {
    return fromAdmission(input, deps, startedAt, admitted, 'admission_rejected', false, 'rejected');
  }
  return fromAdmission(
    input,
    deps,
    startedAt,
    admitted,
    'invalid_admission_result',
    true,
    'reconciliation_required'
  );
}

function fromAdmission(
  input: CauldronRefireBridgeExecutionInput,
  deps: CauldronRefireBridgeExecutionDeps,
  startedAt: string,
  admitted: CauldronAdmissionResultV1,
  reason: CauldronRefireBridgeReasonV1,
  circuitBreakerOpened: boolean,
  forcedOutcome?: CauldronRefireBridgeOutcomeV1
): CauldronRefireBridgeReceiptV1 {
  const normalizedOutcome =
    forcedOutcome ?? (admitted.status === 'admitted' ? 'admitted' : 'reconciliation_required');
  return receipt(
    input,
    deps,
    startedAt,
    true,
    normalizedOutcome,
    normalizedOutcome === 'admitted' ? reason : reason,
    admitted.providerRequestId ?? admitted.runId,
    admitted.bindingEvidence,
    circuitBreakerOpened,
    admitted.runId
  );
}

function receipt(
  input: CauldronRefireBridgeExecutionInput,
  deps: CauldronRefireBridgeExecutionDeps,
  startedAt: string,
  attempted: boolean,
  normalizedOutcome: CauldronRefireBridgeOutcomeV1,
  reason: CauldronRefireBridgeReasonV1,
  providerRequestId: string | null = null,
  bindingEvidence: CauldronAdmissionBindingEvidenceV1 | null = null,
  circuitBreakerOpened = false,
  admittedRunId: string | null = null
): CauldronRefireBridgeReceiptV1 {
  const completedAt = deps.now();
  const withoutDigest = {
    schema_version: 'cauldron-refire-bridge-receipt-v1' as const,
    execution_id: input.context.proposal.execution_id,
    attempted,
    provider_request_id: providerRequestId,
    before_sha: input.context.base_sha,
    after_sha: null,
    normalized_outcome: normalizedOutcome,
    side_effect_count: normalizedOutcome === 'admitted' ? 1 : 0,
    started_at: startedAt,
    completed_at: completedAt,
    receipt_digest: '',
    rollback_recipe_digest: deps.sha256hex(
      `cauldron-refire-rollback:${input.context.proposal.execution_id}`
    ),
    reason,
    admitted_run_id: admittedRunId,
    binding_evidence: bindingEvidence,
    circuit_breaker_opened: circuitBreakerOpened,
  };
  return {
    ...withoutDigest,
    receipt_digest: deps.sha256hex(canonicalStringify(withoutDigest)),
  };
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}
