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
  | 'fake_accepted'
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
      return receipt(bound, true, 'fake_accepted');
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
