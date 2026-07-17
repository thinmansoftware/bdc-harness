/**
 * M-42 Slice 8 deterministic adversarial scenarios and default-off assertion.
 *
 * Invokes real exported S4-S7 assessment/execution paths with fake adapters and
 * injected M-31 v2 gate/reservation/outcome seams. Zero real provider calls.
 */

import {
  assessRepairRefireCandidate,
  buildIndeterminateOperatorCard,
  branchExecInput,
  createRealCallTracker,
  executeQualifiedMerge,
  executeRefreshRebase,
  executeRepairRefire,
  makeBranchHarness,
  makeLifecycleHarness,
  makeMergeHarness,
  makeRepairHarness,
  mergeEvidence,
  repairExecInput,
  runBranchSuccess,
  runLifecycleSuccess,
  runMergeSuccess,
  runRepairSuccess,
  runIndeterminateOperatorCardReconciliation,
  type RealCallTracker,
} from './integration-fixtures';

export const OVERSEER_CAPABILITIES = [
  'escalation',
  'repair',
  'branch',
  'lifecycle',
  'merge',
] as const;

export type OverseerCapabilityName = (typeof OVERSEER_CAPABILITIES)[number];

export const ADVERSARIAL_SCENARIO_IDS = [
  'stale_state',
  'replay',
  'duplicate_run',
  'provider_outage',
  'wrong_repository',
  'wrong_base',
  'unresolved_review',
  'semantic_conflict',
  'production_target',
  'budget_exhaustion',
  'indeterminate_result',
  'success',
] as const;

export type ScenarioId = (typeof ADVERSARIAL_SCENARIO_IDS)[number];

export interface ScenarioDeps {
  readonly adapter_mode: 'fake' | 'real' | 'none';
  /** Forbidden real-provider boundary used by tests; never invoked by success path. */
  readonly real_provider_call?: () => void;
  /**
   * Observed real-call counter. Prefer createRealCallTracker(). Host scripts must
   * not invent a constant zero; the tracker records only observed boundary hits.
   */
  readonly call_tracker?: RealCallTracker;
  /** @deprecated Prefer call_tracker.getRealCallCount(); kept for DI tests. */
  readonly getRealCallCount?: () => number;
}

export interface DefaultOffInput {
  readonly capabilities: Readonly<Record<OverseerCapabilityName, boolean>>;
  readonly emergency_stop: boolean;
  readonly circuits: Readonly<Record<OverseerCapabilityName, 'closed' | 'open' | 'unknown'>>;
}

export interface DefaultOffResult {
  readonly ok: boolean;
  readonly disabled_capabilities: readonly string[];
  readonly emergency_stop: boolean;
  readonly circuits: Readonly<Record<string, string>>;
  readonly reasons: readonly string[];
}

export interface ChainReceipt {
  readonly capability: OverseerCapabilityName;
  readonly proposal: string;
  readonly permit_issued: boolean;
  readonly gate: 'allowed' | 'denied';
  readonly effect_reserved: boolean;
  readonly primary_outcome: 'effect_succeeded' | 'effect_failed' | 'effect_indeterminate';
  readonly card_id: string;
  readonly replay: boolean;
  readonly ordered_calls: readonly string[];
  readonly executor_outcome: string;
}

export interface SuccessChainResult {
  readonly ok: boolean;
  readonly receipts: readonly ChainReceipt[];
  readonly real_call_count: number;
}

export interface ScenarioRunInput {
  readonly scenario_id: ScenarioId;
  readonly process_restart?: boolean;
}

export interface ScenarioRunResult {
  readonly scenario_id: ScenarioId;
  readonly ok: boolean;
  readonly failed_at_gate: string | null;
  readonly circuit_opened: boolean;
  readonly retry_attempted: boolean;
  readonly adapter_attempted: boolean;
  readonly forbidden_adapter_called: boolean;
  readonly operator_card_count: number;
  readonly real_call_count: number;
  readonly receipt: ChainReceipt | null;
  readonly ordered_calls?: readonly string[];
  readonly executor_outcome?: string;
}

