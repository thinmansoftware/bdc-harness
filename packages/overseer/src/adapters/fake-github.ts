import type { AppendOverseerCapabilityEventInput } from '@archon/core/db/overseer-capabilities';
import type { M31ActionKind } from '../m31-substrate';
import type { ActionPolicyDecision, AllowedActionPolicyDecision } from '../action-policy';

const UNKNOWN_DIGEST = '0'.repeat(64);
const EXACT_REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

export interface FakeGitHubMutationRequest {
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_kind: M31ActionKind;
  readonly actor: string;
  readonly correlation_id: string;
}

export type FakeGitHubReceiptReason =
  | 'fake_accepted'
  | 'policy_not_allowed'
  | 'repository_not_allowlisted'
  | 'action_identity_mismatch'
  | 'permit_expiry_invalid'
  | 'permit_expired';

export interface FakeGitHubReceipt {
  readonly adapter: 'fake-github';
  readonly accepted: boolean;
  readonly reason: FakeGitHubReceiptReason;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_kind: M31ActionKind;
  readonly mutation_sent: false;
}

export interface FakeGitHubAdapterDeps {
  readonly allowed_repositories: readonly string[];
  readonly record_attempt: (input: AppendOverseerCapabilityEventInput) => Promise<unknown>;
  /** Inject the same database-owned clock used at the real side-effect boundary. */
  readonly get_current_time: () => Promise<string>;
}

export interface FakeGitHubAdapter {
  attemptMutation(
    request: FakeGitHubMutationRequest,
    decision: ActionPolicyDecision
  ): Promise<FakeGitHubReceipt>;
}

function identityMatches(
  request: FakeGitHubMutationRequest,
  decision: AllowedActionPolicyDecision
): boolean {
  return (
    request.repository === decision.repository &&
    request.pr_number === decision.pr_number &&
    request.head_sha === decision.head_sha &&
    request.base_branch === decision.base_branch &&
    request.base_sha === decision.base_sha &&
    request.snapshot_id === decision.snapshot_id &&
    request.proposal_id === decision.proposal_id &&
    request.execution_id === decision.execution_id &&
    request.action_kind === decision.action_kind
  );
}

function receipt(
  request: FakeGitHubMutationRequest,
  accepted: boolean,
  reason: FakeGitHubReceiptReason
): FakeGitHubReceipt {
  return {
    adapter: 'fake-github',
    accepted,
    reason,
    repository: request.repository,
    pr_number: request.pr_number,
    head_sha: request.head_sha,
    base_branch: request.base_branch,
    base_sha: request.base_sha,
    snapshot_id: request.snapshot_id,
    proposal_id: request.proposal_id,
    execution_id: request.execution_id,
    action_kind: request.action_kind,
    mutation_sent: false,
  };
}

/** Deterministic fixture adapter. It only records attempts and returns inert data. */
export function createFakeGitHubAdapter(deps: FakeGitHubAdapterDeps): FakeGitHubAdapter {
  const allowedRepositories = new Set(
    deps.allowed_repositories.filter(repository => EXACT_REPOSITORY_RE.test(repository))
  );

  return {
    async attemptMutation(
      request: FakeGitHubMutationRequest,
      decision: ActionPolicyDecision
    ): Promise<FakeGitHubReceipt> {
      let reason: FakeGitHubReceiptReason = 'fake_accepted';
      if (!decision.allowed) {
        reason = 'policy_not_allowed';
      } else if (
        !EXACT_REPOSITORY_RE.test(request.repository) ||
        !allowedRepositories.has(request.repository)
      ) {
        reason = 'repository_not_allowlisted';
      } else if (!identityMatches(request, decision)) {
        reason = 'action_identity_mismatch';
      } else {
        const nowMs = Date.parse(await deps.get_current_time());
        const validUntilMs = Date.parse(decision.valid_until);
        if (!Number.isFinite(nowMs) || !Number.isFinite(validUntilMs)) {
          reason = 'permit_expiry_invalid';
        } else if (nowMs > validUntilMs) {
          reason = 'permit_expired';
        }
      }

      const accepted = reason === 'fake_accepted';
      await deps.record_attempt({
        capability: decision.capability,
        event_type: 'adapter_attempt',
        reason,
        actor: request.actor,
        correlation_id: request.correlation_id,
        proposal_id: request.proposal_id,
        execution_id: request.execution_id,
        policy_digest: decision.allowed ? decision.policy_digest : UNKNOWN_DIGEST,
        verifier_registry_digest: decision.allowed
          ? decision.verifier_registry_digest
          : UNKNOWN_DIGEST,
        details: {
          adapter: 'fake-github',
          accepted,
          mutation_sent: false,
          repository: request.repository,
          pr_number: request.pr_number,
          head_sha: request.head_sha,
          base_branch: request.base_branch,
          base_sha: request.base_sha,
          snapshot_id: request.snapshot_id,
          action_kind: request.action_kind,
        },
      });
      return receipt(request, accepted, reason);
    },
  };
}
