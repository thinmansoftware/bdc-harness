import { describe, expect, test } from 'bun:test';
import {
  InMemoryM42Slice8BExecutionStore,
  createFakeM42Slice8BActionExecutor,
  parseM42Slice8BProcessSnapshot,
  runM42Slice8BCanary,
  type M42Slice8BActionExecutor,
  type M42Slice8BActionReceipt,
  type M42Slice8BRunnerActionName,
  type M42Slice8BSiblingFakeOptions,
} from '../m42-slice8b-canary-runner';
import {
  M42_SLICE8B_MANIFEST_SCHEMA,
  sha256IntegrityDigest,
  type M42Slice8BManifestEnvelope,
  type M42Slice8BManifestPayload,
} from '../m42-slice8b-manifest';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = `sha256:${'2'.repeat(64)}`;

function payload(overrides: Partial<M42Slice8BManifestPayload> = {}): M42Slice8BManifestPayload {
  return {
    schema_version: M42_SLICE8B_MANIFEST_SCHEMA,
    execution_id: 'exec-s8b-runner',
    mode: 'fake',
    candidate_sha: SHA_A,
    starting_sha: SHA_B,
    repository_full_name: 'thinmansoftware/bdc-harness',
    provider_repository_id: 'R_sandbox_123',
    credential_principal_id: 'principal-sandbox-only-1234',
    image_digest: DIGEST,
    fusion_caps_digest: DIGEST,
    verifier_registry_digest: DIGEST,
    action_policy_digest: DIGEST,
    expected_primary_actions: ['REFIRE', 'REFRESH', 'CLOSE', 'MERGE'],
    expected_unexpected_actions: 0,
    max_window_minutes: 60,
    no_production_effect: true,
    declared_rollback_state_digest: DIGEST,
    sibling_merge_ancestor_shas: {
      'S8B-SANDBOX-GH-ADAPTERS-01': SHA_A,
      'S8B-CAULDRON-REFIRE-BRIDGE-01': SHA_B,
      'S8B-FUSION-BUDGET-RECEIPTS-01': 'c'.repeat(40),
    },
    issued_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T13:00:00.000Z',
    ...overrides,
  };
}

function envelope(payloadValue = payload()): M42Slice8BManifestEnvelope {
  return { payload: payloadValue, payload_sha256: sha256IntegrityDigest(payloadValue) };
}

function deps(
  actions: M42Slice8BActionExecutor = createFakeM42Slice8BActionExecutor(),
  nowValues: number[] = [0, 1, 2, 3, 4, 5, 6]
) {
  let nowIndex = 0;
  return {
    expected_candidate_sha: SHA_A,
    expected_starting_sha: SHA_B,
    expected_repository_full_name: 'thinmansoftware/bdc-harness',
    expected_provider_repository_id: 'R_sandbox_123',
    nowMs: () => nowValues[Math.min(nowIndex++, nowValues.length - 1)] ?? 0,
    executionStore: new InMemoryM42Slice8BExecutionStore(),
    actions,
  };
}

function recordingExecutor(
  overrides: Partial<Record<M42Slice8BRunnerActionName, Partial<M42Slice8BActionReceipt>>> = {},
  options: M42Slice8BSiblingFakeOptions = {}
): {
  readonly actions: M42Slice8BActionExecutor;
  readonly calls: () => M42Slice8BRunnerActionName[];
} {
  const calls: M42Slice8BRunnerActionName[] = [];
  return {
    actions: {
      async execute(input) {
        calls.push(input.action);
        return createFakeM42Slice8BActionExecutor(overrides, options).execute(input);
      },
    },
    calls: () => calls,
  };
}