export interface MatrixResult {
  readonly ok: boolean;
  readonly results: readonly ScenarioRunResult[];
  readonly real_call_count: number;
}

export interface ScenarioExecutionEvidence {
  readonly scenario_id: ScenarioId;
  readonly executor_outcome: string;
  readonly ordered_calls: readonly string[];
  /** Executor-returned adapter evidence, when the action exposes it directly. */
  readonly executor_adapter_called?: boolean;
}

export interface DerivedScenarioOutput {
  readonly ok: boolean;
  readonly failed_at_gate: string | null;
  readonly adapter_attempted: boolean;
  readonly forbidden_adapter_called: boolean;
}

interface AdversarialEvidenceContract {
  readonly executor_outcomes: readonly string[];
  readonly failed_at_gate: string;
  readonly required_ordered_calls: readonly string[];
}

const ADVERSARIAL_EVIDENCE_CONTRACTS: Readonly<
  Record<Exclude<ScenarioId, 'success'>, AdversarialEvidenceContract>
> = {
  stale_state: {
    executor_outcomes: ['live_state_mismatch'],
    failed_at_gate: 'live_compare',
    required_ordered_calls: [
      'branch:prepare',
      'branch:authorize',
      'branch:reserve',
      'branch:outcome:effect_failed',
    ],
  },
  replay: {
    executor_outcomes: ['idempotency_conflict'],
    failed_at_gate: 'idempotency',
    required_ordered_calls: [
      'repair:outcome:effect_succeeded',
      'repair:idempotency_commit',
      'repair:record',
      'repair:idempotency_begin',
    ],
  },
  duplicate_run: {
    executor_outcomes: ['escalated'],
    failed_at_gate: 'idempotency',
    required_ordered_calls: ['repair:record'],
  },
  provider_outage: {
    executor_outcomes: ['failed'],
    failed_at_gate: 'adapter',
    required_ordered_calls: [
      'repair:prepare',
      'repair:authorize',
      'repair:reserve',
      'repair:adapter',
      'repair:outcome:effect_failed',
      'repair:idempotency_commit',
      'repair:record',
    ],
  },
  wrong_repository: {
    executor_outcomes: ['denied'],
    failed_at_gate: 'policy',
    required_ordered_calls: ['merge:record_action'],
  },
  wrong_base: {
    executor_outcomes: ['ineligible'],
    failed_at_gate: 'live_compare',
    required_ordered_calls: ['branch:observe', 'branch:count_unique'],
  },
  unresolved_review: {
    executor_outcomes: ['denied'],
    failed_at_gate: 'gate',
    required_ordered_calls: ['merge:record_action'],
  },
  semantic_conflict: {
    executor_outcomes: ['escalated'],
    failed_at_gate: 'fusion',
    required_ordered_calls: ['repair:record'],
  },
  production_target: {
    executor_outcomes: ['operator_card'],
    failed_at_gate: 'policy',
    required_ordered_calls: ['merge:record_action'],
  },
  budget_exhaustion: {
    executor_outcomes: ['escalated'],
    failed_at_gate: 'fusion_budget',
    required_ordered_calls: ['repair:record'],
  },
  indeterminate_result: {
    executor_outcomes: ['escalated'],
    failed_at_gate: 'reconciliation',
    required_ordered_calls: ['repair:circuit_open', 'repair:record'],
  },
};

const SUCCESS_EXECUTOR_OUTCOMES = new Set(['succeeded', 'merged']);

function containsOrderedSubsequence(
  calls: readonly string[],
  required: readonly string[]
): boolean {
  let cursor = 0;
  for (const call of calls) {
    if (call === required[cursor]) cursor += 1;
    if (cursor === required.length) return true;
  }
  return required.length === 0;
}

