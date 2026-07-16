// Overseer M-42 Slice 4: repair/refire recovery action.
//
// Recovers an eligible failed factory run without losing salvageable work,
// changing its scope, duplicating ownership, or exceeding the bounded refire
// limit. Every external effect (on-ramp, Smart Cauldron conductor/cascade,
// permit/authorize/reserve gates, salvage persistence, circuit control, clock)
// is dependency injected. This module contains no process, network, or
// direct-fire client. Only a deterministic fake dependency is supplied in
// Slice 4; Slice 8 owns later real wiring under separate authority.
//
// Frozen structural contracts (do not drift):
//   - OverseerSalvageReceiptV1        -- audit Section 7.4
//   - FirstRefireOnRampRequestV1      -- audit Section 7.5
//   - FirstRefireOnRampResultV1       -- audit Section 7.5
//   - FirstRefireOnRampDepsV1         -- audit Section 7.5

import type { RepairRefireAdapter } from '../adapters/repair-refire.ts';

// ---------------------------------------------------------------------------
// Frozen structural contracts (audit Sections 7.4 and 7.5)
// ---------------------------------------------------------------------------

/** Common append-only salvage receipt shape (audit Section 7.4). */
export interface OverseerSalvageReceiptV1 {
  readonly schema_version: 'overseer-salvage-receipt-v1';
  readonly repository: string;
  readonly wo_id: string;
  readonly source_target_kind: 'workflow_run' | 'issue' | 'work_order' | 'pull_request';
  readonly source_target_key: string;
  readonly source_target_digest: string;
  readonly source_run_id: string | null;
  readonly worktree_path: string;
  readonly artifact_kind: 'git_object' | 'patch';
  readonly git_object_format: 'sha1' | 'sha256' | null;
  readonly git_object_id: string | null;
  readonly patch_path: string | null;
  readonly patch_sha256: string | null;
  readonly scope_digest: string;
  readonly captured_at: string;
  readonly verified_at: string;
}

/** First-refire on-ramp request (audit Section 7.5). */
export interface FirstRefireOnRampRequestV1 {
  readonly schema_version: 'overseer-first-refire-on-ramp-request-v1';
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly idempotency_key: string;
  readonly repository: string;
  readonly wo_id: string;
  readonly workflow_name: string;
  readonly target_digest: string;
  readonly scope_digest: string;
  readonly failure_digest: string;
  readonly salvage_receipt_digest: string;
}

/** First-refire on-ramp result (audit Section 7.5). */
export interface FirstRefireOnRampResultV1 {
  readonly schema_version: 'overseer-first-refire-on-ramp-result-v1';
  readonly status: 'succeeded' | 'failed' | 'indeterminate';
  readonly successor_run_id: string | null;
  readonly external_effect_reference: string | null;
  readonly evidence_digest: string;
  readonly reason: string;
}

