import type { AppendOverseerCapabilityEventInput } from '@archon/core/db/overseer-capabilities';
import type { M31ActionKind } from '../m31-substrate';
import {
  authorizeOverseerAction,
  type ActionPolicyDenialReason,
  type AuthorizeOverseerActionDeps,
  type AuthorizeOverseerActionInput,
} from '../action-policy';

const UNKNOWN_DIGEST = '0'.repeat(64);
const EXACT_REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

export interface FakeGitHubMutationRequest {
  readonly permit_id: string;
  readonly repository: string;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly base_branch: string;
  readonly base_sha: string;
  readonly snapshot_id: string;
  readonly proposal_id: string;
  readonly execution_id: string;
  readonly action_kind: M31ActionKind;
}

export type FakeGitHubReceiptReason =
  | 'fake_accepted'
  | 'authorization_denied'
  | 'authorization_boundary_failed'
  | 'repository_not_allowlisted'
  | 'action_identity_mismatch'
  | 'execution_replayed'
  | 'execution_check_failed'
  | 'attempt_audit_failed';

export interface FakeGitHubReceipt {
  readonly adapter: 'fake-github';
  readonly accepted: boolean;
  readonly reason: FakeGitHubReceiptReason;
  readonly authorization_reason: ActionPolicyDenialReason | null;
  readonly authorization_audit_recorded: boolean;
  readonly audit_recorded: boolean;
  readonly permit_id: string;
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
  readonly authorization_deps: AuthorizeOverseerActionDeps;
  readonly consume_execution: (executionId: string) => Promise<boolean>;
  readonly record_attempt: (input: AppendOverseerCapabilityEventInput) => Promise<unknown>;
}

export interface FakeGitHubAdapter {
  attemptMutation(
    request: FakeGitHubMutationRequest,
    authorization: AuthorizeOverseerActionInput
  ): Promise<FakeGitHubReceipt>;
}

function identityMatches(
  request: FakeGitHubMutationRequest,
  authorization: AuthorizeOverseerActionInput
): boolean {
  const permit = authorization.permit;
  return (
    request.permit_id === permit.permit_id &&
    request.repository === permit.repository &&
    request.pr_number === permit.pr_number &&
    request.head_sha === permit.head_sha &&
    request.base_branch === permit.base_branch &&
    request.base_sha === permit.base_sha &&
    request.snapshot_id === permit.snapshot_id &&
    request.proposal_id === permit.proposal_id &&
    request.execution_id === permit.execution_id &&
    request.action_kind === permit.action_kind
  );
}

function receipt(
  request: FakeGitHubMutationRequest,
  accepted: boolean,
  reason: FakeGitHubReceiptReason,
  authorizationReason: ActionPolicyDenialReason | null,
  authorizationAuditRecorded: boolean,
  auditRecorded: boolean
): FakeGitHubReceipt {
  return {
    adapter: 'fake-github',
    accepted,
    reason,
    authorization_reason: authorizationReason,
    authorization_audit_recorded: authorizationAuditRecorded,
    audit_recorded: auditRecorded,
    permit_id: request.permit_id,
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

/** Deterministic fixture boundary. It records attempts and returns inert data only. */
export function createFakeGitHubAdapter(deps: FakeGitHubAdapterDeps): FakeGitHubAdapter {
  const allowedRepositories = new Set(
    deps.allowed_repositories.filter(repository => EXACT_REPOSITORY_RE.test(repository))
  );

  return {
    async attemptMutation(
      request: FakeGitHubMutationRequest,
      authorizationInput: AuthorizeOverseerActionInput
    ): Promise<FakeGitHubReceipt> {
      let reason: FakeGitHubReceiptReason = 'fake_accepted';
      let authorizationReason: ActionPolicyDenialReason | null = null;
      let authorizationAuditRecorded = false;
      let policyDigest = UNKNOWN_DIGEST;
      let verifierDigest = UNKNOWN_DIGEST;

      try {
        const authorization = await authorizeOverseerAction(
          authorizationInput,
          deps.authorization_deps
        );
        authorizationAuditRecorded = authorization.audit_recorded;
        if (!authorization.allowed) {
          reason = 'authorization_denied';
          authorizationReason = authorization.reason;
        } else {
          policyDigest = authorization.policy_digest;
          verifierDigest = authorization.verifier_registry_digest;
        }
      } catch {
        reason = 'authorization_boundary_failed';
        authorizationReason = 'policy_evaluation_failed';
      }

      if (reason === 'fake_accepted') {
        if (
          !EXACT_REPOSITORY_RE.test(request.repository) ||
          !allowedRepositories.has(request.repository)
        ) {
          reason = 'repository_not_allowlisted';
        } else if (!identityMatches(request, authorizationInput)) {
          reason = 'action_identity_mismatch';
        } else {
          try {
            const consumed = await deps.consume_execution(request.execution_id);
            if (!consumed) reason = 'execution_replayed';
          } catch {
            reason = 'execution_check_failed';
          }
        }
      }

      const accepted = reason === 'fake_accepted';
      const attemptEvent: AppendOverseerCapabilityEventInput = {
        capability: authorizationInput.requested_capability,
        event_type: 'adapter_attempt',
        reason,
        actor: authorizationInput.actor,
        correlation_id: authorizationInput.correlation_id,
        proposal_id: request.proposal_id,
        execution_id: request.execution_id,
        policy_digest: policyDigest,
        verifier_registry_digest: verifierDigest,
        details: {
          adapter: 'fake-github',
          accepted,
          authorization_reason: authorizationReason,
          authorization_audit_recorded: authorizationAuditRecorded,
          mutation_sent: false,
          permit_id: request.permit_id,
          repository: request.repository,
          pr_number: request.pr_number,
          head_sha: request.head_sha,
          base_branch: request.base_branch,
          base_sha: request.base_sha,
          snapshot_id: request.snapshot_id,
          action_kind: request.action_kind,
        },
      };

      try {
        await deps.record_attempt(attemptEvent);
        return receipt(
          request,
          accepted,
          reason,
          authorizationReason,
          authorizationAuditRecorded,
          true
        );
      } catch {
        return receipt(
          request,
          false,
          'attempt_audit_failed',
          authorizationReason,
          authorizationAuditRecorded,
          false
        );
      }
    },
  };
}