function isForbiddenAdapterCall(input: ScenarioExecutionEvidence): boolean {
  const adapterCalls = input.ordered_calls
    .map((call, index) => ({ call, index }))
    .filter(entry => entry.call.endsWith(':adapter'));

  if (input.scenario_id === 'success') return false;

  if (input.scenario_id === 'provider_outage') {
    return (
      adapterCalls.some(entry => entry.call !== 'repair:adapter') ||
      (Boolean(input.executor_adapter_called) && adapterCalls.length === 0)
    );
  }

  if (input.scenario_id === 'replay') {
    const finalBegin = input.ordered_calls.lastIndexOf('repair:idempotency_begin');
    return (
      Boolean(input.executor_adapter_called) ||
      finalBegin < 0 ||
      adapterCalls.some(entry => entry.call !== 'repair:adapter' || entry.index > finalBegin)
    );
  }

  return Boolean(input.executor_adapter_called) || adapterCalls.length > 0;
}

/**
 * Derive published scenario fields from executor output and observed call order.
 * A named failure gate is emitted only when both the expected executor outcome
 * and its ordered execution evidence are present, with no forbidden adapter.
 */
export function deriveScenarioOutput(input: ScenarioExecutionEvidence): DerivedScenarioOutput {
  const adapterAttempted =
    Boolean(input.executor_adapter_called) ||
    input.ordered_calls.some(call => call.endsWith(':adapter'));
  const forbiddenAdapterCalled = isForbiddenAdapterCall(input);
  const ok = SUCCESS_EXECUTOR_OUTCOMES.has(input.executor_outcome) && !forbiddenAdapterCalled;

  if (input.scenario_id === 'success') {
    return {
      ok,
      failed_at_gate: null,
      adapter_attempted: adapterAttempted,
      forbidden_adapter_called: forbiddenAdapterCalled,
    };
  }

  const contract = ADVERSARIAL_EVIDENCE_CONTRACTS[input.scenario_id];
  const failureProven =
    contract.executor_outcomes.includes(input.executor_outcome) &&
    containsOrderedSubsequence(input.ordered_calls, contract.required_ordered_calls) &&
    !forbiddenAdapterCalled;

  return {
    ok,
    failed_at_gate: failureProven ? contract.failed_at_gate : null,
    adapter_attempted: adapterAttempted,
    forbidden_adapter_called: forbiddenAdapterCalled,
  };
}

/**
 * Assert all five capabilities are off, emergency stop is on, and circuits
 * are reported exactly (never silently mapped to closed).
 */
export function assertOverseerDefaultOff(input: DefaultOffInput): DefaultOffResult {
  const reasons: string[] = [];
  const disabled: string[] = [];

  for (const cap of OVERSEER_CAPABILITIES) {
    if (!(cap in input.capabilities)) {
      reasons.push(`capability_missing:${cap}`);
    } else if (input.capabilities[cap]) {
      reasons.push(`capability_enabled:${cap}`);
    } else {
      disabled.push(cap);
    }
    if (!(cap in input.circuits)) {
      reasons.push(`circuit_missing:${cap}`);
    }
  }

  if (!input.emergency_stop) {
    reasons.push('emergency_stop_not_engaged');
  }

  disabled.sort();

  return {
    ok: reasons.length === 0,
    disabled_capabilities: disabled,
    emergency_stop: input.emergency_stop,
    circuits: { ...input.circuits },
    reasons,
  };
}

function resolveTracker(deps: ScenarioDeps): RealCallTracker {
  if (deps.call_tracker) return deps.call_tracker;
  // Bridge legacy getRealCallCount DI for unit tests.
  if (deps.getRealCallCount) {
    return {
      reasons: [],
      recordRealCall(): void {
        /* observed only via getRealCallCount override */
      },
      getRealCallCount: () => deps.getRealCallCount?.() ?? 0,
    };
  }
  return createRealCallTracker();
}

function realCount(deps: ScenarioDeps, tracker: RealCallTracker): number {
  if (deps.getRealCallCount) return deps.getRealCallCount();
  return tracker.getRealCallCount();
}

function assertFakeOnly(deps: ScenarioDeps): void {
  if (deps.adapter_mode !== 'fake') {
    throw new Error(`integration_scenarios_require_fake_adapter:${deps.adapter_mode}`);
  }
}

