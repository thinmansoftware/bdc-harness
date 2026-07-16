import { createHash } from 'node:crypto';
import { describe, expect, mock, test } from 'bun:test';
import {
  createRepairRefireAdapter,
  type RepairRefireConductorDeps,
} from '../adapters/repair-refire.ts';
import {
  assessRepairRefireCandidate,
  captureRepairSalvage,
  countAutomaticRecoveryAttempts,
  executeRepairRefire,
  isValidOnRampResult,
  MAX_AUTOMATIC_RECOVERY_ATTEMPTS,
  type CaptureRepairSalvageInput,
  type FirstRefireOnRampDepsV1,
  type FirstRefireOnRampRequestV1,
  type FirstRefireOnRampResultV1,
  type OverseerSalvageReceiptV1,
  type RepairRefireAssessment,
  type RepairRefireAssessmentInput,
  type RepairRefireExecutionDeps,
  type RepairRefireExecutionInput,
  type RepairRefireIdempotencyState,
} from '../actions/repair-refire.ts';

// ---------------------------------------------------------------------------
// Deterministic helpers (test-only; no real process/network client)
// ---------------------------------------------------------------------------

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function baseAssessInput(
  overrides: Partial<RepairRefireAssessmentInput> = {}
): RepairRefireAssessmentInput {
  return {
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
    ...overrides,
  };
}

function sampleSalvage(): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-TEST-01',
    source_target_kind: 'workflow_run',
    source_target_key: 'run-pred-1',
    source_target_digest: sha256hex('target'),
    source_run_id: 'run-pred-1',
    worktree_path: '/tmp/worktrees/run-pred-1',
    artifact_kind: 'git_object',
    git_object_format: 'sha256',
    git_object_id: sha256hex('commit'),
    patch_path: null,
    patch_sha256: null,
    scope_digest: sha256hex('scope'),
    captured_at: '2026-07-16T00:00:00.000Z',
    verified_at: '2026-07-16T00:00:01.000Z',
  };
}

function succeededOnRamp(): FirstRefireOnRampResultV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-result-v1',
    status: 'succeeded',
    successor_run_id: 'run-succ-1',
    external_effect_reference: 'fake://effect/run-succ-1',
    evidence_digest: sha256hex('evidence'),
    reason: 'fake replacement run started',
  };
}

function execInput(
  assessment: RepairRefireAssessment,
  overrides: Partial<RepairRefireExecutionInput> = {}
): RepairRefireExecutionInput {
  return {
    assessment,
    proposal_id: 'prop-1',
    execution_id: 'exec-1',
    idempotency_key: 'idem-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-TEST-01',
    workflow_name: 'implement',
    target_digest: sha256hex('target'),
    scope_digest: sha256hex('scope'),
    failure_digest: sha256hex('failure'),
    source_run_id: 'run-pred-1',
    salvage_receipt: sampleSalvage(),
    actor: 'overseer',
    correlation_id: 'corr-1',
    ...overrides,
  };
}

interface Harness {
  deps: RepairRefireExecutionDeps;
  orderLog: string[];
  effectLedger: string[];
  spies: {
    preparePermit: ReturnType<typeof mock>;
    authorizeAction: ReturnType<typeof mock>;
    reserveEffect: ReturnType<typeof mock>;
    appendOutcome: ReturnType<typeof mock>;
    startFirstRefire: ReturnType<typeof mock>;
    pickEntryTier: ReturnType<typeof mock>;
    runCascade: ReturnType<typeof mock>;
    openRepairCircuit: ReturnType<typeof mock>;
    recordDisposition: ReturnType<typeof mock>;
    beginIdem: ReturnType<typeof mock>;
    commitIdem: ReturnType<typeof mock>;
  };
}

