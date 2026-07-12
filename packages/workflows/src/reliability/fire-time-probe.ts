import {
  probeProviderBinding,
  type ProviderProbeDeps,
  type ProviderProbeResult,
  type ProviderProbeBinding,
} from '@archon/providers/probe';
import {
  clearKnownBadBinding,
  findActiveByBindingKey,
  incrementKnownBadBindingHit,
  upsertKnownBadBinding,
} from '@archon/core/db/known-bad-bindings';
import type { WorkflowConfig, WorkflowDeps } from '../deps';
import type { WorkflowDefinition } from '../schemas';
import { resolveWorkflowProbeBindings } from './resolve-binding';

export interface FireTimeProbeInput {
  readonly workflow: WorkflowDefinition;
  readonly workflowProvider: string;
  readonly workflowModel: string | undefined;
  readonly config: WorkflowConfig;
  readonly cwd: string;
  readonly source: 'fire_probe' | 'binding_change' | 'operator';
  readonly allowFireReprobeClear?: boolean;
}

export interface FireTimeProbeDecision {
  readonly blocked: boolean;
  readonly warnings: readonly ProviderProbeResult[];
  readonly blockedResult?: ProviderProbeResult;
  readonly bindings: readonly ProviderProbeBinding[];
}

function isFailed(result: ProviderProbeResult): result is Extract<ProviderProbeResult, { ok: false }> {
  return !result.ok;
}

async function persistStructuralFailure(
  result: Extract<ProviderProbeResult, { ok: false }>,
  source: FireTimeProbeInput['source']
): Promise<void> {
  await upsertKnownBadBinding({
    bindingKey: result.binding.bindingKey ?? '',
    providerId: result.binding.providerId,
    modelId: result.binding.modelId,
    authContextId: result.binding.authContextId,
    assistantConfigHash: result.binding.assistantConfigHash,
    nodeOverrideHash: result.binding.nodeOverrideHash,
    errorClass: result.classification.errorClass,
    httpStatus: result.classification.httpStatus,
    errorBodyExcerpt: result.classification.excerpt,
    source,
  });
}

export async function runFireTimeProbe(
  deps: Pick<WorkflowDeps, 'getAgentProvider'> | ProviderProbeDeps,
  input: FireTimeProbeInput
): Promise<FireTimeProbeDecision> {
  const bindings = resolveWorkflowProbeBindings(input);
  const warnings: ProviderProbeResult[] = [];

  for (const binding of bindings) {
    if (input.allowFireReprobeClear && binding.bindingKey) {
      const active = await findActiveByBindingKey(binding.bindingKey);
      if (active) {
        const reprobe = await probeProviderBinding(binding, input.cwd, deps);
        if (reprobe.ok) {
          await clearKnownBadBinding(binding.bindingKey, 'fire_reprobe');
          continue;
        }
        if (isFailed(reprobe) && reprobe.classification.kind === 'structural') {
          await incrementKnownBadBindingHit(binding.bindingKey);
          return { blocked: true, warnings, blockedResult: reprobe, bindings };
        }
        warnings.push(reprobe);
        continue;
      }
    }

    const result = await probeProviderBinding(binding, input.cwd, deps);
    if (result.ok) continue;
    if (result.classification.kind === 'structural') {
      await persistStructuralFailure(result, input.source);
      return { blocked: true, warnings, blockedResult: result, bindings };
    }
    warnings.push(result);
  }

  return { blocked: false, warnings, bindings };
}

export function formatProbeBlock(decision: FireTimeProbeDecision): string {
  const result = decision.blockedResult;
  if (!result || result.ok) return 'canary_probe_blocked';
  return `canary_probe_blocked:${result.classification.errorClass}:${result.binding.providerId}:${result.binding.modelId}`;
}