function assertZeroRealCalls(deps: ScenarioDeps, tracker: RealCallTracker, phase: string): void {
  const count = realCount(deps, tracker);
  if (count > 0) {
    throw new Error(`real_provider_call_detected:${phase}:count=${count}`);
  }
}

function guardRealProviderCall(deps: ScenarioDeps, tracker: RealCallTracker): ScenarioDeps {
  if (!deps.real_provider_call) return deps;
  const original = deps.real_provider_call;
  return {
    ...deps,
    real_provider_call: (): never => {
      tracker.recordRealCall('real_provider_call');
      try {
        original();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`real_provider_call_forbidden:${message}`);
      }
      throw new Error('real_provider_call_forbidden:completed_without_throw');
    },
  };
}

function chainReceipt(partial: Omit<ChainReceipt, never>): ChainReceipt {
  return partial;
}

/** Serial fake success chain: repair -> branch -> lifecycle -> merge. */
export async function runIntegratedSuccessChain(deps: ScenarioDeps): Promise<SuccessChainResult> {
  assertFakeOnly(deps);
  const tracker = resolveTracker(deps);
  const guarded = guardRealProviderCall(deps, tracker);
  assertZeroRealCalls(guarded, tracker, 'success_chain_start');

  const repairH = makeRepairHarness();
  const repair = await runRepairSuccess(repairH);
  if (repair.result.outcome !== 'succeeded') {
    throw new Error(`success_chain_repair_failed:${repair.result.outcome}:${repair.result.reason}`);
  }

  const branchH = makeBranchHarness();
  const branch = await runBranchSuccess(branchH);
  if (branch.result.outcome !== 'succeeded') {
    throw new Error(`success_chain_branch_failed:${branch.result.outcome}:${branch.result.reason}`);
  }

  const lifeH = makeLifecycleHarness();
  const life = await runLifecycleSuccess(lifeH);
  if (life.result.outcome !== 'succeeded') {
    throw new Error(`success_chain_lifecycle_failed:${life.result.outcome}:${life.result.reason}`);
  }

  const mergeH = makeMergeHarness();
  const merge = await runMergeSuccess(mergeH);
  if (!merge.result.merged || merge.result.primaryOutcome !== 'effect_succeeded') {
    throw new Error(`success_chain_merge_failed:${merge.result.action}:${merge.result.reason}`);
  }

  const receipts: ChainReceipt[] = [
    chainReceipt({
      capability: 'repair',
      proposal: 'm31v2-proposal-repair-1',
      permit_issued: repair.ordered.includes('repair:prepare'),
      gate: 'allowed',
      effect_reserved: repair.ordered.includes('repair:reserve'),
      primary_outcome: 'effect_succeeded',
      card_id: 'card-repair-success',
      replay: false,
      ordered_calls: repair.ordered,
      executor_outcome: repair.result.outcome,
    }),
    chainReceipt({
      capability: 'branch',
      proposal: 'm31v2-proposal-branch-1',
      permit_issued: branch.ordered.includes('branch:prepare'),
      gate: 'allowed',
      effect_reserved: branch.ordered.includes('branch:reserve'),
      primary_outcome: 'effect_succeeded',
      card_id: 'card-branch-success',
      replay: false,
      ordered_calls: branch.ordered,
      executor_outcome: branch.result.outcome,
    }),
    chainReceipt({
      capability: 'lifecycle',
      proposal: 'm31v2-proposal-lifecycle-comment',
      permit_issued: life.ordered.includes('lifecycle:prepare'),
      gate: 'allowed',
      effect_reserved: life.ordered.includes('lifecycle:reserve'),
      primary_outcome: 'effect_succeeded',
      card_id: 'card-lifecycle-success',
      replay: false,
      ordered_calls: life.ordered,
      executor_outcome: life.result.outcome,
    }),
    chainReceipt({
      capability: 'merge',
      proposal: 'm31v2-proposal-merge-1',
      permit_issued: merge.ordered.includes('merge:prepare'),
      gate: 'allowed',
      effect_reserved: merge.ordered.includes('merge:reserve'),
      primary_outcome: 'effect_succeeded',
      card_id: 'card-merge-success',
      replay: false,
      ordered_calls: merge.ordered,
      executor_outcome: merge.result.action,
    }),
  ];

  // Prove ordered gate chain for each capability.
  for (const receipt of receipts) {
    const joins = receipt.ordered_calls.join(',');
    if (receipt.capability === 'repair') {
      if (!joins.includes('repair:prepare') || !joins.includes('repair:authorize')) {
        throw new Error(`success_chain_missing_gate_order:repair:${joins}`);
      }
      if (!joins.includes('repair:reserve') || !joins.includes('repair:adapter')) {
        throw new Error(`success_chain_missing_adapter_order:repair:${joins}`);
      }
    }
    if (receipt.capability === 'branch') {
      if (!joins.includes('branch:prepare') || !joins.includes('branch:authorize')) {
        throw new Error(`success_chain_missing_gate_order:branch:${joins}`);
      }
      if (!joins.includes('branch:reserve') || !joins.includes('branch:adapter')) {
        throw new Error(`success_chain_missing_adapter_order:branch:${joins}`);
      }
    }
    if (receipt.capability === 'lifecycle') {
      if (!joins.includes('lifecycle:prepare') || !joins.includes('lifecycle:authorize')) {
        throw new Error(`success_chain_missing_gate_order:lifecycle:${joins}`);
      }
      if (!joins.includes('lifecycle:reserve') || !joins.includes('lifecycle:adapter')) {
        throw new Error(`success_chain_missing_adapter_order:lifecycle:${joins}`);
      }
    }
    if (receipt.capability === 'merge') {
      if (!joins.includes('merge:prepare') || !joins.includes('merge:authorize')) {
        throw new Error(`success_chain_missing_gate_order:merge:${joins}`);
      }
      if (!joins.includes('merge:reserve') || !joins.includes('merge:adapter')) {
        throw new Error(`success_chain_missing_adapter_order:merge:${joins}`);
      }
    }
  }

  assertZeroRealCalls(guarded, tracker, 'success_chain_end');
  return {
    ok: true,
    receipts,
    real_call_count: realCount(guarded, tracker),
  };
}

