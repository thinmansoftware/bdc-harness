import { describe, expect, mock, test } from 'bun:test';
import type { OverseerCapabilityState } from '@archon/core/db/overseer-capabilities';
import type { M31ActionPermit, M31ActionProposal } from '../m31-substrate';
import { runAuthorizedEscalation } from '../authorized-escalation';

const POLICY_DIGEST = 'a'.repeat(64);
const VERIFIER_DIGEST = 'b'.repeat(64);

function proposal(): M31ActionProposal {
  return {
    proposal_id: 'proposal-escalation-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: 'c'.repeat(40),
    base_branch: 'dev',
    base_sha: 'd'.repeat(40),
    snapshot_id: 'snapshot-escalation-1',
    evidence_path: 'artifacts/escalation.json',
    evidence_git_blob: 'e'.repeat(40),
    action_kind: 'STAGING_MUTATION',
    action_parameters: {},
    actor: 'test',
    created_at: '2026-07-15T11:45:00.000Z',
    expires_at: '2026-07-15T12:05:00.000Z',
    execution_id: 'execution-escalation-1',
    capability: 'overseer.m31.staging_mutation',
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
  };
}

function permit(): M31ActionPermit {
  const bound = proposal();
  return {
    permit_id: 'permit-escalation-1',
    proposal_id: bound.proposal_id,
    execution_id: bound.execution_id,
    repository: bound.repository,
    pr_number: bound.pr_number,
    head_sha: bound.head_sha,
    base_branch: bound.base_branch,
    base_sha: bound.base_sha,
    snapshot_id: bound.snapshot_id,
    action_kind: bound.action_kind,
    capability: bound.capability,
    issued_at: '2026-07-15T11:59:00.000Z',
    valid_until: '2026-07-15T12:01:00.000Z',
  };
}

function state(): OverseerCapabilityState {
  return {
    capability: 'escalation',
    action_enabled: true,
    circuit_state: 'closed',
    circuit_reason: null,
    circuit_opened_at: null,
    policy_digest: POLICY_DIGEST,
    verifier_registry_digest: VERIFIER_DIGEST,
    updated_at: '2026-07-15T11:59:30.000Z',
    updated_by: 'test',
  };
}

function authorizationDeps(emergencyStop = false) {
  return {
    getPolicy: async () => ({
      service_enabled: true,
      emergency_stop: emergencyStop,
      legacy_dry_run: false,
      capability_flags: {
        escalation: true,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: false,
      },
    }),
    getCapabilityState: async () => state(),
    getProposal: async () => proposal(),
    getCurrentTimeForTest: async () => '2026-07-15T12:00:00.000Z',
    appendEvent: async () => undefined,
  };
}

describe('runAuthorizedEscalation', () => {
  test('requires a permit before any side effect', async () => {
    const perform = mock(async () => undefined);
    const result = await runAuthorizedEscalation(
      'run-no-permit',
      { decision: 'escalate', reason: 'test' },
      { errorClass: 'unknown' },
      { permit: null, actor: 'test', perform }
    );
    expect(result).toEqual({ executed: false, reason: 'permit_missing' });
    expect(perform).not.toHaveBeenCalled();
  });

  test('rechecks persistent policy immediately before the side effect', async () => {
    const perform = mock(async () => undefined);
    const result = await runAuthorizedEscalation(
      'run-authorized',
      { decision: 'escalate', reason: 'test' },
      { errorClass: 'unknown' },
      {
        permit: permit(),
        actor: 'test',
        authorizationDeps: authorizationDeps(),
        perform,
      }
    );
    expect(result).toEqual({ executed: true, reason: 'allowed' });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  test('emergency stop denies before the side effect', async () => {
    const perform = mock(async () => undefined);
    const result = await runAuthorizedEscalation(
      'run-emergency-stop',
      { decision: 'escalate', reason: 'test' },
      { errorClass: 'unknown' },
      {
        permit: permit(),
        actor: 'test',
        authorizationDeps: authorizationDeps(true),
        perform,
      }
    );
    expect(result).toEqual({ executed: false, reason: 'emergency_stop' });
    expect(perform).not.toHaveBeenCalled();
  });
});
