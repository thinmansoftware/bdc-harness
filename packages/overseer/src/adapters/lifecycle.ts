import { createHash } from 'node:crypto';
import {
  canonicalJsonV2,
  type M31ActionPermitV2,
  type M31ExecutionReceiptEventV2,
} from '@archon/core/db/m31-target-v2';
import type { LifecycleActionKindV1, LifecycleTargetKindV1 } from '../actions/lifecycle';

export interface LifecycleMutationRequestV1 {
  readonly permit_id: string;
  readonly execution_id: string;
  readonly repository: string;
  readonly target_kind: LifecycleTargetKindV1;
  readonly target_key: string;
  readonly target_digest: string;
  readonly action_kind: LifecycleActionKindV1;
  readonly action_parameters_digest: string;
}

export type LifecycleMutationReasonV1 =
  | 'simulated_accepted_no_mutation'
  | 'repository_not_allowlisted'
  | 'action_not_allowlisted'
  | 'target_kind_not_allowlisted'
  | 'execution_replayed';

export interface LifecycleMutationReceiptV1 extends LifecycleMutationRequestV1 {
  readonly adapter: 'fake-lifecycle';
  readonly accepted: boolean;
  readonly reason: LifecycleMutationReasonV1;
  readonly mutation_sent: false;
  readonly external_effect_reference: string | null;
}

export interface LifecycleMutationAdapterV1 {
  perform(request: LifecycleMutationRequestV1): Promise<LifecycleMutationReceiptV1>;
}

export interface CreateLifecycleMutationAdapterDepsV1 {
  readonly allowed_repositories: readonly string[];
  readonly allowed_actions: readonly LifecycleActionKindV1[];
  readonly consume_execution: (executionId: string) => Promise<boolean>;
}

const EXACT_REPOSITORY_RE = /^[^/\s]+\/[^/\s]+$/;
const TARGET_KINDS = new Set<LifecycleTargetKindV1>(['issue', 'work_order', 'pull_request']);

function receipt(
  request: LifecycleMutationRequestV1,
  accepted: boolean,
  reason: LifecycleMutationReasonV1
): LifecycleMutationReceiptV1 {
  return {
    ...request,
    adapter: 'fake-lifecycle',
    accepted,
    reason,
    mutation_sent: false,
    external_effect_reference: accepted
      ? `fake-lifecycle://${request.repository}/${request.target_kind}/${request.target_key}/${request.execution_id}`
      : null,
  };
}

/**
 * Deterministic fake lifecycle boundary. It never contacts GitHub, Notion, a
 * tracker, or the network. Exactly one allowlisted action is accepted per
 * consumed execution id.
 */
export function createLifecycleMutationAdapter(
  deps: CreateLifecycleMutationAdapterDepsV1
): LifecycleMutationAdapterV1 {
  const allowedRepositories = new Set(
    deps.allowed_repositories.filter(repository => EXACT_REPOSITORY_RE.test(repository))
  );
  const allowedActions = new Set(deps.allowed_actions);

  return {
    async perform(request: LifecycleMutationRequestV1): Promise<LifecycleMutationReceiptV1> {
      const bound = { ...request };
      if (
        !EXACT_REPOSITORY_RE.test(bound.repository) ||
        !allowedRepositories.has(bound.repository)
      ) {
        return receipt(bound, false, 'repository_not_allowlisted');
      }
      if (!TARGET_KINDS.has(bound.target_kind)) {
        return receipt(bound, false, 'target_kind_not_allowlisted');
      }
      if (!allowedActions.has(bound.action_kind)) {
        return receipt(bound, false, 'action_not_allowlisted');
      }
      const consumed = await deps.consume_execution(bound.execution_id);
      if (!consumed) return receipt(bound, false, 'execution_replayed');
      return receipt(bound, true, 'simulated_accepted_no_mutation');
    },
  };
}

export interface LifecycleLineageSupportV1 {
  readonly predecessor_target_key: string;
  readonly successor_target_key: string;
  readonly evidence_digest: string;
}

export interface ReconcileLifecycleResultInputV1 {
  readonly snapshot_id: string;
  readonly original_member_target_key: string;
  readonly wo_id: string;
  readonly issue_or_pr_key: string;
  readonly run_id: string;
  readonly card_id: string;
  readonly permit: M31ActionPermitV2;
  readonly permit_receipt: M31ExecutionReceiptEventV2;
  readonly reservation_receipt: M31ExecutionReceiptEventV2;
  readonly outcome_receipt: M31ExecutionReceiptEventV2;
  readonly mutation: LifecycleMutationReceiptV1;
  readonly existing_lineage: readonly LifecycleLineageSupportV1[];
  readonly new_lineage: readonly LifecycleLineageSupportV1[];
}

export interface LifecycleReconciliationReceiptV1 {
  readonly schema_version: 'overseer-lifecycle-reconciliation-v1';
  readonly snapshot_id: string;
  readonly preserved_member_target_key: string;
  readonly wo_id: string;
  readonly issue_or_pr_key: string;
  readonly run_id: string;
  readonly card_id: string;
  readonly mutation: LifecycleMutationReceiptV1;
  readonly lineage: readonly LifecycleLineageSupportV1[];
  readonly membership_collapsed: false;
}

