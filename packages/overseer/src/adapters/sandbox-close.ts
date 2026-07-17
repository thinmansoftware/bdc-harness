import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import {
  buildReopenRecipe,
  verifySalvageArtifact,
  type OverseerSalvageReceiptV1,
  type ReopenRecipeV1,
  type SalvageArtifactDepsV1,
} from '../actions/lifecycle';
import {
  prepareSandboxMutation,
  providerAcceptedResult,
  providerIndeterminateResult,
  type SandboxActionResultV1,
  type SandboxExecutionContextV1,
} from './sandbox-types';

export interface SandboxCloseInputV1 {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly salvage_receipt: OverseerSalvageReceiptV1;
  readonly salvage_deps: SalvageArtifactDepsV1;
  readonly required_observation_digest: string;
  readonly action_parameters_digest: string;
}

export type SandboxCloseResultV1 = SandboxActionResultV1 & {
  readonly reopen_recipe: ReopenRecipeV1 | null;
};

export async function closeSandboxPullRequest(
  input: SandboxCloseInputV1
): Promise<SandboxCloseResultV1> {
  const salvage = await verifySalvageArtifact(input.salvage_receipt, input.salvage_deps);
  const reopenRecipe = buildReopenRecipe({
    target: {
      repository: input.context.repository.full_name,
      target_kind: 'pull_request',
      target_key: input.context.proposal.target_key,
      target_digest: input.context.proposal.target_digest,
      snapshot_id: input.context.proposal.snapshot_id,
      target: input.context.proposal.target,
    },
    close_proposal_id: input.permit.proposal_id,
    close_execution_id: input.permit.execution_id,
    required_observation_digest: input.required_observation_digest,
    action_parameters_digest: input.action_parameters_digest,
  });
  if (!salvage.ok) {
    const prepared = await prepareSandboxMutation(input.context, input.permit, {
      adapter: 'sandbox-close',
      actionKind: 'CLOSE',
      capability: 'lifecycle',
    });
    return {
      ...prepared.result,
      accepted: false,
      reason: 'salvage_failed',
      reopen_recipe: reopenRecipe,
    };
  }
  const prepared = await prepareSandboxMutation(input.context, input.permit, {
    adapter: 'sandbox-close',
    actionKind: 'CLOSE',
    capability: 'lifecycle',
  });
  if (!prepared.ok) return { ...prepared.result, reopen_recipe: reopenRecipe };
  const mutation = await input.context.provider.closePullRequest({
    context: input.context,
    permit: input.permit,
    policy_entry: prepared.prepared.policyEntry,
  });
  const result = mutation.ok
    ? providerAcceptedResult(prepared.result, mutation.external_effect_reference)
    : providerIndeterminateResult(prepared.result);
  return { ...result, reopen_recipe: reopenRecipe };
}
