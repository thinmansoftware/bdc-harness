import { describe, expect, test } from 'bun:test';
import {
  ADVERSARIAL_SCENARIO_IDS,
  assertOverseerDefaultOff,
  deriveScenarioOutput,
  invokeRealProviderBoundary,
  runOverseerAdversarialScenario,
  runOverseerAdversarialMatrix,
  runIntegratedSuccessChain,
  type ScenarioDeps,
  type ScenarioId,
} from '../integration-scenarios';
import { createRealCallTracker } from '../integration-fixtures';

function makeDeps(overrides: Partial<ScenarioDeps> = {}): ScenarioDeps {
  const tracker = createRealCallTracker();
  let realCalls = 0;
  return {
    adapter_mode: 'fake',
    call_tracker: tracker,
    real_provider_call: () => {
      realCalls += 1;
      tracker.recordRealCall('test_real_provider');
      throw new Error('real_provider_forbidden');
    },
    getRealCallCount: () => realCalls + tracker.getRealCallCount(),
    ...overrides,
  };
}

describe('assertOverseerDefaultOff', () => {
  test('requires five capabilities off, emergency stop on, and exact circuit report', () => {
    const ok = assertOverseerDefaultOff({
      capabilities: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: false,
      },
      emergency_stop: true,
      circuits: {
        escalation: 'closed',
        repair: 'closed',
        branch: 'closed',
        lifecycle: 'closed',
        merge: 'closed',
      },
    });
    expect(ok.ok).toBe(true);
    expect(ok.disabled_capabilities).toEqual([
      'branch',
      'escalation',
      'lifecycle',
      'merge',
      'repair',
    ]);

    const bad = assertOverseerDefaultOff({
      capabilities: {
        escalation: false,
        repair: true,
        branch: false,
        lifecycle: false,
        merge: false,
      },
      emergency_stop: true,
      circuits: {
        escalation: 'closed',
        repair: 'closed',
        branch: 'closed',
        lifecycle: 'closed',
        merge: 'closed',
      },
    });
    expect(bad.ok).toBe(false);

    const stopOff = assertOverseerDefaultOff({
      capabilities: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: false,
      },
      emergency_stop: false,
      circuits: {
        escalation: 'closed',
        repair: 'closed',
        branch: 'closed',
        lifecycle: 'closed',
        merge: 'closed',
      },
    });
    expect(stopOff.ok).toBe(false);

    const missingCapability = assertOverseerDefaultOff({
      capabilities: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
      } as never,
      emergency_stop: true,
      circuits: {
        escalation: 'closed',
        repair: 'closed',
        branch: 'closed',
        lifecycle: 'closed',
        merge: 'closed',
      },
    });
    expect(missingCapability.ok).toBe(false);
    expect(missingCapability.reasons).toContain('capability_missing:merge');
  });
});

describe('integrated success chain', () => {
  test('repair/refire, refresh/rebase, lifecycle, and merge produce exact receipt chain with zero real calls', async () => {
    const deps = makeDeps();
    const result = await runIntegratedSuccessChain(deps);
    expect(result.ok).toBe(true);
    expect(result.real_call_count).toBe(0);
    expect(result.receipts).toHaveLength(4);
    const expectedCaps = ['repair', 'branch', 'lifecycle', 'merge'];
    for (let i = 0; i < result.receipts.length; i++) {
      const receipt = result.receipts[i]!;
      expect(receipt.capability).toBe(expectedCaps[i]);
      expect(receipt.proposal).toBeTruthy();
      expect(receipt.permit_issued).toBe(true);
      expect(receipt.gate).toBe('allowed');
      expect(receipt.effect_reserved).toBe(true);
      expect(receipt.primary_outcome).toBe('effect_succeeded');
      expect(receipt.card_id).toBeTruthy();
      expect(receipt.replay).toBe(false);
      expect(receipt.ordered_calls.length).toBeGreaterThan(0);
      expect(receipt.ordered_calls.some(c => c.includes('prepare'))).toBe(true);
      expect(receipt.ordered_calls.some(c => c.includes('reserve'))).toBe(true);
      expect(receipt.ordered_calls.some(c => c.includes('adapter'))).toBe(true);
    }
  });
});