function makeHarness(
  opts: {
    onRampResult?: FirstRefireOnRampResultV1;
    conductorResult?: FirstRefireOnRampResultV1;
    permitOk?: boolean;
    authAllowed?: boolean;
    reserveOk?: boolean;
  } = {}
): Harness {
  const orderLog: string[] = [];
  const effectLedger: string[] = [];
  const idemMap = new Map<string, { digest: string; result?: FirstRefireOnRampResultV1 }>();

  const preparePermit = mock(async () => {
    orderLog.push('prepare');
    return { ok: opts.permitOk ?? true, reason: 'ok' };
  });
  const authorizeAction = mock(async () => {
    orderLog.push('authorize');
    return { allowed: opts.authAllowed ?? true, reason: 'allowed' };
  });
  const reserveEffect = mock(async () => {
    orderLog.push('reserve');
    effectLedger.push('effect_reserved');
    return { ok: opts.reserveOk ?? true, reason: 'ok' };
  });
  const appendOutcome = mock(async (input: { outcome: string }) => {
    effectLedger.push(input.outcome);
    return { ok: true };
  });

  const startFirstRefire = mock(async (_request: FirstRefireOnRampRequestV1) => {
    orderLog.push('adapter');
    return opts.onRampResult ?? succeededOnRamp();
  });
  const pickEntryTier = mock(() => 'tier-fast');
  const runCascade = mock(async (_input: { woId: string; entryTier: string }) => {
    orderLog.push('adapter');
    return opts.conductorResult ?? succeededOnRamp();
  });

  const onRamp: FirstRefireOnRampDepsV1 = { startFirstRefire };
  const conductor: RepairRefireConductorDeps = { pickEntryTier, runCascade };
  const adapter = createRepairRefireAdapter({
    onRamp,
    conductor,
    woClass: 'CODE',
    tags: ['overseer'],
  });

  const openRepairCircuit = mock(async () => undefined);
  const recordDisposition = mock(async () => undefined);

  const beginIdem = mock(
    async (key: string, digest: string): Promise<RepairRefireIdempotencyState> => {
      const existing = idemMap.get(key);
      if (!existing) {
        idemMap.set(key, { digest });
        return { status: 'fresh' };
      }
      if (existing.digest !== digest) return { status: 'conflict' };
      if (existing.result) return { status: 'replay', result: existing.result };
      return { status: 'fresh' };
    }
  );
  const commitIdem = mock(async (key: string, result: FirstRefireOnRampResultV1) => {
    const existing = idemMap.get(key);
    if (existing) existing.result = result;
  });

  const deps: RepairRefireExecutionDeps = {
    gate: { preparePermit, authorizeAction, reserveEffect, appendOutcome },
    adapter,
    idempotency: { begin: beginIdem, commit: commitIdem },
    circuit: { openRepairCircuit },
    recorder: { recordDisposition },
    sha256hex,
  };

  return {
    deps,
    orderLog,
    effectLedger,
    spies: {
      preparePermit,
      authorizeAction,
      reserveEffect,
      appendOutcome,
      startFirstRefire,
      pickEntryTier,
      runCascade,
      openRepairCircuit,
      recordDisposition,
      beginIdem,
      commitIdem,
    },
  };
}

// ---------------------------------------------------------------------------
// Assessment (pure) -- Mode Behavior Matrix, Section 6
// ---------------------------------------------------------------------------