/** Injected first-refire on-ramp dependency (audit Section 7.5). */
export interface FirstRefireOnRampDepsV1 {
  startFirstRefire(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Validate an on-ramp dependency result against the frozen Section 7.5
 * NULL/status matrix. Any other combination is an invalid dependency result
 * that fails closed and records no primary outcome.
 */
export function isValidOnRampResult(result: FirstRefireOnRampResultV1): boolean {
  if (result.schema_version !== 'overseer-first-refire-on-ramp-result-v1') return false;
  if (result.reason.length === 0) return false;
  if (!LOWER_HEX_64.test(result.evidence_digest)) return false;
  const successor = result.successor_run_id;
  const effect = result.external_effect_reference;
  switch (result.status) {
    case 'succeeded':
      return successor !== null && successor.length > 0 && effect !== null && effect.length > 0;
    case 'failed':
      return successor === null && effect === null;
    case 'indeterminate':
      return successor === null && effect !== null && effect.length > 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Assessment (pure evidence reduction) -- Mode Behavior Matrix, Section 6
// ---------------------------------------------------------------------------

/** Two automatic recovery attempts per rolling 24 hours (Section 6, Test 3). */
export const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 2;

export type RepairRefireDisposition =
  | 'reconcile_only'
  | 'repair'
  | 'refire_first'
  | 'refire_later'
  | 'escalate';

export type RepairRefireEscalationReason =
  | 'indeterminate_prior_effect'
  | 'duplicate_owner'
  | 'attempt_ceiling'
  | 'semantic_or_scope_dispute';

export interface RepairRefireAssessmentInput {
  /** Recovery action gate is enabled. When false, no mutation is allowed. */
  readonly action_gate_enabled: boolean;
  /** All required run/event/outcome/worktree/branch/PR/WO evidence is present. */
  readonly evidence_complete: boolean;
  /** Exact run/branch/PR target for the recovery is established. */
  readonly has_exact_target: boolean;
  /** Another active supervisor/run claim or repair lease exists. */
  readonly has_active_owner_or_run: boolean;
  /** An effect_reserved receipt exists without a primary outcome (indeterminate). */
  readonly has_indeterminate_prior_effect: boolean;
  /** Salvage receipt was captured before any cleanup or mutation. */
  readonly salvage_complete: boolean;
  /** Count of durable automatic recovery attempts in the database-clock 24h window. */
  readonly automatic_attempt_count: number;
  /** The candidate recovery changes the original scope. */
  readonly scope_changed: boolean;
  /** The recovery requires disputed semantic judgment. */
  readonly semantic_dispute: boolean;
  /** A paid Fusion verifier is available (never substituted when absent). */
  readonly fusion_available: boolean;
  /** The failure is a scope-preserving in-place patch on an exact target. */
  readonly repairable_in_place: boolean;
}

export interface RepairRefireAssessment {
  readonly disposition: RepairRefireDisposition;
  readonly escalation_reason: RepairRefireEscalationReason | null;
  readonly requires_circuit_open: boolean;
  readonly no_mutation: boolean;
}

function reconcile(): RepairRefireAssessment {
  return {
    disposition: 'reconcile_only',
    escalation_reason: null,
    requires_circuit_open: false,
    no_mutation: true,
  };
}

function escalate(
  reason: RepairRefireEscalationReason,
  requiresCircuitOpen: boolean
): RepairRefireAssessment {
  return {
    disposition: 'escalate',
    escalation_reason: reason,
    requires_circuit_open: requiresCircuitOpen,
    no_mutation: true,
  };
}

function dispatchable(
  disposition: 'repair' | 'refire_first' | 'refire_later'
): RepairRefireAssessment {
  return {
    disposition,
    escalation_reason: null,
    requires_circuit_open: false,
    no_mutation: false,
  };
}

/**
 * Reduce terminal-run evidence to exactly one recovery disposition. Pure: no
 * deps, no clock, no mutation. Guards fail closed in strict precedence so that
 * an indeterminate prior effect, a duplicate owner, an exhausted attempt
 * budget, or an unfundable semantic/scope dispute can never reach a mutating
 * path.
 */
export function assessRepairRefireCandidate(
  input: RepairRefireAssessmentInput
): RepairRefireAssessment {
  // Gate off or incomplete evidence: read and report only.
  if (!input.action_gate_enabled || !input.evidence_complete) return reconcile();

  // Indeterminate prior effect: fail closed and open the repair circuit.
  if (input.has_indeterminate_prior_effect) {
    return escalate('indeterminate_prior_effect', true);
  }

  // Another owner already holds the run/repair lease: fail closed, no successor.
  if (input.has_active_owner_or_run) return escalate('duplicate_owner', false);

  // Two attempts already spent in the 24h window: ceiling reached.
  if (input.automatic_attempt_count >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
    return escalate('attempt_ceiling', false);
  }

  // Scope change or semantic dispute requires Fusion, which cannot be
  // substituted. Slice 4 authorizes no paid Fusion, so escalate either way.
  if (input.scope_changed || input.semantic_dispute) {
    return escalate('semantic_or_scope_dispute', false);
  }

  // Cannot mutate without a complete salvage receipt or an exact target.
  if (!input.salvage_complete) return reconcile();
  if (!input.has_exact_target) return reconcile();

  // Scope-preserving in-place patch on an exact target.
  if (input.repairable_in_place) return dispatchable('repair');

  // Zero prior attempts: replacement run over the direct on-ramp path.
  if (input.automatic_attempt_count === 0) return dispatchable('refire_first');

  // One prior automatic attempt: replacement run through the conductor.
  return dispatchable('refire_later');
}

// ---------------------------------------------------------------------------
// Automatic attempt counting (database-clock window, no caller time)
// ---------------------------------------------------------------------------

/**
 * Injected store seam for the automatic-attempt window. Inside one store
 * transaction it derives `db_now - interval '24 hours'` from the database
 * clock, then counts durable effect_reserved and primary-outcome receipt
 * events for the work order. It accepts no caller timestamp, duration, or
 * host-clock fallback.
 */
export interface AutomaticAttemptWindowDeps {
  countAutomaticAttemptsInDbWindow(woId: string): Promise<number>;
}

/**
 * Count automatic recovery attempts for a work order in the database-clock
 * last 24 hours. The public signature accepts only `woId`; no caller-supplied
 * time boundary can enter the query (Test 2 forged-time requirement).
 */
export async function countAutomaticRecoveryAttempts(
  woId: string,
  deps: AutomaticAttemptWindowDeps
): Promise<number> {
  if (woId.length === 0) throw new Error('countAutomaticRecoveryAttempts: woId is required');
  return deps.countAutomaticAttemptsInDbWindow(woId);
}

// ---------------------------------------------------------------------------
// Salvage capture (before any cleanup or lifecycle mutation)
// ---------------------------------------------------------------------------

export interface CaptureRepairSalvageInput {
  readonly repository: string;
  readonly wo_id: string;
  readonly source_target_kind: OverseerSalvageReceiptV1['source_target_kind'];
  readonly source_target_key: string;
  readonly source_target_digest: string;
  readonly source_run_id: string | null;
  readonly worktree_path: string;
  readonly artifact_kind: OverseerSalvageReceiptV1['artifact_kind'];
  readonly git_object_format: OverseerSalvageReceiptV1['git_object_format'];
  readonly git_object_id: string | null;
  readonly patch_path: string | null;
  readonly patch_sha256: string | null;
  readonly scope_digest: string;
}

export interface CaptureRepairSalvageDeps {
  /** Injected authoritative clock; host-clock fallback is forbidden. */
  now(): Promise<string>;
  /** Verify salvage is recoverable; returns verified_at >= captured_at. */
  verifySalvage(input: CaptureRepairSalvageInput): Promise<{ readonly verified_at: string }>;
  /** Append-only persistence; the receipt is complete before cleanup. */
  persistSalvageReceipt(receipt: OverseerSalvageReceiptV1): Promise<void>;
}

/**
 * Capture an exact salvage receipt (worktree, Git object or content-addressed
 * patch, and verification) before any cleanup or lifecycle mutation. Fails
 * closed on an invalid artifact/field combination or a non-monotonic clock.
 */
export async function captureRepairSalvage(
  input: CaptureRepairSalvageInput,
  deps: CaptureRepairSalvageDeps
): Promise<OverseerSalvageReceiptV1> {
  assertSalvageArtifactShape(input);

  const capturedAt = await deps.now();
  const verification = await deps.verifySalvage(input);
  if (Date.parse(verification.verified_at) < Date.parse(capturedAt)) {
    throw new Error(
      'captureRepairSalvage: verified_at must be greater than or equal to captured_at'
    );
  }

  const receipt: OverseerSalvageReceiptV1 = {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: input.repository,
    wo_id: input.wo_id,
    source_target_kind: input.source_target_kind,
    source_target_key: input.source_target_key,
    source_target_digest: input.source_target_digest,
    source_run_id: input.source_run_id,
    worktree_path: input.worktree_path,
    artifact_kind: input.artifact_kind,
    git_object_format: input.git_object_format,
    git_object_id: input.git_object_id,
    patch_path: input.patch_path,
    patch_sha256: input.patch_sha256,
    scope_digest: input.scope_digest,
    captured_at: capturedAt,
    verified_at: verification.verified_at,
  };

  // Persist the complete receipt before any caller-driven cleanup runs.
  await deps.persistSalvageReceipt(receipt);
  return receipt;
}

function assertSalvageArtifactShape(input: CaptureRepairSalvageInput): void {
  if (input.artifact_kind === 'git_object') {
    if (input.git_object_format === null || input.git_object_id === null) {
      throw new Error('captureRepairSalvage: git_object salvage requires format and object id');
    }
    if (input.patch_path !== null || input.patch_sha256 !== null) {
      throw new Error('captureRepairSalvage: git_object salvage must not carry patch fields');
    }
    return;
  }
  // artifact_kind === 'patch'
  if (input.patch_path === null || input.patch_sha256 === null) {
    throw new Error('captureRepairSalvage: patch salvage requires path and sha256');
  }
  if (!LOWER_HEX_64.test(input.patch_sha256)) {
    throw new Error('captureRepairSalvage: patch_sha256 must be lower-case 64-hex');
  }
  if (input.git_object_format !== null || input.git_object_id !== null) {
    throw new Error('captureRepairSalvage: patch salvage must not carry git object fields');
  }
}

// ---------------------------------------------------------------------------
// Execution (permit -> policy -> reservation -> factory/conductor -> outcome)
// ---------------------------------------------------------------------------

export type RepairRefireOutcome =
  | 'reconciled'
  | 'escalated'
  | 'succeeded'
  | 'failed'
  | 'indeterminate'
  | 'idempotency_conflict'
  | 'salvage_missing'
  | 'permit_failed'
  | 'denied'
  | 'reservation_failed'
  | 'invalid_dependency_result';

export interface RepairRefireExecutionResult {
  readonly disposition: RepairRefireDisposition;
  readonly outcome: RepairRefireOutcome;
  readonly successor_run_id: string | null;
  readonly predecessor_run_id: string | null;
  readonly external_effect_reference: string | null;
  readonly reason: string;
}

export interface RepairRefireExecutionInput {
  readonly assessment: RepairRefireAssessment;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly idempotency_key: string;
  readonly repository: string;
  readonly wo_id: string;
  readonly workflow_name: string;
  readonly target_digest: string;
  readonly scope_digest: string;
  readonly failure_digest: string;
  readonly source_run_id: string | null;
  readonly salvage_receipt: OverseerSalvageReceiptV1 | null;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface RepairRefireGateDeps {
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

export type RepairRefireIdempotencyState =
  | { readonly status: 'fresh' }
  | { readonly status: 'replay'; readonly result: FirstRefireOnRampResultV1 }
  | { readonly status: 'conflict' };

export interface RepairRefireIdempotencyStore {
  /** Persist the request digest under the key before any dependency call. */
  begin(idempotencyKey: string, requestDigest: string): Promise<RepairRefireIdempotencyState>;
  /** Persist the primary result so an exact replay returns it with no effect. */
  commit(idempotencyKey: string, result: FirstRefireOnRampResultV1): Promise<void>;
}

export interface RepairRefireCircuitDeps {
  openRepairCircuit(reason: string): Promise<void>;
}

export interface RepairRefireDispositionRecorder {
  recordDisposition(input: {
    readonly disposition: RepairRefireDisposition;
    readonly outcome: RepairRefireOutcome;
    readonly reason: string;
    readonly successor_run_id: string | null;
    readonly predecessor_run_id: string | null;
  }): Promise<void>;
}

export interface RepairRefireExecutionDeps {
  readonly gate: RepairRefireGateDeps;
  readonly adapter: RepairRefireAdapter;
  readonly idempotency: RepairRefireIdempotencyStore;
  readonly circuit: RepairRefireCircuitDeps;
  readonly recorder: RepairRefireDispositionRecorder;
  /** Injected lower-case 64-hex SHA-256 over a canonical string. */
  readonly sha256hex: (input: string) => string;
}

const ADAPTER_NAME = 'fake-repair-refire';

/**
 * Execute one authorized recovery action. Gate order is frozen:
 * permit -> authorize -> reserve -> dispatch (factory on-ramp or conductor)
 * -> primary outcome. Reconcile and escalate dispositions never mutate. An
 * exact idempotency replay returns the persisted result without a second
 * dependency invocation; any request drift on the same key fails as a
 * conflict before dependency invocation.
 */
export async function executeRepairRefire(
  input: RepairRefireExecutionInput,
  deps: RepairRefireExecutionDeps
): Promise<RepairRefireExecutionResult> {
  const assessment = input.assessment;
  const predecessor = input.source_run_id;

  if (assessment.disposition === 'reconcile_only') {
    return record(deps, 'reconcile_only', 'reconciled', null, predecessor, null, 'reconcile_only');
  }

  if (assessment.disposition === 'escalate') {
    if (assessment.requires_circuit_open) {
      await deps.circuit.openRepairCircuit(
        assessment.escalation_reason ?? 'indeterminate_prior_effect'
      );
    }
    return record(
      deps,
      'escalate',
      'escalated',
      null,
      predecessor,
      null,
      assessment.escalation_reason ?? 'escalate'
    );
  }

  // Dispatchable: repair | refire_first | refire_later. Salvage is mandatory
  // before any mutation.
  if (input.salvage_receipt === null) {
    return record(
      deps,
      assessment.disposition,
      'salvage_missing',
      null,
      predecessor,
      null,
      'salvage_missing'
    );
  }

  const request = buildOnRampRequest(input, input.salvage_receipt, deps.sha256hex);
  const requestDigest = deps.sha256hex(canonicalStringify(request));

  const begin = await deps.idempotency.begin(input.idempotency_key, requestDigest);
  if (begin.status === 'conflict') {
    return result(
      assessment.disposition,
      'idempotency_conflict',
      null,
      predecessor,
      null,
      'idempotency_conflict'
    );
  }
  if (begin.status === 'replay') {
    return fromOnRampResult(assessment.disposition, begin.result, predecessor);
  }

  // Fresh: run the frozen gate chain before touching the adapter.
  const permit = await deps.gate.preparePermit({ proposal_id: input.proposal_id });
  if (!permit.ok) {
    return record(
      deps,
      assessment.disposition,
      'permit_failed',
      null,
      predecessor,
      null,
      permit.reason
    );
  }

  const authorization = await deps.gate.authorizeAction({
    requested_capability: 'repair',
    proposal_id: input.proposal_id,
    execution_id: input.execution_id,
    actor: input.actor,
    correlation_id: input.correlation_id,
  });
  if (!authorization.allowed) {
    return record(
      deps,
      assessment.disposition,
      'denied',
      null,
      predecessor,
      null,
      authorization.reason
    );
  }

  const reservation = await deps.gate.reserveEffect({
    proposal_id: input.proposal_id,
    execution_id: input.execution_id,
    adapter_name: ADAPTER_NAME,
  });
  if (!reservation.ok) {
    return record(
      deps,
      assessment.disposition,
      'reservation_failed',
      null,
      predecessor,
      null,
      reservation.reason
    );
  }

  // The three dispatch paths are strictly distinct: repair -> in-place
  // patch on the exact target; refire_first -> direct on-ramp; refire_later
  // -> conductor cascade. A thrown adapter/conductor dependency after an
  // effect_reserved receipt must close the reservation with an
  // effect_indeterminate primary outcome; leaving effect_reserved orphaned
  // would violate the frozen receipt-chain contract.
  let dispatched: FirstRefireOnRampResultV1;
  try {
    switch (assessment.disposition) {
      case 'repair':
        dispatched = await deps.adapter.dispatchInPlaceRepair(request);
        break;
      case 'refire_later':
        dispatched = await deps.adapter.dispatchLaterAttempt(request);
        break;
      default:
        // refire_first
        dispatched = await deps.adapter.dispatchFirstAttempt(request);
        break;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.gate.appendOutcome({
      execution_id: input.execution_id,
      outcome: 'effect_indeterminate',
      reason,
      external_effect_reference: null,
    });
    return record(deps, assessment.disposition, 'indeterminate', null, predecessor, null, reason);
  }

  if (!isValidOnRampResult(dispatched)) {
    // Fail closed on an invalid dependency result; record no primary outcome.
    return record(
      deps,
      assessment.disposition,
      'invalid_dependency_result',
      null,
      predecessor,
      null,
      'invalid_dependency_result'
    );
  }

  await deps.gate.appendOutcome({
    execution_id: input.execution_id,
    outcome: primaryOutcomeType(dispatched.status),
    reason: dispatched.reason,
    external_effect_reference: dispatched.external_effect_reference,
  });
  await deps.idempotency.commit(input.idempotency_key, dispatched);

  return record(
    deps,
    assessment.disposition,
    dispatched.status,
    dispatched.successor_run_id,
    predecessor,
    dispatched.external_effect_reference,
    dispatched.reason
  );
}

function buildOnRampRequest(
  input: RepairRefireExecutionInput,
  salvage: OverseerSalvageReceiptV1,
  sha256hex: (input: string) => string
): FirstRefireOnRampRequestV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-request-v1',
    proposal_id: input.proposal_id,
    execution_id: input.execution_id,
    idempotency_key: input.idempotency_key,
    repository: input.repository,
    wo_id: input.wo_id,
    workflow_name: input.workflow_name,
    target_digest: input.target_digest,
    scope_digest: input.scope_digest,
    failure_digest: input.failure_digest,
    salvage_receipt_digest: sha256hex(canonicalStringify(salvage)),
  };
}

function primaryOutcomeType(
  status: FirstRefireOnRampResultV1['status']
): 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate' {
  switch (status) {
    case 'succeeded':
      return 'effect_succeeded';
    case 'failed':
      return 'effect_failed';
    default:
      return 'effect_indeterminate';
  }
}

function fromOnRampResult(
  disposition: RepairRefireDisposition,
  onRamp: FirstRefireOnRampResultV1,
  predecessor: string | null
): RepairRefireExecutionResult {
  return result(
    disposition,
    onRamp.status,
    onRamp.successor_run_id,
    predecessor,
    onRamp.external_effect_reference,
    onRamp.reason
  );
}

async function record(
  deps: RepairRefireExecutionDeps,
  disposition: RepairRefireDisposition,
  outcome: RepairRefireOutcome,
  successorRunId: string | null,
  predecessorRunId: string | null,
  externalEffectReference: string | null,
  reason: string
): Promise<RepairRefireExecutionResult> {
  await deps.recorder.recordDisposition({
    disposition,
    outcome,
    reason,
    successor_run_id: successorRunId,
    predecessor_run_id: predecessorRunId,
  });
  return result(
    disposition,
    outcome,
    successorRunId,
    predecessorRunId,
    externalEffectReference,
    reason
  );
}

function result(
  disposition: RepairRefireDisposition,
  outcome: RepairRefireOutcome,
  successorRunId: string | null,
  predecessorRunId: string | null,
  externalEffectReference: string | null,
  reason: string
): RepairRefireExecutionResult {
  return {
    disposition,
    outcome,
    successor_run_id: successorRunId,
    predecessor_run_id: predecessorRunId,
    external_effect_reference: externalEffectReference,
    reason,
  };
}

/**
 * Deterministic canonical JSON with recursively sorted object keys. Arrays
 * preserve order; primitives use JSON string form. Used to bind the on-ramp
 * request and salvage receipt to stable digests.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}