async function runStaleState(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeBranchHarness({ liveHeadDrift: true });
  const result = await executeRefreshRebase(branchExecInput(), harness.deps);
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'stale_state',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'stale_state');
  return {
    scenario_id: 'stale_state',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runReplay(deps: ScenarioDeps, tracker: RealCallTracker): Promise<ScenarioRunResult> {
  // Idempotency conflict: same key, different request digest.
  const harness = makeRepairHarness({ conflictIdempotency: true });
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  // Seed with different digest under same key by first begin with digest A via preseed.
  const first = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  // Force conflict: change failure_digest so request digest differs under same key.
  const second = await executeRepairRefire(
    repairExecInput(assessment, {
      failure_digest: 'ff'.repeat(32),
      idempotency_key: 'idem-repair-1',
    }),
    harness.deps
  );
  void first;
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'replay',
    executor_outcome: second.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'replay');
  return {
    scenario_id: 'replay',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: second.outcome,
  };
}

async function runDuplicateRun(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: true,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const harness = makeRepairHarness();
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'duplicate_run',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'duplicate_run');
  return {
    scenario_id: 'duplicate_run',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runProviderOutage(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeRepairHarness({ onRampStatus: 'failed' });
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'provider_outage',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'provider_outage');
  return {
    scenario_id: 'provider_outage',
    ...derived,
    circuit_opened: harness.circuitOpened.value,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runWrongRepository(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeMergeHarness();
  const result = await executeQualifiedMerge(
    mergeEvidence({ repository: 'external-repo-not-allowlisted' }),
    harness.deps
  );
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'wrong_repository',
    executor_outcome: result.action,
    ordered_calls: orderedCalls,
    executor_adapter_called: result.adapterCalled,
  });
  assertZeroRealCalls(deps, tracker, 'wrong_repository');
  return {
    scenario_id: 'wrong_repository',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.action,
  };
}