describe('assessRepairRefireCandidate', () => {
  test('gate off or incomplete evidence reconciles only', () => {
    expect(
      assessRepairRefireCandidate(baseAssessInput({ action_gate_enabled: false })).disposition
    ).toBe('reconcile_only');
    expect(
      assessRepairRefireCandidate(baseAssessInput({ evidence_complete: false })).disposition
    ).toBe('reconcile_only');
  });

  test('zero prior attempts with exact target and salvage selects refire_first', () => {
    const assessment = assessRepairRefireCandidate(baseAssessInput());
    expect(assessment.disposition).toBe('refire_first');
    expect(assessment.no_mutation).toBe(false);
  });

  test('one prior attempt routes to refire_later (conductor)', () => {
    expect(
      assessRepairRefireCandidate(baseAssessInput({ automatic_attempt_count: 1 })).disposition
    ).toBe('refire_later');
  });

  test('repairable in place selects repair', () => {
    expect(
      assessRepairRefireCandidate(baseAssessInput({ repairable_in_place: true })).disposition
    ).toBe('repair');
  });

  test('two attempts hit the ceiling and escalate', () => {
    const assessment = assessRepairRefireCandidate(
      baseAssessInput({ automatic_attempt_count: MAX_AUTOMATIC_RECOVERY_ATTEMPTS })
    );
    expect(assessment.disposition).toBe('escalate');
    expect(assessment.escalation_reason).toBe('attempt_ceiling');
    expect(assessment.no_mutation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Named Stop patterns
// ---------------------------------------------------------------------------

describe('executeRepairRefire ordering', () => {
  test('prepare authorize reserve precede adapter', async () => {
    const harness = makeHarness();
    const result = await executeRepairRefire(
      execInput(assessRepairRefireCandidate(baseAssessInput())),
      harness.deps
    );

    expect(result.outcome).toBe('succeeded');
    expect(harness.orderLog).toEqual(['prepare', 'authorize', 'reserve', 'adapter']);
    const order = harness.orderLog;
    expect(order.indexOf('prepare')).toBeLessThan(order.indexOf('authorize'));
    expect(order.indexOf('authorize')).toBeLessThan(order.indexOf('reserve'));
    expect(order.indexOf('reserve')).toBeLessThan(order.indexOf('adapter'));
  });
});

describe('fake adapter effect ledger', () => {
  test('fake adapter records one reserved and one succeeded effect', async () => {
    const harness = makeHarness();
    const result = await executeRepairRefire(
      execInput(assessRepairRefireCandidate(baseAssessInput())),
      harness.deps
    );

    expect(result.outcome).toBe('succeeded');
    expect(harness.effectLedger.filter(e => e === 'effect_reserved')).toHaveLength(1);
    expect(harness.effectLedger.filter(e => e === 'effect_succeeded')).toHaveLength(1);
    // Zero real process/network/fire calls: only the injected fakes ran, and the
    // conductor path was never touched on a first attempt.
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);
    expect(harness.spies.pickEntryTier).toHaveBeenCalledTimes(0);
    expect(harness.spies.runCascade).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Test 1 -- salvage and first refire
// ---------------------------------------------------------------------------

describe('Test 1 - salvage and first refire', () => {
  test('captures salvage before cleanup and runs one successor via startFirstRefire', async () => {
    const orderLog: string[] = [];
    const capInput: CaptureRepairSalvageInput = {
      repository: 'bluedevilcollectibles/bdc-harness',
      wo_id: 'WO-TEST-01',
      source_target_kind: 'workflow_run',
      source_target_key: 'run-pred-1',
      source_target_digest: sha256hex('target'),
      source_run_id: 'run-pred-1',
      worktree_path: '/tmp/worktrees/run-pred-1',
      artifact_kind: 'git_object',
      git_object_format: 'sha256',
      git_object_id: sha256hex('commit'),
      patch_path: null,
      patch_sha256: null,
      scope_digest: sha256hex('scope'),
    };
    const persistSalvageReceipt = mock(async () => {
      orderLog.push('persist');
    });
    const cleanupWorktree = mock(async () => {
      orderLog.push('cleanup');
    });

    const receipt = await captureRepairSalvage(capInput, {
      now: async () => '2026-07-16T00:00:00.000Z',
      verifySalvage: async () => ({ verified_at: '2026-07-16T00:00:01.000Z' }),
      persistSalvageReceipt,
    });
    // Cleanup only after a complete salvage receipt exists.
    await cleanupWorktree();

    expect(receipt.git_object_id).toBe(sha256hex('commit'));
    expect(orderLog).toEqual(['persist', 'cleanup']);

    const harness = makeHarness();
    const input = execInput(assessRepairRefireCandidate(baseAssessInput()), {
      salvage_receipt: receipt,
    });
    const result = await executeRepairRefire(input, harness.deps);

    expect(result.outcome).toBe('succeeded');
    expect(result.successor_run_id).toBe('run-succ-1');
    expect(result.predecessor_run_id).toBe('run-pred-1');
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);

    // Original scope and repository binding are unchanged in the on-ramp request.
    const sentRequest = harness.spies.startFirstRefire.mock
      .calls[0][0] as FirstRefireOnRampRequestV1;
    expect(sentRequest.repository).toBe('bluedevilcollectibles/bdc-harness');
    expect(sentRequest.scope_digest).toBe(sha256hex('scope'));
    expect(sentRequest.target_digest).toBe(sha256hex('target'));
    expect(harness.effectLedger.filter(e => e === 'effect_succeeded')).toHaveLength(1);
  });

  test('exact replay returns persisted result without a second dependency call', async () => {
    const harness = makeHarness();
    const input = execInput(assessRepairRefireCandidate(baseAssessInput()));

    const first = await executeRepairRefire(input, harness.deps);
    expect(first.outcome).toBe('succeeded');
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);

    const replay = await executeRepairRefire(input, harness.deps);
    expect(replay.outcome).toBe('succeeded');
    expect(replay.successor_run_id).toBe('run-succ-1');
    // No second dependency invocation and no additional effect.
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);
    expect(harness.effectLedger.filter(e => e === 'effect_reserved')).toHaveLength(1);
    expect(harness.effectLedger.filter(e => e === 'effect_succeeded')).toHaveLength(1);
  });

  test('drifted replay returns idempotency_conflict before dependency invocation', async () => {
    const harness = makeHarness();
    const input = execInput(assessRepairRefireCandidate(baseAssessInput()));

    await executeRepairRefire(input, harness.deps);
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);

    // Same idempotency key, drifted scope digest -> different canonical request.
    const drifted = execInput(assessRepairRefireCandidate(baseAssessInput()), {
      scope_digest: sha256hex('scope-drift'),
    });
    const conflict = await executeRepairRefire(drifted, harness.deps);
    expect(conflict.outcome).toBe('idempotency_conflict');
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 2 -- later attempt uses conductor
// ---------------------------------------------------------------------------

describe('Test 2 - later attempt uses conductor', () => {
  test('second eligible attempt routes through the conductor exactly once, not direct fire', async () => {
    const harness = makeHarness();
    const input = execInput(
      assessRepairRefireCandidate(baseAssessInput({ automatic_attempt_count: 1 }))
    );
    const result = await executeRepairRefire(input, harness.deps);

    expect(result.disposition).toBe('refire_later');
    expect(result.outcome).toBe('succeeded');
    expect(harness.spies.pickEntryTier).toHaveBeenCalledTimes(1);
    expect(harness.spies.runCascade).toHaveBeenCalledTimes(1);
    // The direct on-ramp (first-attempt) dependency is never called.
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(0);
  });

  test('public attempt counter accepts only woId; forged time cannot enter the query', async () => {
    const countAutomaticAttemptsInDbWindow = mock(async (woId: string) => {
      expect(woId).toBe('WO-TEST-01');
      return 1;
    });

    const count = await countAutomaticRecoveryAttempts('WO-TEST-01', {
      countAutomaticAttemptsInDbWindow,
    });

    expect(count).toBe(1);
    expect(countAutomaticAttemptsInDbWindow).toHaveBeenCalledTimes(1);
    // The store is invoked with exactly one argument (woId); no time boundary.
    expect(countAutomaticAttemptsInDbWindow.mock.calls[0]).toHaveLength(1);
    await expect(
      countAutomaticRecoveryAttempts('', { countAutomaticAttemptsInDbWindow })
    ).rejects.toThrow('woId is required');
  });
});

// ---------------------------------------------------------------------------
// Test 3 -- attempt ceiling
// ---------------------------------------------------------------------------

describe('Test 3 - attempt ceiling', () => {
  test('two attempts in window: no permit/reservation/provider call, one escalation', async () => {
    const harness = makeHarness();
    const input = execInput(
      assessRepairRefireCandidate(
        baseAssessInput({ automatic_attempt_count: MAX_AUTOMATIC_RECOVERY_ATTEMPTS })
      )
    );
    const result = await executeRepairRefire(input, harness.deps);

    expect(result.disposition).toBe('escalate');
    expect(result.outcome).toBe('escalated');
    expect(result.successor_run_id).toBeNull();
    expect(harness.spies.preparePermit).toHaveBeenCalledTimes(0);
    expect(harness.spies.reserveEffect).toHaveBeenCalledTimes(0);
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(0);
    expect(harness.spies.runCascade).toHaveBeenCalledTimes(0);
    expect(harness.spies.recordDisposition).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4 -- duplicate owner and indeterminate attempt
// ---------------------------------------------------------------------------

describe('Test 4 - duplicate owner and indeterminate attempt', () => {
  test('active owner or run fails closed with no successor run', async () => {
    const harness = makeHarness();
    const assessment = assessRepairRefireCandidate(
      baseAssessInput({ has_active_owner_or_run: true })
    );
    expect(assessment.disposition).toBe('escalate');
    expect(assessment.escalation_reason).toBe('duplicate_owner');

    const result = await executeRepairRefire(execInput(assessment), harness.deps);
    expect(result.outcome).toBe('escalated');
    expect(result.successor_run_id).toBeNull();
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(0);
    expect(harness.spies.runCascade).toHaveBeenCalledTimes(0);
    // Circuit stays as-is for a plain duplicate owner (no indeterminate effect).
    expect(harness.spies.openRepairCircuit).toHaveBeenCalledTimes(0);
  });

  test('indeterminate prior effect opens the repair circuit and creates no successor', async () => {
    const harness = makeHarness();
    const assessment = assessRepairRefireCandidate(
      baseAssessInput({ has_indeterminate_prior_effect: true })
    );
    expect(assessment.disposition).toBe('escalate');
    expect(assessment.escalation_reason).toBe('indeterminate_prior_effect');
    expect(assessment.requires_circuit_open).toBe(true);

    const result = await executeRepairRefire(execInput(assessment), harness.deps);
    expect(result.outcome).toBe('escalated');
    expect(result.successor_run_id).toBeNull();
    expect(harness.spies.openRepairCircuit).toHaveBeenCalledTimes(1);
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(0);
    expect(harness.spies.reserveEffect).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5 -- semantic repair
// ---------------------------------------------------------------------------

describe('Test 5 - semantic repair', () => {
  test('scope change without Fusion escalates with no cheaper verifier or patch', async () => {
    const harness = makeHarness();
    const assessment = assessRepairRefireCandidate(
      baseAssessInput({ scope_changed: true, fusion_available: false })
    );
    expect(assessment.disposition).toBe('escalate');
    expect(assessment.escalation_reason).toBe('semantic_or_scope_dispute');

    const result = await executeRepairRefire(execInput(assessment), harness.deps);
    expect(result.outcome).toBe('escalated');
    expect(harness.spies.startFirstRefire).toHaveBeenCalledTimes(0);
    expect(harness.spies.reserveEffect).toHaveBeenCalledTimes(0);
  });

  test('semantic dispute without Fusion escalates', () => {
    const assessment = assessRepairRefireCandidate(
      baseAssessInput({ semantic_dispute: true, fusion_available: false })
    );
    expect(assessment.disposition).toBe('escalate');
    expect(assessment.escalation_reason).toBe('semantic_or_scope_dispute');
  });
});

// ---------------------------------------------------------------------------
// Supporting invariants
// ---------------------------------------------------------------------------

describe('salvage receipt and on-ramp result invariants', () => {
  test('patch salvage requires path and sha256 and rejects git object fields', async () => {
    const now = async () => '2026-07-16T00:00:00.000Z';
    const verifySalvage = async () => ({ verified_at: '2026-07-16T00:00:00.500Z' });
    const persistSalvageReceipt = mock(async () => undefined);

    const patchInput: CaptureRepairSalvageInput = {
      repository: 'bluedevilcollectibles/bdc-harness',
      wo_id: 'WO-TEST-01',
      source_target_kind: 'workflow_run',
      source_target_key: 'run-pred-1',
      source_target_digest: sha256hex('target'),
      source_run_id: 'run-pred-1',
      worktree_path: '/tmp/worktrees/run-pred-1',
      artifact_kind: 'patch',
      git_object_format: null,
      git_object_id: null,
      patch_path: 'artifacts/salvage/run-pred-1.patch',
      patch_sha256: sha256hex('patch'),
      scope_digest: sha256hex('scope'),
    };
    const receipt = await captureRepairSalvage(patchInput, {
      now,
      verifySalvage,
      persistSalvageReceipt,
    });
    expect(receipt.artifact_kind).toBe('patch');
    expect(persistSalvageReceipt).toHaveBeenCalledTimes(1);

    await expect(
      captureRepairSalvage(
        { ...patchInput, patch_sha256: null },
        {
          now,
          verifySalvage,
          persistSalvageReceipt,
        }
      )
    ).rejects.toThrow('patch salvage requires path and sha256');
  });

  test('captureRepairSalvage rejects non-monotonic verification time', async () => {
    await expect(
      captureRepairSalvage(
        {
          repository: 'bluedevilcollectibles/bdc-harness',
          wo_id: 'WO-TEST-01',
          source_target_kind: 'workflow_run',
          source_target_key: 'run-pred-1',
          source_target_digest: sha256hex('target'),
          source_run_id: 'run-pred-1',
          worktree_path: '/tmp/worktrees/run-pred-1',
          artifact_kind: 'git_object',
          git_object_format: 'sha256',
          git_object_id: sha256hex('commit'),
          patch_path: null,
          patch_sha256: null,
          scope_digest: sha256hex('scope'),
        },
        {
          now: async () => '2026-07-16T00:00:02.000Z',
          verifySalvage: async () => ({ verified_at: '2026-07-16T00:00:01.000Z' }),
          persistSalvageReceipt: async () => undefined,
        }
      )
    ).rejects.toThrow('verified_at must be greater than or equal to captured_at');
  });

  test('isValidOnRampResult enforces the frozen NULL/status matrix', () => {
    expect(isValidOnRampResult(succeededOnRamp())).toBe(true);
    expect(
      isValidOnRampResult({
        schema_version: 'overseer-first-refire-on-ramp-result-v1',
        status: 'failed',
        successor_run_id: null,
        external_effect_reference: null,
        evidence_digest: sha256hex('evidence'),
        reason: 'definitive zero effect',
      })
    ).toBe(true);
    expect(
      isValidOnRampResult({
        schema_version: 'overseer-first-refire-on-ramp-result-v1',
        status: 'indeterminate',
        successor_run_id: null,
        external_effect_reference: 'fake://effect/unknown',
        evidence_digest: sha256hex('evidence'),
        reason: 'effect unknown',
      })
    ).toBe(true);
    // Invalid: succeeded without a successor run id.
    expect(
      isValidOnRampResult({
        schema_version: 'overseer-first-refire-on-ramp-result-v1',
        status: 'succeeded',
        successor_run_id: null,
        external_effect_reference: 'fake://effect/1',
        evidence_digest: sha256hex('evidence'),
        reason: 'missing successor',
      })
    ).toBe(false);
  });

  test('invalid dependency result fails closed and records no primary outcome', async () => {
    const harness = makeHarness({
      onRampResult: {
        schema_version: 'overseer-first-refire-on-ramp-result-v1',
        status: 'succeeded',
        successor_run_id: null,
        external_effect_reference: 'fake://effect/1',
        evidence_digest: sha256hex('evidence'),
        reason: 'missing successor',
      },
    });
    const result = await executeRepairRefire(
      execInput(assessRepairRefireCandidate(baseAssessInput())),
      harness.deps
    );
    expect(result.outcome).toBe('invalid_dependency_result');
    expect(harness.effectLedger).toEqual(['effect_reserved']);
    expect(harness.effectLedger.filter(e => e === 'effect_succeeded')).toHaveLength(0);
  });
});
