// Overseer fake lifecycle mutation adapter and result reconciliation --
// M-42 Slice 6.
//
// This is the ONLY place a lifecycle "mutation" is materialized, and it is a
// deterministic fixture boundary: it records an attempt and returns inert data
// with mutation_sent === false. No real GitHub / Notion / tracker call is ever
// performed. Authorization, permit issuance, and effect reservation happen
// upstream in executeLifecycleAction; this adapter only enforces the
// repository allowlist, exact permit identity, supported action kind, and the
// single-effect (replay) guard before recording an inert attempt.
//
// reconcileLifecycleResult links a completed result back to the M-31 snapshot
// member, the WO/issue/PR, and the Slice 3 operator card WITHOUT collapsing
// membership: the original member is retained and predecessor/successor
// lineage is appended as supporting evidence only.

import type {
  LifecycleActionKind,
  LifecycleAttemptEvent,
  LifecycleMutationAdapter,
  LifecycleMutationReceipt,
  LifecycleMutationRequest,
  LifecycleAdapterReason,
  ReconcileLifecycleInput,
  ReconcileLifecycleResult,
} from '../actions/lifecycle';
import { LIFECYCLE_ACTION_KINDS } from '../actions/lifecycle';
import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';

const EXACT_REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;

export interface LifecycleMutationAdapterDeps {
  readonly allowed_repositories: readonly string[];
  readonly consume_execution: (executionId: string) => Promise<boolean>;
  readonly record_attempt: (event: LifecycleAttemptEvent) => Promise<unknown>;
}

function snapshotRequest(request: LifecycleMutationRequest): LifecycleMutationRequest {
  return { ...request };
}

function isSupportedActionKind(kind: LifecycleActionKind): boolean {
  return (LIFECYCLE_ACTION_KINDS as readonly string[]).includes(kind);
}

function identityMatches(request: LifecycleMutationRequest, permit: M31ActionPermitV2): boolean {
  return (
    request.permit_id === permit.permit_id &&
    request.repository === permit.repository &&
    request.snapshot_id === permit.snapshot_id &&
    request.proposal_id === permit.proposal_id &&
    request.execution_id === permit.execution_id &&
    request.action_kind === permit.action_kind &&
    request.target_key === permit.target_key &&
    request.target_digest === permit.target_digest
  );
}

function buildReceipt(
  request: LifecycleMutationRequest,
  accepted: boolean,
  reason: LifecycleAdapterReason,
  auditRecorded: boolean
): LifecycleMutationReceipt {
  return {
    adapter: 'fake-lifecycle',
    accepted,
    reason,
    audit_recorded: auditRecorded,
    mutation_sent: false,
    permit_id: request.permit_id,
    repository: request.repository,
    action_kind: request.action_kind,
    target_key: request.target_key,
    target_digest: request.target_digest,
    snapshot_id: request.snapshot_id,
    proposal_id: request.proposal_id,
    execution_id: request.execution_id,
    action_parameters_digest: request.action_parameters_digest,
  };
}

/** Deterministic fixture boundary. Records an attempt and returns inert data only. */
export function createLifecycleMutationAdapter(
  deps: LifecycleMutationAdapterDeps
): LifecycleMutationAdapter {
  const allowedRepositories = new Set(
    deps.allowed_repositories.filter(repository => EXACT_REPOSITORY_RE.test(repository))
  );

  return {
    async attemptMutation(
      request: LifecycleMutationRequest,
      permit: M31ActionPermitV2
    ): Promise<LifecycleMutationReceipt> {
      const bound = snapshotRequest(request);
      let reason: LifecycleAdapterReason = 'fake_accepted';

      if (
        !EXACT_REPOSITORY_RE.test(bound.repository) ||
        !allowedRepositories.has(bound.repository)
      ) {
        reason = 'repository_not_allowlisted';
      } else if (!isSupportedActionKind(bound.action_kind)) {
        reason = 'action_kind_unsupported';
      } else if (!identityMatches(bound, permit)) {
        reason = 'action_identity_mismatch';
      } else {
        try {
          const consumed = await deps.consume_execution(bound.execution_id);
          if (!consumed) reason = 'execution_replayed';
        } catch {
          reason = 'execution_check_failed';
        }
      }

      const accepted = reason === 'fake_accepted';
      const attemptEvent: LifecycleAttemptEvent = {
        adapter: 'fake-lifecycle',
        accepted,
        reason,
        permit_id: bound.permit_id,
        repository: bound.repository,
        action_kind: bound.action_kind,
        target_key: bound.target_key,
        target_digest: bound.target_digest,
        snapshot_id: bound.snapshot_id,
        proposal_id: bound.proposal_id,
        execution_id: bound.execution_id,
        action_parameters_digest: bound.action_parameters_digest,
        mutation_sent: false,
      };

      try {
        await deps.record_attempt(attemptEvent);
        return buildReceipt(bound, accepted, reason, true);
      } catch {
        return buildReceipt(bound, false, 'attempt_audit_failed', false);
      }
    },
  };
}

/**
 * Links a completed lifecycle result back to the M-31 snapshot, the target,
 * and the Slice 3 operator card. The original snapshot member is retained;
 * predecessor/successor lineage is appended as supporting evidence and never
 * collapses membership.
 */
export function reconcileLifecycleResult(input: ReconcileLifecycleInput): ReconcileLifecycleResult {
  const lineageAppended = [...input.predecessor_evidence, ...input.successor_evidence];
  return {
    membership_retained: true,
    membership_collapsed: false,
    snapshot_id: input.snapshot_id,
    retained_member_target_key: input.retained_member_target_key,
    lineage_appended: lineageAppended,
    card_emitted: input.card,
  };
}
