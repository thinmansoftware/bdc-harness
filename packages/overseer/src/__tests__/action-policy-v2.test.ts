import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { authorizeOverseerActionV2, evaluateActionPolicyV2 } from '../action-policy-v2';
import type { M31ActionPermitV2, M31ActionProposalV2 } from '@archon/core/db/m31-target-v2';

const H = (value: string): string => createHash('sha256').update(value).digest('hex');
const target = {
  target_kind: 'workflow_run' as const,
  repository: 'org/repo',
  run_id: '123e4567-e89b-42d3-a456-426614174000',
  wo_id: 'WO-1',
  workflow_name: 'build',
  codebase_id: null,
  status: 'failed',
  event_tip: 'e1',
  head_sha: null,
  base_sha: null,
};
const proposal: M31ActionProposalV2 = {
  proposal_id: 'p',
  repository: 'org/repo',
  target,
  target_key: 'k',
  target_digest: H('target'),
  snapshot_id: 's',
  evidence_path: 'e',
  evidence_git_blob: 'a'.repeat(40),
  action_kind: 'REPAIR',
  action_parameters: {},
  actor: 'xo',
  created_at: '2026-07-16T12:00:00.000Z',
  expires_at: '2026-07-16T12:15:00.000Z',
  execution_id: 'e',
  capability: 'overseer.m31.repair',
  policy_digest: H('policy'),
  verifier_registry_digest: H('registry'),
};
const permit: M31ActionPermitV2 = {
  permit_id: 'r',
  proposal_id: 'p',
  execution_id: 'e',
  repository: 'org/repo',
  target,
  target_key: 'k',
  target_digest: H('target'),
  snapshot_id: 's',
  action_kind: 'REPAIR',
  capability: 'overseer.m31.repair',
  issued_at: '2026-07-16T12:00:00.000Z',
  valid_until: '2026-07-16T12:01:00.000Z',
};
const policy = {
  service_enabled: true,
  emergency_stop: false,
  legacy_dry_run: false,
  capability_flags: {
    escalation: false,
    repair: true,
    branch: false,
    lifecycle: false,
    merge: false,
  },
} as const;
const state = {
  capability: 'repair' as const,
  action_enabled: true,
  circuit_state: 'closed' as const,
  circuit_reason: null,
  circuit_opened_at: null,
  policy_digest: H('policy'),
  verifier_registry_digest: H('registry'),
  updated_at: '2026-07-16T12:00:00.000Z',
  updated_by: 'board',
};

describe('authorizeOverseerActionV2', () => {
  test('allows only an exact tagged permit after every frozen gate', () => {
    expect(
      evaluateActionPolicyV2({
        policy,
        requested_capability: 'repair',
        capability_state: state,
        proposal,
        permit,
        current_time: '2026-07-16T12:00:30.000Z',
      })
    ).toMatchObject({ allowed: true, target_kind: 'workflow_run', target_key: 'k' });
    expect(
      evaluateActionPolicyV2({
        policy,
        requested_capability: 'repair',
        capability_state: state,
        proposal,
        permit: { ...permit, target_key: 'changed' },
        current_time: '2026-07-16T12:00:30.000Z',
      })
    ).toMatchObject({ allowed: false, reason: 'target_key_mismatch' });
  });

  test('fails closed when decision audit cannot be persisted', async () => {
    const result = await authorizeOverseerActionV2(
      { requested_capability: 'repair', permit, actor: 'xo', correlation_id: 'c' },
      {
        getPolicy: async () => policy,
        getCapabilityState: async () => state,
        getProposal: async () => proposal,
        getCurrentTime: async () => '2026-07-16T12:00:30.000Z',
        recordDecision: async () => {
          throw new Error('store unavailable');
        },
      }
    );
    expect(result).toEqual({
      allowed: false,
      reason: 'gate_audit_failed',
      capability: 'repair',
      audit_recorded: false,
    });
  });
});