export function reconcileLifecycleResult(
  input: ReconcileLifecycleResultInputV1
): LifecycleReconciliationReceiptV1 {
  const permit = input.permit;
  const permitReceipt = input.permit_receipt;
  const reservationReceipt = input.reservation_receipt;
  const outcomeReceipt = input.outcome_receipt;
  const mutation = input.mutation;
  const lifecycleActions: readonly string[] = ['CLOSE', 'REOPEN', 'COMMENT', 'LABEL', 'ASSIGN'];

  if (
    !lifecycleActions.includes(permit.action_kind) ||
    permit.snapshot_id !== input.snapshot_id ||
    permit.target_key !== input.issue_or_pr_key ||
    permit.target.target_kind !== mutation.target_kind ||
    permit.repository !== mutation.repository ||
    permit.target_key !== mutation.target_key ||
    permit.target_digest !== mutation.target_digest ||
    !/^[0-9a-f]{64}$/.test(mutation.target_digest) ||
    !/^[0-9a-f]{64}$/.test(mutation.action_parameters_digest)
  ) {
    throw new Error('lifecycle_reconciliation_target_mismatch');
  }
  if (permit.action_kind !== mutation.action_kind) {
    throw new Error('lifecycle_reconciliation_action_mismatch');
  }
  if (permit.capability !== `overseer.m31.${mutation.action_kind.toLowerCase()}`) {
    throw new Error('lifecycle_reconciliation_capability_mismatch');
  }
  if (
    permit.permit_id !== mutation.permit_id ||
    permit.execution_id !== mutation.execution_id ||
    permitReceipt.receipt_event_id !== permit.permit_id ||
    permitReceipt.proposal_id !== permit.proposal_id ||
    permitReceipt.execution_id !== permit.execution_id ||
    reservationReceipt.proposal_id !== permit.proposal_id ||
    reservationReceipt.execution_id !== permit.execution_id ||
    outcomeReceipt.proposal_id !== permit.proposal_id ||
    outcomeReceipt.execution_id !== permit.execution_id
  ) {
    throw new Error('lifecycle_reconciliation_execution_mismatch');
  }
  for (const receipt of [permitReceipt, reservationReceipt, outcomeReceipt]) {
    if (
      receipt.target_kind !== permit.target.target_kind ||
      receipt.target_key !== permit.target_key ||
      receipt.target_digest !== permit.target_digest ||
      !receiptDigestValid(receipt)
    ) {
      throw new Error('lifecycle_reconciliation_receipt_binding_mismatch');
    }
  }
  if (
    permitReceipt.event_type !== 'permit_issued' ||
    permitReceipt.event_sequence !== 1 ||
    permitReceipt.previous_event_digest !== null ||
    reservationReceipt.event_type !== 'effect_reserved' ||
    reservationReceipt.event_sequence !== 2 ||
    reservationReceipt.previous_event_digest !== permitReceipt.event_digest ||
    outcomeReceipt.event_type !== 'effect_succeeded' ||
    outcomeReceipt.event_sequence !== 3 ||
    outcomeReceipt.previous_event_digest !== reservationReceipt.event_digest
  ) {
    throw new Error('lifecycle_reconciliation_receipt_chain_mismatch');
  }
  if (
    reservationReceipt.adapter_name !== mutation.adapter ||
    reservationReceipt.provider_operation !== mutation.action_kind ||
    !isObject(reservationReceipt.evidence) ||
    reservationReceipt.evidence.target_key !== mutation.target_key ||
    reservationReceipt.evidence.target_digest !== mutation.target_digest ||
    reservationReceipt.evidence.action_parameters_digest !== mutation.action_parameters_digest
  ) {
    throw new Error('lifecycle_reconciliation_reservation_mismatch');
  }
  if (
    !mutation.accepted ||
    mutation.reason !== 'simulated_accepted_no_mutation' ||
    !mutation.external_effect_reference ||
    outcomeReceipt.external_effect_reference !== mutation.external_effect_reference ||
    canonicalJsonV2(outcomeReceipt.evidence) !== canonicalJsonV2(mutation)
  ) {
    throw new Error('lifecycle_reconciliation_outcome_mismatch');
  }
  return {
    schema_version: 'overseer-lifecycle-reconciliation-v1',
    snapshot_id: input.snapshot_id,
    preserved_member_target_key: input.original_member_target_key,
    wo_id: input.wo_id,
    issue_or_pr_key: input.issue_or_pr_key,
    run_id: input.run_id,
    card_id: input.card_id,
    mutation: input.mutation,
    lineage: [...input.existing_lineage, ...input.new_lineage],
    membership_collapsed: false,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function receiptDigestValid(receipt: M31ExecutionReceiptEventV2): boolean {
  const { event_digest: eventDigest, ...event } = receipt;
  return (
    /^[0-9a-f]{64}$/.test(eventDigest) &&
    createHash('sha256').update(canonicalJsonV2(event)).digest('hex') === eventDigest
  );
}