async function runWrongBase(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeBranchHarness();
  const result = await executeRefreshRebase(
    branchExecInput({
      pr_snapshot: {
        pr_number: 42,
        head_sha: 'c'.repeat(40),
        base_branch: 'dev',
        base_sha: 'f'.repeat(40),
      },
    }),
    harness.deps
  );
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'wrong_base',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'wrong_base');
  return {
    scenario_id: 'wrong_base',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runUnresolvedReview(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeMergeHarness();
  const result = await executeQualifiedMerge(
    mergeEvidence({ reviews: [{ resolved: false }] }),
    harness.deps
  );
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'unresolved_review',
    executor_outcome: result.action,
    ordered_calls: orderedCalls,
    executor_adapter_called: result.adapterCalled,
  });
  assertZeroRealCalls(deps, tracker, 'unresolved_review');
  return {
    scenario_id: 'unresolved_review',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.action,
  };
}

async function runSemanticConflict(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: true,
    fusion_available: false,
    repairable_in_place: false,
  });
  const harness = makeRepairHarness();
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'semantic_conflict',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'semantic_conflict');
  return {
    scenario_id: 'semantic_conflict',
    ...derived,
    circuit_opened: harness.circuitOpened.value,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runProductionTarget(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const harness = makeMergeHarness();
  const result = await executeQualifiedMerge(
    mergeEvidence({ resulting_deployment_effect: 'production' }),
    harness.deps
  );
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'production_target',
    executor_outcome: result.action,
    ordered_calls: orderedCalls,
    executor_adapter_called: result.adapterCalled,
  });
  assertZeroRealCalls(deps, tracker, 'production_target');
  return {
    scenario_id: 'production_target',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.action,
  };
}