describe('adversarial matrix', () => {
  test('covers all twelve required failure scenarios with zero real provider calls', async () => {
    expect(ADVERSARIAL_SCENARIO_IDS).toHaveLength(12);
    const deps = makeDeps();
    const matrix = await runOverseerAdversarialMatrix(deps);
    expect(matrix.ok).toBe(true);
    expect(matrix.real_call_count).toBe(0);
    expect(matrix.results).toHaveLength(12);

    for (const id of ADVERSARIAL_SCENARIO_IDS) {
      const row = matrix.results.find(r => r.scenario_id === id);
      expect(row).toBeDefined();
      if (id === 'success') {
        expect(row!.ok).toBe(true);
        expect(row!.failed_at_gate).toBeNull();
      } else {
        expect(row!.ok).toBe(false);
        expect(row!.failed_at_gate).toBeTruthy();
      }
      expect(row!.real_call_count).toBe(0);
      expect(row!.forbidden_adapter_called).toBe(false);
    }
  });

  test('each scenario fails closed at its specified gate', async () => {
    const deps = makeDeps();
    const expectations: Record<ScenarioId, { readonly gate: string; readonly outcome: string }> = {
      success: { gate: 'none', outcome: 'succeeded' },
      stale_state: { gate: 'live_compare', outcome: 'live_state_mismatch' },
      replay: { gate: 'idempotency', outcome: 'idempotency_conflict' },
      duplicate_run: { gate: 'idempotency', outcome: 'escalated' },
      provider_outage: { gate: 'adapter', outcome: 'failed' },
      wrong_repository: { gate: 'policy', outcome: 'denied' },
      wrong_base: { gate: 'live_compare', outcome: 'ineligible' },
      unresolved_review: { gate: 'gate', outcome: 'denied' },
      semantic_conflict: { gate: 'fusion', outcome: 'escalated' },
      production_target: { gate: 'policy', outcome: 'operator_card' },
      budget_exhaustion: { gate: 'fusion_budget', outcome: 'escalated' },
      indeterminate_result: { gate: 'reconciliation', outcome: 'escalated' },
    };

    for (const [scenario_id, expected] of Object.entries(expectations) as [
      ScenarioId,
      { readonly gate: string; readonly outcome: string },
    ][]) {
      if (scenario_id === 'success') continue;
      const result = await runOverseerAdversarialScenario({ scenario_id }, deps);
      expect(result.ok).toBe(false);
      expect(result.failed_at_gate).toBe(expected.gate);
      expect(result.executor_outcome).toBe(expected.outcome);
      expect(result.real_call_count).toBe(0);
    }
  });

  test('restart indeterminate effect opens circuit without retry', async () => {
    const deps = makeDeps();
    const result = await runOverseerAdversarialScenario(
      { scenario_id: 'indeterminate_result', process_restart: true },
      deps
    );
    expect(result.ok).toBe(false);
    expect(result.failed_at_gate).toBe('reconciliation');
    expect(result.circuit_opened).toBe(true);
    expect(result.retry_attempted).toBe(false);
    expect(result.operator_card_count).toBe(1);
    expect(result.real_call_count).toBe(0);
  });

  test('production target never reaches adapter', async () => {
    const deps = makeDeps();
    const result = await runOverseerAdversarialScenario({ scenario_id: 'production_target' }, deps);
    expect(result.failed_at_gate).toBe('policy');
    expect(result.adapter_attempted).toBe(false);
  });

  const negativeCases: ReadonlyArray<{
    readonly scenario_id: Exclude<ScenarioId, 'success'>;
    readonly successful_outcome: string;
    readonly injected_forbidden_call: string;
  }> = [
    {
      scenario_id: 'stale_state',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'branch:adapter',
    },
    {
      scenario_id: 'replay',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'repair:adapter',
    },
    {
      scenario_id: 'duplicate_run',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'repair:adapter',
    },
    {
      scenario_id: 'provider_outage',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'merge:adapter',
    },
    {
      scenario_id: 'wrong_repository',
      successful_outcome: 'merged',
      injected_forbidden_call: 'merge:adapter',
    },
    {
      scenario_id: 'wrong_base',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'branch:adapter',
    },
    {
      scenario_id: 'unresolved_review',
      successful_outcome: 'merged',
      injected_forbidden_call: 'merge:adapter',
    },
    {
      scenario_id: 'semantic_conflict',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'repair:adapter',
    },
    {
      scenario_id: 'production_target',
      successful_outcome: 'merged',
      injected_forbidden_call: 'merge:adapter',
    },
    {
      scenario_id: 'budget_exhaustion',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'repair:adapter',
    },
    {
      scenario_id: 'indeterminate_result',
      successful_outcome: 'succeeded',
      injected_forbidden_call: 'repair:adapter',
    },
  ];

  for (const testCase of negativeCases) {
    test(`${testCase.scenario_id} output is invalidated by a success outcome or forbidden call`, async () => {
      const actual = await runOverseerAdversarialScenario(
        { scenario_id: testCase.scenario_id, process_restart: true },
        makeDeps()
      );
      const orderedCalls = actual.ordered_calls ?? [];

      const falseSuccess = deriveScenarioOutput({
        scenario_id: testCase.scenario_id,
        executor_outcome: testCase.successful_outcome,
        ordered_calls: orderedCalls,
      });
      expect(falseSuccess.ok).toBe(true);
      expect(falseSuccess.failed_at_gate).toBeNull();

      const missingExecutionEvidence = deriveScenarioOutput({
        scenario_id: testCase.scenario_id,
        executor_outcome: actual.executor_outcome ?? '',
        ordered_calls: [],
      });
      expect(missingExecutionEvidence.failed_at_gate).toBeNull();

      const forbiddenCall = deriveScenarioOutput({
        scenario_id: testCase.scenario_id,
        executor_outcome: actual.executor_outcome ?? '',
        ordered_calls: [...orderedCalls, testCase.injected_forbidden_call],
        executor_adapter_called: testCase.scenario_id === 'production_target' ? true : undefined,
      });
      expect(forbiddenCall.forbidden_adapter_called).toBe(true);
      expect(forbiddenCall.failed_at_gate).toBeNull();
    });
  }
});

