import type {
  OverseerCapability,
  OverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import {
  canonicalJsonV2,
  type M31ActionKind,
  type M31ActionPermitV2,
  type M31ActionProposalV2,
} from '@archon/core/db/m31-target-v2';
import type { OverseerActionPolicy } from './action-policy';

const DIGEST_RE = /^[0-9a-f]{64}$/;

const ACTION_CAPABILITIES_V2: Readonly<Partial<Record<M31ActionKind, OverseerCapability>>> = {
  MERGE: 'merge',
  REPAIR: 'repair',
  REFIRE: 'repair',
  REFRESH: 'branch',
  REBASE: 'branch',
  CLOSE: 'lifecycle',
  REOPEN: 'lifecycle',
  COMMENT: 'lifecycle',
  LABEL: 'lifecycle',
  ASSIGN: 'lifecycle',
};

export type ActionPolicyV2DenialReason =
  | 'service_disabled'
  | 'emergency_stop'
  | 'legacy_dry_run'
  | 'capability_flag_disabled'
  | 'capability_state_missing'
  | 'capability_state_disabled'
  | 'circuit_open'
  | 'proposal_missing'
  | 'proposal_id_mismatch'
  | 'execution_id_mismatch'
  | 'repository_mismatch'
  | 'target_kind_mismatch'
  | 'target_key_mismatch'
  | 'target_digest_mismatch'
  | 'target_identity_mismatch'
  | 'snapshot_id_mismatch'
  | 'action_kind_mismatch'
  | 'proposal_capability_mismatch'
  | 'unsupported_action_kind'
  | 'coarse_capability_mismatch'
  | 'policy_digest_malformed'
  | 'verifier_registry_digest_malformed'
  | 'permit_expiry_invalid'
  | 'permit_expired'
  | 'policy_digest_mismatch'
  | 'verifier_registry_mismatch'
  | 'policy_read_failed'
  | 'capability_state_read_failed'
  | 'proposal_read_failed'
  | 'clock_read_failed'
  | 'policy_evaluation_failed'
  | 'gate_audit_failed';

export type ActionPolicyV2Decision =
  | {
      readonly allowed: true;
      readonly reason: 'allowed';
      readonly capability: OverseerCapability;
      readonly repository: string;
      readonly target_kind: M31ActionProposalV2['target']['target_kind'];
      readonly target_key: string;
      readonly target_digest: string;
      readonly snapshot_id: string;
      readonly proposal_id: string;
      readonly execution_id: string;
      readonly action_kind: M31ActionKind;
      readonly valid_until: string;
      readonly policy_digest: string;
      readonly verifier_registry_digest: string;
    }
  | {
      readonly allowed: false;
      readonly reason: ActionPolicyV2DenialReason;
      readonly capability: OverseerCapability;
    };

export interface ActionPolicyV2Input {
  readonly policy: OverseerActionPolicy;
  readonly requested_capability: OverseerCapability;
  readonly capability_state: OverseerCapabilityState | null;
  readonly proposal: M31ActionProposalV2 | null;
  readonly permit: M31ActionPermitV2;
  readonly current_time: string;
}

function deny(
  capability: OverseerCapability,
  reason: ActionPolicyV2DenialReason
): ActionPolicyV2Decision {
  return { allowed: false, reason, capability };
}

export function evaluateActionPolicyV2(input: ActionPolicyV2Input): ActionPolicyV2Decision {
  const capability = input.requested_capability;
  if (!input.policy.service_enabled) return deny(capability, 'service_disabled');
  if (input.policy.emergency_stop) return deny(capability, 'emergency_stop');
  if (input.policy.legacy_dry_run) return deny(capability, 'legacy_dry_run');
  if (!input.policy.capability_flags[capability]) {
    return deny(capability, 'capability_flag_disabled');
  }

  const state = input.capability_state;
  if (state?.capability !== capability) return deny(capability, 'capability_state_missing');
  if (!state.action_enabled) return deny(capability, 'capability_state_disabled');
  if (state.circuit_state !== 'closed') return deny(capability, 'circuit_open');

  const proposal = input.proposal;
  if (!proposal) return deny(capability, 'proposal_missing');
  const permit = input.permit;
  if (permit.proposal_id !== proposal.proposal_id) return deny(capability, 'proposal_id_mismatch');
  if (permit.execution_id !== proposal.execution_id)
    return deny(capability, 'execution_id_mismatch');
  if (permit.repository !== proposal.repository) return deny(capability, 'repository_mismatch');
  if (permit.target.target_kind !== proposal.target.target_kind) {
    return deny(capability, 'target_kind_mismatch');
  }
  if (permit.target_key !== proposal.target_key) return deny(capability, 'target_key_mismatch');
  if (permit.target_digest !== proposal.target_digest)
    return deny(capability, 'target_digest_mismatch');
  if (canonicalJsonV2(permit.target) !== canonicalJsonV2(proposal.target)) {
    return deny(capability, 'target_identity_mismatch');
  }
  if (permit.snapshot_id !== proposal.snapshot_id) return deny(capability, 'snapshot_id_mismatch');
  if (permit.action_kind !== proposal.action_kind) return deny(capability, 'action_kind_mismatch');
  if (permit.capability !== proposal.capability) {
    return deny(capability, 'proposal_capability_mismatch');
  }

  const expectedCapability = ACTION_CAPABILITIES_V2[proposal.action_kind];
  if (!expectedCapability) return deny(capability, 'unsupported_action_kind');
  if (expectedCapability !== capability) return deny(capability, 'coarse_capability_mismatch');
  if (proposal.capability !== `overseer.m31.${proposal.action_kind.toLowerCase()}`) {
    return deny(capability, 'proposal_capability_mismatch');
  }
  if (!DIGEST_RE.test(proposal.policy_digest)) return deny(capability, 'policy_digest_malformed');
  if (!DIGEST_RE.test(proposal.verifier_registry_digest)) {
    return deny(capability, 'verifier_registry_digest_malformed');
  }

  const now = Date.parse(input.current_time);
  const validUntil = Date.parse(permit.valid_until);
  if (!Number.isFinite(now) || !Number.isFinite(validUntil)) {
    return deny(capability, 'permit_expiry_invalid');
  }
  if (now > validUntil) return deny(capability, 'permit_expired');
  if (state.policy_digest !== proposal.policy_digest) {
    return deny(capability, 'policy_digest_mismatch');
  }
  if (state.verifier_registry_digest !== proposal.verifier_registry_digest) {
    return deny(capability, 'verifier_registry_mismatch');
  }

  return {
    allowed: true,
    reason: 'allowed',
    capability,
    repository: proposal.repository,
    target_kind: proposal.target.target_kind,
    target_key: proposal.target_key,
    target_digest: proposal.target_digest,
    snapshot_id: proposal.snapshot_id,
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    action_kind: proposal.action_kind,
    valid_until: permit.valid_until,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
  };
}

export interface AuthorizeOverseerActionV2Input {
  readonly requested_capability: OverseerCapability;
  readonly permit: M31ActionPermitV2;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface AuthorizeOverseerActionV2Deps {
  readonly getPolicy: () => Promise<OverseerActionPolicy>;
  readonly getCapabilityState: (
    capability: OverseerCapability
  ) => Promise<OverseerCapabilityState | null>;
  readonly getProposal: (proposalId: string) => Promise<M31ActionProposalV2 | null>;
  readonly getCurrentTime: () => Promise<string>;
  readonly recordDecision: (input: {
    readonly actor: string;
    readonly correlation_id: string;
    readonly permit: M31ActionPermitV2;
    readonly decision: ActionPolicyV2Decision;
  }) => Promise<void>;
}

export type ActionPolicyV2AuthorizationResult = ActionPolicyV2Decision & {
  readonly audit_recorded: boolean;
};

export async function authorizeOverseerActionV2(
  input: AuthorizeOverseerActionV2Input,
  deps: AuthorizeOverseerActionV2Deps
): Promise<ActionPolicyV2AuthorizationResult> {
  let decision: ActionPolicyV2Decision;
  try {
    const policy = await deps.getPolicy();
    const state = await deps.getCapabilityState(input.requested_capability);
    const proposal = await deps.getProposal(input.permit.proposal_id);
    const currentTime = await deps.getCurrentTime();
    decision = evaluateActionPolicyV2({
      policy,
      requested_capability: input.requested_capability,
      capability_state: state,
      proposal,
      permit: input.permit,
      current_time: currentTime,
    });
  } catch {
    decision = deny(input.requested_capability, 'policy_evaluation_failed');
  }

  try {
    await deps.recordDecision({
      actor: input.actor,
      correlation_id: input.correlation_id,
      permit: input.permit,
      decision,
    });
    return { ...decision, audit_recorded: true };
  } catch {
    return {
      allowed: false,
      reason: 'gate_audit_failed',
      capability: input.requested_capability,
      audit_recorded: false,
    };
  }
}
