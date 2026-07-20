import { createHash } from 'node:crypto';
import { describe, expect, mock, test } from 'bun:test';
import {
  assessRepairRefireCandidate,
  executeRepairRefire,
  type FirstRefireOnRampRequestV1,
  type FirstRefireOnRampResultV1,
  type OverseerSalvageReceiptV1,
  type RepairRefireClaimDeps,
  type RepairRefireExecutionDeps,
  type RepairRefireExecutionInput,
  type RepairRefireIdempotencyState,
} from '../actions/repair-refire.ts';
import { createRepairRefireAdapter } from '../adapters/repair-refire.ts';

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function successResult(suffix: string): FirstRefireOnRampResultV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-result-v1',
    status: 'succeeded',
    successor_run_id: `run-success-${suffix}`,
    external_effect_reference: `fake://effect/${suffix}`,
    evidence_digest: sha256hex(`evidence-${suffix}`),
    reason: 'fake replacement run started',
  };
}

function salvage(): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-FENCE-01',
    source_target_kind: 'workflow_run',
    source_target_key: 'run-source',
    source_target_digest: sha256hex('target'),
    source_run_id: 'run-source',
    worktree_path: '/tmp/worktrees/run-source',
    artifact_kind: 'git_object',
    git_object_format: 'sha256',
    git_object_id: sha256hex('commit'),
    patch_path: null,
    patch_sha256: null,
    scope_digest: sha256hex('scope'),
    captured_at: '2026-07-20T00:00:00.000Z',
    verified_at: '2026-07-20T00:00:01.000Z',
  };
}

function execInput(actor: string): RepairRefireExecutionInput {
  return {
    assessment: assessRepairRefireCandidate({
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
    }),
    proposal_id: `proposal-${actor}`,
    execution_id: `execution-${actor}`,
    idempotency_key: `idem-${actor}`,
    repository: 'bluedevilcollectibles/bdc-harness',
    wo_id: 'WO-FENCE-01',
    workflow_name: 'implement',
    target_digest: sha256hex('target'),
    scope_digest: sha256hex('scope'),
    failure_digest: sha256hex('failure'),
    source_run_id: 'run-source',
    salvage_receipt: salvage(),
    actor,
    correlation_id: `corr-${actor}`,
  };
}

function makeDeps(claim: RepairRefireClaimDeps): {
  readonly deps: RepairRefireExecutionDeps;
  readonly refires: string[];
  readonly dispositions: string[];
} {
  const refires: string[] = [];
  const dispositions: string[] = [];
  const idem = new Map<string, { digest: string; result?: FirstRefireOnRampResultV1 }>();
  const adapter = createRepairRefireAdapter({
    onRamp: {
      async startFirstRefire(request: FirstRefireOnRampRequestV1) {
        refires.push(request.execution_id);
        return successResult(request.execution_id);
      },
    },
    conductor: {
      pickEntryTier: () => 'tier-fast',
      async runCascade() {
        throw new Error('not used');
      },
    },
    inPlaceRepair: {
      async startInPlaceRepair() {
        throw new Error('not used');
      },
    },
    woClass: 'CODE',
    tags: ['claim-fencing'],
  });
  return {
    refires,
    dispositions,
    deps: {
      gate: {
        preparePermit: async () => ({ ok: true, reason: 'ok' }),
        authorizeAction: async () => ({ allowed: true, reason: 'allowed' }),
        reserveEffect: async () => ({ ok: true, reason: 'reserved' }),
        appendOutcome: async () => ({ ok: true }),
      },
      adapter,
      claim,
      idempotency: {
        async begin(key, digest): Promise<RepairRefireIdempotencyState> {
          const existing = idem.get(key);
          if (!existing) {
            idem.set(key, { digest });
            return { status: 'fresh' };
          }
          if (existing.digest !== digest) return { status: 'conflict' };
          if (existing.result) return { status: 'replay', result: existing.result };
          return { status: 'fresh' };
        },
        async commit(key, result) {
          const existing = idem.get(key);
          if (existing) existing.result = result;
        },
      },
      circuit: { openRepairCircuit: async () => undefined },
      recorder: {
        async recordDisposition(input) {
          dispositions.push(`${input.outcome}:${input.reason}`);
        },
      },
      sha256hex,
    },
  };
}