describe('M-42 Slice 8B canary runner scenarios', () => {
  test('full fake end-to-end executes four primary actions and reopen rollback in order', async () => {
    const executor = recordingExecutor();
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.ok).toBe(true);
    expect(receipt.attempted_primary_actions).toEqual(['REFIRE', 'REFRESH', 'CLOSE', 'MERGE']);
    expect(executor.calls()).toEqual(['REFIRE', 'REFRESH', 'CLOSE', 'REOPEN_ROLLBACK', 'MERGE']);
    expect(receipt.rollback_verified).toBe(true);
    expect(receipt.provider_call_count).toBe(0);
    expect(receipt.fake_provider_call_count).toBe(5);
    expect(receipt.fake_fusion_logic_count).toBe(10);
    expect(receipt.production_mutation_count).toBe(0);
    expect(receipt.m31_receipt_count).toBe(5);
    expect(receipt.provider_receipt_count).toBe(5);
    expect(receipt.fusion_budget_receipt_count).toBe(5);
    expect(receipt.rollback_receipt_count).toBe(1);
    expect(receipt.receipts.map(r => r.sibling_module)).toEqual([
      'actions/cauldron-refire-bridge',
      'adapters/sandbox-refresh',
      'adapters/sandbox-close',
      'adapters/sandbox-reopen',
      'adapters/sandbox-merge',
    ]);
  });

  test('indeterminate action 2 stops actions 3 and 4 and records circuit state', async () => {
    const executor = recordingExecutor({ REFRESH: { accepted: false, indeterminate: true } });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.ok).toBe(false);
    expect(receipt.stop_reason).toBe('action_indeterminate');
    expect(receipt.circuit_breaker_opened).toBe(true);
    expect(executor.calls()).toEqual(['REFIRE', 'REFRESH']);
  });

  test('60-minute window exceeded stops before the next action', async () => {
    const executor = recordingExecutor();
    const receipt = await runM42Slice8BCanary(
      envelope(),
      deps(executor.actions, [0, 1, 3_600_001])
    );
    expect(receipt.stop_reason).toBe('window_exceeded');
    expect(executor.calls()).toEqual(['REFIRE']);
  });

  test('duplicate execution ID performs zero additional actions', async () => {
    const executor = recordingExecutor();
    const sharedDeps = deps(executor.actions);
    const first = await runM42Slice8BCanary(envelope(), sharedDeps);
    const second = await runM42Slice8BCanary(envelope(), sharedDeps);
    expect(first.ok).toBe(true);
    expect(second.stop_reason).toBe('execution_duplicate');
    expect(second.attempted_primary_actions).toEqual([]);
    expect(executor.calls()).toEqual(['REFIRE', 'REFRESH', 'CLOSE', 'REOPEN_ROLLBACK', 'MERGE']);
  });

  test('token present plus mode none performs zero provider calls', async () => {
    const executor = recordingExecutor();
    const badPayload = payload({ mode: 'none' as M42Slice8BManifestPayload['mode'] });
    const receipt = await runM42Slice8BCanary(envelope(badPayload), deps(executor.actions));
    expect(receipt.stop_reason).toBe('manifest_refused');
    expect(executor.calls()).toEqual([]);
  });

  test('token present plus mode fake performs zero provider calls', async () => {
    const receipt = await runM42Slice8BCanary(envelope(payload({ mode: 'fake' })), deps());
    expect(receipt.ok).toBe(true);
    expect(receipt.provider_call_count).toBe(0);
  });

  test('mode sandbox without a carried frozen authorization performs zero calls', async () => {
    const executor = recordingExecutor();
    const receipt = await runM42Slice8BCanary(
      envelope(payload({ mode: 'sandbox' })),
      deps(executor.actions)
    );
    expect(receipt.stop_reason).toBe('gate1_refused');
    expect(executor.calls()).toEqual([]);
  });

  test('wrong repository name or immutable ID performs zero calls', async () => {
    const executor = recordingExecutor();
    const bad = envelope(payload({ repository_full_name: 'bluedevilcollectibles/other' }));
    const receipt = await runM42Slice8BCanary(bad, deps(executor.actions));
    expect(receipt.stop_reason).toBe('manifest_refused');
    expect(executor.calls()).toEqual([]);
  });

  test('sibling policy allowlist refusal stops before provider dispatch', async () => {
    const executor = recordingExecutor({}, { sandboxPolicyAllowlisted: false });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.stop_reason).toBe('action_refused');
    expect(receipt.provider_call_count).toBe(0);
    expect(receipt.fake_provider_call_count).toBe(1);
    expect(receipt.receipts.at(-1)?.sibling_module).toBe('adapters/sandbox-refresh');
  });

  test('wrong base, head, candidate, policy digest, registry digest, or principal performs zero calls', async () => {
    const executor = recordingExecutor();
    const bad = envelope(payload({ starting_sha: 'd'.repeat(40) }));
    const receipt = await runM42Slice8BCanary(bad, deps(executor.actions));
    expect(receipt.stop_reason).toBe('manifest_refused');
    expect(executor.calls()).toEqual([]);
  });

  test('stale, replayed, expired, duplicate, or conflicting execution performs zero additional calls', async () => {
    const executor = recordingExecutor();
    const sharedDeps = deps(executor.actions);
    await runM42Slice8BCanary(envelope(), sharedDeps);
    const replay = await runM42Slice8BCanary(envelope(), sharedDeps);
    expect(replay.stop_reason).toBe('execution_duplicate');
    expect(replay.receipts).toHaveLength(0);
  });

  test('same execution ID with different manifest digest records execution conflict distinctly', async () => {
    const executor = recordingExecutor();
    const sharedDeps = deps(executor.actions);
    await runM42Slice8BCanary(envelope(), sharedDeps);
    const changed = envelope(payload({ image_digest: `sha256:${'4'.repeat(64)}` }));
    const conflict = await runM42Slice8BCanary(changed, sharedDeps);
    expect(conflict.stop_reason).toBe('execution_conflict');
    expect(conflict.attempted_primary_actions).toEqual([]);
    expect(conflict.receipts).toHaveLength(0);
  });

  test('production-effect classification blocks before provider dispatch', async () => {
    const executor = recordingExecutor();
    const bad = payload({ no_production_effect: false as true });
    const receipt = await runM42Slice8BCanary(envelope(bad), deps(executor.actions));
    expect(receipt.stop_reason).toBe('manifest_refused');
    expect(executor.calls()).toEqual([]);
  });

  test('Fusion-required action blocks through real authorization logic on missing dissent', async () => {
    const executor = recordingExecutor({}, { fusionRawDissent: '' });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.stop_reason).toBe('action_refused');
    expect(receipt.fusion_call_count).toBe(0);
    expect(receipt.fake_fusion_logic_count).toBe(3);
    expect(receipt.receipts[0]?.sibling_module).toBe('fusion/authorization');
  });

  test('unexpected action receipt is counted from observed execution evidence', async () => {
    const executor = recordingExecutor({ REFRESH: { action: 'REOPEN_ROLLBACK' } });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.ok).toBe(false);
    expect(receipt.stop_reason).toBe('action_refused');
    expect(receipt.unexpected_action_count).toBe(1);
    expect(receipt.receipts.map(r => r.action)).toEqual(['REFIRE', 'REOPEN_ROLLBACK']);
  });

  test('process snapshot parser observes running Overseer service commands only', () => {
    const processes = parseM42Slice8BProcessSnapshot(
      [
        '100 30 bun run overseer:serve',
        '101 40 bun packages/overseer/src/service.ts',
        '102 50 bun packages/overseer/src/m42-slice8b-canary-runner.ts --manifest fixture.json',
      ].join('\n'),
      1_000_000
    );
    expect(processes).toEqual([
      {
        pid: 100,
        started_at_ms: 970_000,
        healthy: true,
        command: 'bun run overseer:serve',
      },
      {
        pid: 101,
        started_at_ms: 960_000,
        healthy: true,
        command: 'bun packages/overseer/src/service.ts',
      },
    ]);
  });

  test('Cauldron admission uncertainty does not create a blind second run', async () => {
    const executor = recordingExecutor({ REFIRE: { accepted: false, indeterminate: true } });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.stop_reason).toBe('action_indeterminate');
    expect(executor.calls()).toEqual(['REFIRE']);
  });

  test('provider uncertainty opens a persistent circuit breaker', async () => {
    const receipt = await runM42Slice8BCanary(
      envelope(),
      deps(
        createFakeM42Slice8BActionExecutor({ REFRESH: { accepted: false, indeterminate: true } })
      )
    );
    expect(receipt.circuit_breaker_opened).toBe(true);
  });

  test('receipt failure after a provider response stops workload and requires reconciliation', async () => {
    const executor = recordingExecutor({ MERGE: { accepted: false, provider_call_count: 1 } });
    const receipt = await runM42Slice8BCanary(envelope(), deps(executor.actions));
    expect(receipt.stop_reason).toBe('receipt_failure_after_provider_response');
    expect(receipt.provider_call_count).toBe(1);
    expect(receipt.circuit_breaker_opened).toBe(true);
    expect(receipt.xo_briefing_reconciled).toBe(false);
  });

  test('rollback restores the exact declared sandbox state with complete receipts', async () => {
    const receipt = await runM42Slice8BCanary(envelope(), deps());
    expect(receipt.rollback_verified).toBe(true);
    expect(receipt.receipts.some(r => r.rollback_state_digest === DIGEST)).toBe(true);
  });
});
