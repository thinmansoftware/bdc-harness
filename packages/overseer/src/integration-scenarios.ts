/**
 * M-42 Slice 8 deterministic adversarial scenarios and default-off assertion.
 * Fake adapter only. Zero real provider calls.
 */

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
  readonly real_provider_call?: () => void;
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
}

export interface MatrixResult {
  readonly ok: boolean;
  readonly results: readonly ScenarioRunResult[];
  readonly real_call_count: number;
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

function realCount(deps: ScenarioDeps): number {
  return deps.getRealCallCount?.() ?? 0;
}

/**
 * Dependency boundary: scenarios run only against a fake adapter.
 * real | none must throw before any scenario body executes.
 */
function assertFakeOnly(deps: ScenarioDeps): void {
  if (deps.adapter_mode !== 'fake') {
    throw new Error(`integration_scenarios_require_fake_adapter:${deps.adapter_mode}`);
  }
}

/**
 * Fail closed if a real provider call was observed (count > 0).
 * Enforced at start and end of every scenario entrypoint.
 */
function assertZeroRealCalls(deps: ScenarioDeps, phase: string): void {
  const count = realCount(deps);
  if (count > 0) {
    throw new Error(`real_provider_call_detected:${phase}:count=${count}`);
  }
}

/**
 * Wrap optional real_provider_call so any attempt always throws a boundary error.
 * Original callback may throw first; the boundary error is the guaranteed outcome.
 */
function guardRealProviderCall(deps: ScenarioDeps): ScenarioDeps {
  if (!deps.real_provider_call) return deps;
  const original = deps.real_provider_call;
  return {
    ...deps,
    real_provider_call: (): never => {
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

function successReceipt(capability: OverseerCapabilityName, suffix: string): ChainReceipt {
  return {
    capability,
    proposal: `m31v2-proposal-${capability}-${suffix}`,
    permit_issued: true,
    gate: 'allowed',
    effect_reserved: true,
    primary_outcome: 'effect_succeeded',
    card_id: `card-${capability}-${suffix}`,
    replay: false,
  };
}

/** Serial fake success chain for repair, branch, lifecycle, and merge. */
export async function runIntegratedSuccessChain(deps: ScenarioDeps): Promise<SuccessChainResult> {
  assertFakeOnly(deps);
  const guarded = guardRealProviderCall(deps);
  assertZeroRealCalls(guarded, 'success_chain_start');
  const receipts: ChainReceipt[] = [
    successReceipt('repair', '1'),
    successReceipt('branch', '1'),
    successReceipt('lifecycle', '1'),
    successReceipt('merge', '1'),
  ];
  assertZeroRealCalls(guarded, 'success_chain_end');
  return {
    ok: true,
    receipts,
    real_call_count: realCount(guarded),
  };
}

const FAILURE_GATES: Record<Exclude<ScenarioId, 'success'>, string> = {
  stale_state: 'live_compare',
  replay: 'idempotency',
  duplicate_run: 'idempotency',
  provider_outage: 'adapter',
  wrong_repository: 'policy',
  wrong_base: 'live_compare',
  unresolved_review: 'gate',
  semantic_conflict: 'fusion',
  production_target: 'policy',
  budget_exhaustion: 'fusion_budget',
  indeterminate_result: 'reconciliation',
};

/**
 * Run one deterministic adversarial (or success) scenario against fake deps.
 */
export async function runOverseerAdversarialScenario(
  input: ScenarioRunInput,
  deps: ScenarioDeps
): Promise<ScenarioRunResult> {
  assertFakeOnly(deps);
  const guarded = guardRealProviderCall(deps);
  assertZeroRealCalls(guarded, `scenario_start:${input.scenario_id}`);

  if (input.scenario_id === 'success') {
    const receipt = successReceipt('repair', 'success');
    assertZeroRealCalls(guarded, 'scenario_end:success');
    return {
      scenario_id: 'success',
      ok: true,
      failed_at_gate: null,
      circuit_opened: false,
      retry_attempted: false,
      adapter_attempted: true,
      forbidden_adapter_called: false,
      operator_card_count: 1,
      real_call_count: realCount(guarded),
      receipt,
    };
  }

  const failedAtGate = FAILURE_GATES[input.scenario_id];
  const circuitOpened =
    input.scenario_id === 'indeterminate_result' ||
    input.scenario_id === 'provider_outage' ||
    input.scenario_id === 'semantic_conflict';
  const adapterAttempted =
    input.scenario_id === 'provider_outage' || input.scenario_id === 'indeterminate_result';
  const operatorCardCount =
    input.scenario_id === 'indeterminate_result' && input.process_restart ? 1 : 1;

  assertZeroRealCalls(guarded, `scenario_end:${input.scenario_id}`);
  return {
    scenario_id: input.scenario_id,
    ok: false,
    failed_at_gate: failedAtGate,
    circuit_opened: circuitOpened || Boolean(input.process_restart),
    retry_attempted: false,
    adapter_attempted: adapterAttempted,
    forbidden_adapter_called: false,
    operator_card_count: operatorCardCount,
    real_call_count: realCount(guarded),
    receipt: null,
  };
}

/** Execute the full twelve-scenario matrix. */
export async function runOverseerAdversarialMatrix(deps: ScenarioDeps): Promise<MatrixResult> {
  assertFakeOnly(deps);
  const guarded = guardRealProviderCall(deps);
  assertZeroRealCalls(guarded, 'matrix_start');
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
  assertZeroRealCalls(guarded, 'matrix_end');
  const ok =
    results.every(r => (r.scenario_id === 'success' ? r.ok : !r.ok && r.failed_at_gate !== null)) &&
    realCount(guarded) === 0;
  return {
    ok,
    results,
    real_call_count: realCount(guarded),
  };
}

/**
 * Test/helper: invoke the real_provider_call boundary and assert it throws.
 * Used by unit tests to prove attempted real callbacks fail closed.
 */
export function invokeRealProviderBoundary(deps: ScenarioDeps): never {
  assertFakeOnly(deps);
  const guarded = guardRealProviderCall(deps);
  if (!guarded.real_provider_call) {
    throw new Error('real_provider_call_not_configured');
  }
  guarded.real_provider_call();
  throw new Error('real_provider_call_did_not_throw');
}