function racingClaim(): RepairRefireClaimDeps {
  let owner: string | null = null;
  let selected = 0;
  let releaseBarrier: (() => void) | undefined;
  const bothSelected = new Promise<void>(resolve => {
    releaseBarrier = resolve;
  });

  return {
    async acquireExecutionClaim(input) {
      selected += 1;
      if (selected === 2) releaseBarrier?.();
      await bothSelected;
      if (owner === null) {
        owner = input.actor_id;
        return {
          ok: true,
          claim: {
            claim_id: 'claim-race',
            actor_id: input.actor_id,
            actor_kind: 'overseer',
            execution_fencing_token: 1,
          },
        };
      }
      return {
        ok: false,
        code: 'claim_conflict',
        message: 'claim_conflict',
        holder: {
          claim_id: 'claim-race',
          actor_id: owner,
          actor_kind: 'overseer',
          execution_fencing_token: 1,
          expires_at: '2999-01-01T00:00:00.000Z',
        },
      };
    },
    validateExecutionFence: mock(async () => ({
      ok: true as const,
      fence: {
        claim_id: 'claim-race',
        effect_attempt_id: 'effect-race',
        execution_fencing_token: 1,
      },
    })),
    completeExecutionClaim: mock(async () => ({ ok: true })),
    releaseExecutionClaim: mock(async () => ({ ok: true })),
  };
}

describe('repair/refire claim fencing', () => {
  test('concurrent claim race yields exactly one refire and one skipped duplicate', async () => {
    const harness = makeDeps(racingClaim());
    const [a, b] = await Promise.all([
      executeRepairRefire(execInput('overseer-a'), harness.deps),
      executeRepairRefire(execInput('overseer-b'), harness.deps),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['skipped_duplicate', 'succeeded']);
    expect(harness.refires).toHaveLength(1);
    expect(harness.dispositions.filter(d => d.startsWith('skipped_duplicate:'))).toHaveLength(1);
    expect(harness.dispositions.join('\n')).toContain('held by overseer:overseer-a');
  });

  test('stale claim takeover fence lets the new token act and rejects the old token', async () => {
    let token = 1;
    const oldCompletion = mock(async () => ({ ok: false, message: 'stale_execution_fence' }));
    const claim: RepairRefireClaimDeps = {
      async acquireExecutionClaim(input) {
        token += 1;
        return {
          ok: true,
          claim: {
            claim_id: 'claim-takeover',
            actor_id: input.actor_id,
            actor_kind: 'overseer',
            execution_fencing_token: token,
          },
        };
      },
      async validateExecutionFence(input) {
        expect(input.execution_fencing_token).toBe(2);
        return {
          ok: true,
          fence: {
            claim_id: input.claim_id,
            effect_attempt_id: 'effect-takeover',
            execution_fencing_token: input.execution_fencing_token,
          },
        };
      },
      async completeExecutionClaim(input) {
        if (input.execution_fencing_token === 1) return oldCompletion();
        return { ok: true };
      },
      async releaseExecutionClaim() {
        return { ok: true };
      },
    };
    const harness = makeDeps(claim);

    const result = await executeRepairRefire(execInput('overseer-new'), harness.deps);
    expect(result.outcome).toBe('succeeded');
    expect(harness.refires).toHaveLength(1);

    const stale = await claim.completeExecutionClaim({
      claim_id: 'claim-takeover',
      execution_fencing_token: 1,
      effect_attempt_id: 'effect-takeover',
      actor_id: 'overseer-old',
      actor_kind: 'overseer',
      external_effect_reference: 'fake://old',
      evidence: {},
    });
    expect(stale.ok).toBe(false);
    expect(oldCompletion).toHaveBeenCalledTimes(1);
  });
});