describe('real-call dependency boundary (anti-theater)', () => {
  test('adapter_mode real throws before any scenario body', async () => {
    const deps = makeDeps({ adapter_mode: 'real' });
    await expect(runIntegratedSuccessChain(deps)).rejects.toThrow(
      /integration_scenarios_require_fake_adapter:real/
    );
    await expect(runOverseerAdversarialMatrix(deps)).rejects.toThrow(
      /integration_scenarios_require_fake_adapter:real/
    );
    await expect(runOverseerAdversarialScenario({ scenario_id: 'success' }, deps)).rejects.toThrow(
      /integration_scenarios_require_fake_adapter:real/
    );
  });

  test('adapter_mode none throws before any scenario body', async () => {
    const deps = makeDeps({ adapter_mode: 'none' });
    await expect(runIntegratedSuccessChain(deps)).rejects.toThrow(
      /integration_scenarios_require_fake_adapter:none/
    );
    await expect(runOverseerAdversarialMatrix(deps)).rejects.toThrow(
      /integration_scenarios_require_fake_adapter:none/
    );
  });

  test('pre-existing real call count fails closed at scenario entry', async () => {
    const deps = makeDeps({ getRealCallCount: () => 1 });
    await expect(runIntegratedSuccessChain(deps)).rejects.toThrow(/real_provider_call_detected/);
    await expect(runOverseerAdversarialMatrix(deps)).rejects.toThrow(/real_provider_call_detected/);
  });

  test('attempted real provider callback throws and is a failing boundary', () => {
    const deps = makeDeps();
    expect(() => invokeRealProviderBoundary(deps)).toThrow(
      /real_provider_call_forbidden|real_provider_forbidden/
    );
  });

  test('missing real_provider_call cannot be invoked as a silent no-op', () => {
    const deps: ScenarioDeps = { adapter_mode: 'fake', getRealCallCount: () => 0 };
    expect(() => invokeRealProviderBoundary(deps)).toThrow(/real_provider_call_not_configured/);
  });
});