async function runBudgetExhaustion(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: 2,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const harness = makeRepairHarness();
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'budget_exhaustion',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'budget_exhaustion');
  return {
    scenario_id: 'budget_exhaustion',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runIndeterminate(
  deps: ScenarioDeps,
  tracker: RealCallTracker,
  processRestart: boolean
): Promise<ScenarioRunResult> {
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: true,
    salvage_complete: true,
    automatic_attempt_count: 0,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const harness = makeRepairHarness();
  const result = await executeRepairRefire(repairExecInput(assessment), harness.deps);
  const card = buildIndeterminateOperatorCard({
    run_id: 'run-pred-1',
    wo_id: 'WO-M42-S8-INTEGRATION',
    capability: 'repair',
  });
  const reconciliation = await runIndeterminateOperatorCardReconciliation({
    run_id: 'run-pred-1',
    wo_id: 'WO-M42-S8-INTEGRATION',
    capability: 'repair',
  });
  // Restart-indeterminate: real reconciliation path already escalated + opened circuit;
  // assert no retry of the mutating adapter after restart signal.
  const retryAttempted = processRestart
    ? harness.callLog.snapshot().includes('repair:adapter')
    : false;
  const orderedCalls = harness.callLog.snapshot();
  const derived = deriveScenarioOutput({
    scenario_id: 'indeterminate_result',
    executor_outcome: result.outcome,
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'indeterminate_result');
  return {
    scenario_id: 'indeterminate_result',
    ...derived,
    circuit_opened: harness.circuitOpened.value || result.outcome === 'escalated',
    retry_attempted: retryAttempted,
    operator_card_count:
      card.card_id === reconciliation.card_id &&
      reconciliation.deliver_calls === 0 &&
      reconciliation.reconcile_calls === 1 &&
      reconciliation.terminal_outcome === 'indeterminate'
        ? 1
        : 0,
    real_call_count: realCount(deps, tracker),
    receipt: null,
    ordered_calls: orderedCalls,
    executor_outcome: result.outcome,
  };
}

async function runSuccessScenario(
  deps: ScenarioDeps,
  tracker: RealCallTracker
): Promise<ScenarioRunResult> {
  const chain = await runIntegratedSuccessChain(deps);
  const repairReceipt = chain.receipts[0] ?? null;
  const orderedCalls = chain.receipts.flatMap(receipt => receipt.ordered_calls);
  const derived = deriveScenarioOutput({
    scenario_id: 'success',
    executor_outcome: chain.ok ? 'succeeded' : 'failed',
    ordered_calls: orderedCalls,
  });
  assertZeroRealCalls(deps, tracker, 'scenario_end:success');
  return {
    scenario_id: 'success',
    ...derived,
    circuit_opened: false,
    retry_attempted: false,
    operator_card_count: 1,
    real_call_count: realCount(deps, tracker),
    receipt: repairReceipt,
    ordered_calls: orderedCalls,
    executor_outcome: chain.ok ? 'succeeded' : 'failed',
  };
}

/**
 * Run one deterministic adversarial (or success) scenario against fake deps.
 * Each path invokes real S4-S7 exported functions (not prewritten theater rows).
 */
export async function runOverseerAdversarialScenario(
  input: ScenarioRunInput,
  deps: ScenarioDeps
): Promise<ScenarioRunResult> {
  assertFakeOnly(deps);
  const tracker = resolveTracker(deps);
  const guarded = guardRealProviderCall(deps, tracker);
  assertZeroRealCalls(guarded, tracker, `scenario_start:${input.scenario_id}`);

  switch (input.scenario_id) {
    case 'success':
      return runSuccessScenario(guarded, tracker);
    case 'stale_state':
      return runStaleState(guarded, tracker);
    case 'replay':
      return runReplay(guarded, tracker);
    case 'duplicate_run':
      return runDuplicateRun(guarded, tracker);
    case 'provider_outage':
      return runProviderOutage(guarded, tracker);
    case 'wrong_repository':
      return runWrongRepository(guarded, tracker);
    case 'wrong_base':
      return runWrongBase(guarded, tracker);
    case 'unresolved_review':
      return runUnresolvedReview(guarded, tracker);
    case 'semantic_conflict':
      return runSemanticConflict(guarded, tracker);
    case 'production_target':
      return runProductionTarget(guarded, tracker);
    case 'budget_exhaustion':
      return runBudgetExhaustion(guarded, tracker);
    case 'indeterminate_result':
      return runIndeterminate(guarded, tracker, Boolean(input.process_restart));
    default: {
      const unknownId: never = input.scenario_id;
      throw new Error(`unknown_scenario:${String(unknownId)}`);
    }
  }
}

/** Execute the full twelve-scenario matrix. */
export async function runOverseerAdversarialMatrix(deps: ScenarioDeps): Promise<MatrixResult> {
  assertFakeOnly(deps);
  const tracker = resolveTracker(deps);
  const guarded = guardRealProviderCall(deps, tracker);
  assertZeroRealCalls(guarded, tracker, 'matrix_start');
  const results: ScenarioRunResult[] = [];
  for (const scenarioId of ADVERSARIAL_SCENARIO_IDS) {
    results.push(
      await runOverseerAdversarialScenario(
        {
          scenario_id: scenarioId,
          process_restart: scenarioId === 'indeterminate_result',
        },
        guarded
      )
    );
  }
  assertZeroRealCalls(guarded, tracker, 'matrix_end');
  const ok =
    results.every(r =>
      r.scenario_id === 'success'
        ? r.ok && !r.forbidden_adapter_called
        : !r.ok && r.failed_at_gate !== null && !r.forbidden_adapter_called
    ) && realCount(guarded, tracker) === 0;
  return {
    ok,
    results,
    real_call_count: realCount(guarded, tracker),
  };
}

/**
 * Test/helper: invoke the real_provider_call boundary and assert it throws.
 */
export function invokeRealProviderBoundary(deps: ScenarioDeps): never {
  assertFakeOnly(deps);
  const tracker = resolveTracker(deps);
  const guarded = guardRealProviderCall(deps, tracker);
  if (!guarded.real_provider_call) {
    throw new Error('real_provider_call_not_configured');
  }
  guarded.real_provider_call();
  throw new Error('real_provider_call_did_not_throw');
}
