import {
  appendOverseerCapabilityEvent,
  getOverseerCapabilityState,
  type AppendOverseerCapabilityEventInput,
  type OverseerCapability,
  type OverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import {
  getM31ActionProposal,
  type M31ActionKind,
  type M31ActionPermit,
  type M31ActionProposal,
} from '@archon/core/db/merge-steward';
// Direct imports keep the default path on the frozen M-31 and Task 1 stores.

const DIGEST_RE = /^[0-9a-f]{64}$/;
const UNKNOWN_DIGEST = '0'.repeat(64);

const ACTION_CAPABILITIES: Readonly<Partial<Record<M31ActionKind, OverseerCapability>>> = {
  MERGE: 'merge',
  REPAIR: 'repair',
  REFIRE: 'repair',
  REFRESH: 'branch',
  REBASE: 'branch',
  PUSH: 'branch',
  RETARGET: 'branch',
  CLOSE: 'lifecycle',
  REOPEN: 'lifecycle',
  COMMENT: 'lifecycle',
  LABEL: 'lifecycle',
  ASSIGN: 'lifecycle',
  REVIEW: 'lifecycle',
};

export interface OverseerActionPolicy {
  readonly service_enabled: boolean;
  readonly emergency_stop: boolean;
  readonly legacy_dry_run: boolean;
  readonly capability_flags: Readonly<Record<OverseerCapability, boolean>>;
}

export interface ActionPolicyInput {
  readonly policy: OverseerActionPolicy;
  readonly requested_capability: OverseerCapability;
  readonly capability_state: OverseerCapabilityState | null;
  readonly proposal: M31ActionProposal | null;
  readonly permit: M31ActionPermit;
  readonly current_time: string;
}

export type ActionPolicyDenialReason =
  | 'service_disabled'
  | 'emergency_stop'
  | 'legacy_dry_run'
  | 'capability_flag_disabled'
  | 'capability_state_missing'
  | 'capability_state_mismatch'
  | 'capability_state_disabled'
  | 'circuit_open'
  | 'proposal_missing'
  | 'proposal_id_mismatch'
  | 'execution_id_mismatch'
  | 'repository_mismatch'
  | 'pr_number_mismatch'
  | 'head_sha_mismatch'
  | 'base_branch_mismatch'
  | 'base_sha_mismatch'
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
  | 'verifier_registry_mismatch';

export interface AllowedActionPolicyDecision {
  readonly allowed: true;
  readonly reason: 'allowed';
  readonly capability: OverseerCapability;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_kind: M31ActionKind;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export interface DeniedActionPolicyDecision {
  readonly allowed: false;
  readonly reason: ActionPolicyDenialReason;
  readonly capability: OverseerCapability;
}

export type ActionPolicyDecision = AllowedActionPolicyDecision | DeniedActionPolicyDecision;

interface StagedActionPolicyInput {
  readonly policy: OverseerActionPolicy;
  readonly requested_capability: OverseerCapability;
  readonly permit: M31ActionPermit;
  readonly capability_state?: OverseerCapabilityState | null;
  readonly proposal?: M31ActionProposal | null;
  readonly current_time?: string;
}

interface AvailableStages {
  readonly state: boolean;
  readonly proposal: boolean;
  readonly current_time: boolean;
}

type RequiredStage = 'state' | 'proposal' | 'current_time';
type StagedDecision = ActionPolicyDecision | { readonly required: RequiredStage };

function deny(
  capability: OverseerCapability,
  reason: ActionPolicyDenialReason
): DeniedActionPolicyDecision {
  return { allowed: false, reason, capability };
}

function isExactlyTrue(value: unknown): value is true {
  return value === true;
}

function isExactlyFalse(value: unknown): value is false {
  return value === false;
}

function evaluateStagedActionPolicy(
  input: StagedActionPolicyInput,
  available: AvailableStages
): StagedDecision {
  const capability = input.requested_capability;
  if (!isExactlyTrue(input.policy.service_enabled)) return deny(capability, 'service_disabled');
  if (!isExactlyFalse(input.policy.emergency_stop)) return deny(capability, 'emergency_stop');
  if (!isExactlyFalse(input.policy.legacy_dry_run)) return deny(capability, 'legacy_dry_run');
  if (!isExactlyTrue(input.policy.capability_flags[capability])) {
    return deny(capability, 'capability_flag_disabled');
  }

  if (!available.state) return { required: 'state' };
  const state = input.capability_state;
  if (!state) return deny(capability, 'capability_state_missing');
  if (state.capability !== capability) return deny(capability, 'capability_state_mismatch');
  if (!isExactlyTrue(state.action_enabled)) return deny(capability, 'capability_state_disabled');
  if (state.circuit_state !== 'closed') return deny(capability, 'circuit_open');

  if (!available.proposal) return { required: 'proposal' };
  const proposal = input.proposal;
  if (!proposal) return deny(capability, 'proposal_missing');
  const permit = input.permit;
  if (permit.proposal_id !== proposal.proposal_id) return deny(capability, 'proposal_id_mismatch');
  if (permit.execution_id !== proposal.execution_id) {
    return deny(capability, 'execution_id_mismatch');
  }
  if (permit.repository !== proposal.repository) return deny(capability, 'repository_mismatch');
  if (permit.pr_number !== proposal.pr_number) return deny(capability, 'pr_number_mismatch');
  if (permit.head_sha !== proposal.head_sha) return deny(capability, 'head_sha_mismatch');
  if (permit.base_branch !== proposal.base_branch) return deny(capability, 'base_branch_mismatch');
  if (permit.base_sha !== proposal.base_sha) return deny(capability, 'base_sha_mismatch');
  if (permit.snapshot_id !== proposal.snapshot_id) return deny(capability, 'snapshot_id_mismatch');
  if (permit.action_kind !== proposal.action_kind) return deny(capability, 'action_kind_mismatch');
  if (permit.capability !== proposal.capability) {
    return deny(capability, 'proposal_capability_mismatch');
  }

  const expectedCapability = ACTION_CAPABILITIES[proposal.action_kind];
  if (!expectedCapability) return deny(capability, 'unsupported_action_kind');
  if (expectedCapability !== capability) return deny(capability, 'coarse_capability_mismatch');
  if (proposal.capability !== `overseer.m31.${proposal.action_kind.toLowerCase()}`) {
    return deny(capability, 'proposal_capability_mismatch');
  }
  if (!DIGEST_RE.test(proposal.policy_digest)) return deny(capability, 'policy_digest_malformed');
  if (!DIGEST_RE.test(proposal.verifier_registry_digest)) {
    return deny(capability, 'verifier_registry_digest_malformed');
  }

  if (!available.current_time) return { required: 'current_time' };
  const nowMs = Date.parse(input.current_time ?? '');
  const validUntilMs = Date.parse(permit.valid_until);
  if (!Number.isFinite(nowMs) || !Number.isFinite(validUntilMs)) {
    return deny(capability, 'permit_expiry_invalid');
  }
  if (nowMs > validUntilMs) return deny(capability, 'permit_expired');
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
    pr_number: proposal.pr_number,
    head_sha: proposal.head_sha,
    base_branch: proposal.base_branch,
    base_sha: proposal.base_sha,
    snapshot_id: proposal.snapshot_id,
    proposal_id: proposal.proposal_id,
    execution_id: proposal.execution_id,
    action_kind: proposal.action_kind,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
  };
}

/** Pure fail-closed evaluation with one stable reason and no I/O. */
export function evaluateActionPolicy(input: ActionPolicyInput): ActionPolicyDecision {
  const decision = evaluateStagedActionPolicy(input, {
    state: true,
    proposal: true,
    current_time: true,
  });
  if ('required' in decision) {
    throw new Error(`action_policy_internal_missing_stage:${decision.required}`);
  }
  return decision;
}

export interface AuthorizeOverseerActionInput {
  readonly policy: OverseerActionPolicy;
  readonly requested_capability: OverseerCapability;
  readonly permit: M31ActionPermit;
  readonly actor: string;
  readonly correlation_id: string;
}

export interface AuthorizeOverseerActionDeps {
  readonly getCapabilityState?: (
    capability: OverseerCapability
  ) => Promise<OverseerCapabilityState | null>;
  readonly getProposal?: (proposalId: string) => Promise<M31ActionProposal | null>;
  readonly getCurrentTime: () => Promise<string>;
  readonly appendEvent?: (input: AppendOverseerCapabilityEventInput) => Promise<unknown>;
}

interface ResolvedAuthorizeOverseerActionDeps {
  readonly getCapabilityState: (
    capability: OverseerCapability
  ) => Promise<OverseerCapabilityState | null>;
  readonly getProposal: (proposalId: string) => Promise<M31ActionProposal | null>;
  readonly getCurrentTime: () => Promise<string>;
  readonly appendEvent: (input: AppendOverseerCapabilityEventInput) => Promise<unknown>;
}

function eventDigest(value: string | undefined): string {
  return value && DIGEST_RE.test(value) ? value : UNKNOWN_DIGEST;
}

async function recordDecision(
  input: AuthorizeOverseerActionInput,
  deps: ResolvedAuthorizeOverseerActionDeps,
  decision: ActionPolicyDecision,
  state: OverseerCapabilityState | null | undefined,
  proposal: M31ActionProposal | null | undefined
): Promise<ActionPolicyDecision> {
  await deps.appendEvent({
    capability: input.requested_capability,
    event_type: decision.allowed ? 'gate_allowed' : 'gate_denied',
    reason: decision.reason,
    actor: input.actor,
    correlation_id: input.correlation_id,
    proposal_id: input.permit.proposal_id,
    execution_id: input.permit.execution_id,
    policy_digest: eventDigest(state?.policy_digest ?? proposal?.policy_digest),
    verifier_registry_digest: eventDigest(
      state?.verifier_registry_digest ?? proposal?.verifier_registry_digest
    ),
    details: {
      repository: input.permit.repository,
      pr_number: input.permit.pr_number,
      action_kind: input.permit.action_kind,
    },
  });
  return decision;
}

/**
 * Loads each policy dependency only when its gate is reached, then records one
 * immutable gate decision. The injected clock must be database-owned outside
 * tests. No provider or mutation adapter is accepted by this boundary.
 */
export async function authorizeOverseerAction(
  input: AuthorizeOverseerActionInput,
  deps: AuthorizeOverseerActionDeps
): Promise<ActionPolicyDecision> {
  const resolvedDeps: ResolvedAuthorizeOverseerActionDeps = {
    getCapabilityState: deps.getCapabilityState ?? getOverseerCapabilityState,
    getProposal: deps.getProposal ?? getM31ActionProposal,
    getCurrentTime: deps.getCurrentTime,
    appendEvent: deps.appendEvent ?? appendOverseerCapabilityEvent,
  };
  let capabilityState: OverseerCapabilityState | null | undefined;
  let boundProposal: M31ActionProposal | null | undefined;
  let currentTime: string | undefined;
  const available = { state: false, proposal: false, current_time: false };

  while (true) {
    const decision = evaluateStagedActionPolicy(
      {
        policy: input.policy,
        requested_capability: input.requested_capability,
        permit: input.permit,
        capability_state: capabilityState,
        proposal: boundProposal,
        current_time: currentTime,
      },
      available
    );
    if (!('required' in decision)) {
      return recordDecision(input, resolvedDeps, decision, capabilityState, boundProposal);
    }

    if (decision.required === 'state') {
      capabilityState = await resolvedDeps.getCapabilityState(input.requested_capability);
      available.state = true;
    } else if (decision.required === 'proposal') {
      boundProposal = await resolvedDeps.getProposal(input.permit.proposal_id);
      available.proposal = true;
    } else {
      currentTime = await resolvedDeps.getCurrentTime();
      available.current_time = true;
    }
  }
}
