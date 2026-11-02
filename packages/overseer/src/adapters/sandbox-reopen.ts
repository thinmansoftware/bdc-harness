import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import type { ReopenRecipeV1 } from '../actions/lifecycle';
import {
  prepareSandboxMutation,
  providerAcceptedResult,
  providerIndeterminateResult,
  type SandboxActionResultV1,
  type SandboxExecutionContextV1,
} from './sandbox-types';

export interface SandboxReopenInputV1 {
  readonly context: SandboxExecutionContextV1;
  readonly permit: M31ActionPermitV2;
  readonly reopen_recipe: ReopenRecipeV1;
  readonly observed_false_digest: string;
}

function recipeMatches(input: SandboxReopenInputV1): boolean {
  return (
    input.reopen_recipe.schema_version === 'overseer-lifecycle-reopen-recipe-v1' &&
    input.reopen_recipe.inverse_provider_action === 'REOPEN' &&
    input.reopen_recipe.prior_proposal_id.length > 0 &&
    input.reopen_recipe.prior_execution_id.length > 0 &&
    input.reopen_recipe.required_observation_digest === input.observed_false_digest &&
    input.reopen_recipe.target.repository === input.context.repository.full_name &&
    input.reopen_recipe.target.target_kind === 'pull_request' &&
    input.reopen_recipe.target.target_key === input.context.proposal.target_key &&
    input.reopen_recipe.target.target_digest === input.context.proposal.target_digest &&
    input.reopen_recipe.target.snapshot_id === input.context.proposal.snapshot_id
  );
}

export async function reopenSandboxPullRequest(
  input: SandboxReopenInputV1
): Promise<SandboxActionResultV1> {
  if (!recipeMatches(input)) {
    const prepared = await prepareSandboxMutation(input.context, input.permit, {
      adapter: 'sandbox-reopen',
      actionKind: 'REOPEN',
      capability: 'lifecycle',
    });
    return { ...prepared.result, accepted: false, reason: 'rollback_recipe_mismatch' };
  }
  const prepared = await prepareSandboxMutation(input.context, input.permit, {
    adapter: 'sandbox-reopen',
    actionKind: 'REOPEN',
    capability: 'lifecycle',
  });
  if (!prepared.ok) return { ...prepared.result, reopen_recipe: input.reopen_recipe };
  const mutation = await input.context.provider.reopenPullRequest({
    context: input.context,
    permit: input.permit,
    policy_entry: prepared.prepared.policyEntry,
  });
  const result = mutation.ok
    ? providerAcceptedResult(prepared.result, mutation.external_effect_reference)
    : providerIndeterminateResult(prepared.result);
  return { ...result, reopen_recipe: input.reopen_recipe };
}
