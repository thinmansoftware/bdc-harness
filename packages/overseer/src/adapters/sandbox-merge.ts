import type { M31ActionPermitV2 } from '@archon/core/db/m31-target-v2';
import {
  prepareSandboxMutation,
  providerAcceptedResult,
  providerIndeterminateResult,
  type SandboxActionResultV1,
  type SandboxExecutionContextV1,
} from './sandbox-types';

export async function mergeSandboxPullRequest(
  context: SandboxExecutionContextV1,
  permit: M31ActionPermitV2
): Promise<SandboxActionResultV1> {
  const prepared = await prepareSandboxMutation(context, permit, {
    adapter: 'sandbox-merge',
    actionKind: 'MERGE',
    capability: 'merge',
  });
  if (!prepared.ok) return prepared.result;
  const mutation = await context.provider.mergePullRequest({
    context,
    permit,
    policy_entry: prepared.prepared.policyEntry,
  });
  return mutation.ok
    ? providerAcceptedResult(prepared.result, mutation.external_effect_reference)
    : providerIndeterminateResult(prepared.result);
}
