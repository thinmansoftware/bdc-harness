import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  executeRepairRefire,
  type FirstRefireOnRampResultV1,
  type OverseerSalvageReceiptV1,
  type RepairRefireExecutionClaimDeps,
  type RepairRefireExecutionDeps,
  type RepairRefireExecutionInput,
} from '../actions/repair-refire.ts';
import type { ExecutionClaimResponse } from '@archon/core/db/execution-claims';

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function succeededOnRamp(actor: string): FirstRefireOnRampResultV1 {
  return {
    schema_version: 'overseer-first-refire-on-ramp-result-v1',
    status: 'succeeded',
    successor_run_id: `run-${actor}`,
    external_effect_reference: `fake://effect/${actor}`,
    evidence_digest: sha256hex(`evidence-${actor}`),
    reason: `started by ${actor}`,
  };
}

function salvage(): OverseerSalvageReceiptV1 {
  return {
    schema_version: 'overseer-salvage-receipt-v1',
    repository: 'thinmansoftware/bdc-harness',
    wo_id: 'WO-CLAIM-RACE',
    source_target_kind: 'workflow_run',
    source_target_key: 'run-source',
    source_target_digest: sha256hex('target'),
    source_run_id: 'run-source',
    worktree_path: '/tmp/worktree',
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

function claimResponse(input: {
  actor: string;
  claimId: string;
  token: number;
  targetDigest: string;
}): ExecutionClaimResponse {
  return {
    claim_id: input.claimId,
    motion_id: 'overseer:thinmansoftware/bdc-harness:WO-CLAIM-RACE:exec-race',
    action_kind: 'overseer_repair_refire',
    environment: 'recovery',
    target_sha: input.targetDigest,
    action_key: sha256hex('race-action'),
    motion_file_path: 'overseer://race',
    motion_revision_sha: '0'.repeat(40),
    claimant_principal: input.actor,
    claimant_xo_holder_id: 'recovery',
    claimant_xo_lease_id: 'recovery',
    claimant_xo_fencing_token: 1,
    execution_fencing_token: input.token,
    status: 'active',
    reconciliation_status: 'clear',
    effect_attempt_id: null,
    effect_attempt_state: 'none',
    effect_armed_at: null,
    acquired_at: '2026-07-20T00:00:00.000Z',
    renewed_at: null,
    expires_at: '2999-01-01T00:00:00.000Z',
    released_at: null,
    completed_at: null,
    external_effect_reference: null,
    completion_evidence: null,
    reconciliation_evidence: null,
  };
}

function racingClaimDeps(): RepairRefireExecutionClaimDeps {
  let holder: ExecutionClaimResponse | null = null;
  let waiting = 0;
  let releaseBarrier: (() => void) | null = null;
  const bothWaiting = new Promise<void>(resolve => {
    releaseBarrier = resolve;
  });

  return {
    async acquire(input) {
      if (!holder) {
        waiting += 1;
        if (waiting === 2) releaseBarrier?.();
        await bothWaiting;
      }
      if (!holder) {
        holder = claimResponse({
          actor: input.actor_principal,
          claimId: 'claim-race',
          token: 1,
          targetDigest: input.target_digest,
        });
        return { ok: true, created: true, outcome: 'acquired', claim: holder };
      }
      return { ok: false, code: 'claim_conflict', message: 'claim_conflict', holder };
    },
    async validate(input) {
      if (
        !holder ||
        holder.claim_id !== input.claim_id ||
        holder.execution_fencing_token !== input.execution_fencing_token ||
        holder.claimant_principal !== input.actor_principal
      ) {
        return { ok: false, code: 'stale_fence', message: 'stale_execution_fence' };
      }
      return {
        ok: true,
        claim_id: input.claim_id,
        permitted: true,
        effect_attempt_id: 'effect-race',
        execution_fencing_token: input.execution_fencing_token,
        motion_revision_sha: '0'.repeat(40),
      };
    },
    async complete() {
      return { ok: true, claim: holder as ExecutionClaimResponse };
    },
    async release() {
      return { ok: true, claim: holder as ExecutionClaimResponse };
    },
  };
}

function depsFor(
  actor: string,
  claimDeps: RepairRefireExecutionClaimDeps,
  refires: string[],
  dispositions: string[]
): RepairRefireExecutionDeps {
  return {
    gate: {
      async preparePermit() {
        return { ok: true, reason: 'ok' };
      },
      async authorizeAction() {
        return { allowed: true, reason: 'allowed' };
      },
      async reserveEffect() {
        return { ok: true, reason: 'reserved' };
      },
      async appendOutcome() {
        return { ok: true };
      },
    },
    adapter: {
      async dispatchInPlaceRepair() {
        refires.push(actor);
        return succeededOnRamp(actor);
      },
      async dispatchFirstAttempt() {
        refires.push(actor);
        return succeededOnRamp(actor);
      },
      async dispatchLaterAttempt() {
        refires.push(actor);
        return succeededOnRamp(actor);
      },
    },
    idempotency: {
      async begin() {
        return { status: 'fresh' };
      },
      async commit() {},
    },
    circuit: {
      async openRepairCircuit() {},
    },
    recorder: {
      async recordDisposition(input) {
        dispositions.push(`${input.outcome}:${input.reason}`);
      },
    },
    executionClaim: claimDeps,
    sha256hex,
  };
}

function inputFor(actor: string): RepairRefireExecutionInput {
  return {
    assessment: {
      disposition: 'refire_first',
      escalation_reason: null,
      requires_circuit_open: false,
      no_mutation: false,
    },
    proposal_id: `proposal-${actor}`,
    execution_id: 'exec-race',
    idempotency_key: `idem-${actor}`,
    repository: 'thinmansoftware/bdc-harness',
    wo_id: 'WO-CLAIM-RACE',
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

describe('repair/refire claim fencing', () => {
  test('concurrent contenders produce one refire and one skipped duplicate', async () => {
    const refires: string[] = [];
    const dispositions: string[] = [];
    const claims = racingClaimDeps();

    const results = await Promise.all([
      executeRepairRefire(
        inputFor('overseer-a'),
        depsFor('overseer-a', claims, refires, dispositions)
      ),
      executeRepairRefire(
        inputFor('overseer-b'),
        depsFor('overseer-b', claims, refires, dispositions)
      ),
    ]);

    expect(refires).toHaveLength(1);
    expect(results.map(result => result.outcome).sort()).toEqual([
      'skipped_duplicate',
      'succeeded',
    ]);
    expect(dispositions.filter(item => item.startsWith('skipped_duplicate:'))).toHaveLength(1);
    expect(dispositions.join('\n')).toContain('holder=overseer-');
  });
});
