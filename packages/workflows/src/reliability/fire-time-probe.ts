import { runProviderProbe, type ProbeClassification } from '@archon/providers/probe';
import type { AgentProviderFactory, WorkflowConfig } from '../deps';
import type { WorkflowDefinition } from '../schemas';
import type { ResolvedWorkflowBinding } from './resolve-binding';
import { resolveWorkflowBindings } from './resolve-binding';

export interface KnownBadBindingRecord {
  readonly binding_key: string;
  readonly error_body_excerpt: string;
  readonly hit_count: number;
}

export interface FireTimeProbeStore {
  readonly getActiveKnownBadBinding?: (bindingKey: string) => Promise<KnownBadBindingRecord | null>;
  readonly upsertKnownBadBinding?: (data: {
    binding_key: string;
    provider_id: string;
    model_id: string;
    auth_context_id: string;
    assistant_config_hash: string;
    node_override_hash: string;
    error_class: string;
    http_status?: number | null;
    error_body_excerpt: string;
    source: string;
  }) => Promise<unknown>;
  readonly incrementKnownBadBindingHit?: (bindingKey: string) => Promise<unknown>;
  readonly clearKnownBadBinding?: (bindingKey: string, reason: 'operator' | 'fire_reprobe') => Promise<unknown>;
}

export type FireTimeProbeAlert = (data: {
  level: 'red' | 'warn';
  workflowName: string;
  providerId: string;
  modelId: string;
  bindingKey: string;
  errorClass: string;
  errorBodyExcerpt: string;
}) => Promise<void>;

export interface FireTimeProbeOptions {
  readonly workflow: WorkflowDefinition;
  readonly config: WorkflowConfig;
  readonly workflowProvider: string;
  readonly workflowModel?: string;
  readonly cwd: string;
  readonly getAgentProvider: AgentProviderFactory;
  readonly store?: FireTimeProbeStore;
  readonly alert?: FireTimeProbeAlert;
  readonly retryDelayMs?: number;
}

export interface FireTimeProbeDecision {
  readonly status: 'pass' | 'warn' | 'block';
  readonly bindings: readonly ResolvedWorkflowBinding[];
  readonly failures: readonly {
    readonly binding: ResolvedWorkflowBinding;
    readonly classification: ProbeClassification;
  }[];
}

export async function runFireTimeProbe(
  options: FireTimeProbeOptions
): Promise<FireTimeProbeDecision> {
  const bindings = resolveWorkflowBindings(
    options.workflow,
    options.config,
    options.workflowProvider,
    options.workflowModel
  );
  const failures: {
    binding: ResolvedWorkflowBinding;
    classification: ProbeClassification;
  }[] = [];
  let hasWarn = false;

  for (const binding of bindings) {
    const active = await options.store?.getActiveKnownBadBinding?.(binding.bindingKey);
    if (active) {
      const reprobe = await runProviderProbe(
        { providerId: binding.providerId, modelId: binding.modelId, options: binding.options },
        options.cwd,
        options.getAgentProvider,
        { retryDelayMs: options.retryDelayMs }
      );
      if (reprobe.ok) {
        await options.store?.clearKnownBadBinding?.(binding.bindingKey, 'fire_reprobe');
        continue;
      }
      if (reprobe.classification?.kind === 'structural') {
        await options.store?.incrementKnownBadBindingHit?.(binding.bindingKey);
        failures.push({ binding, classification: reprobe.classification });
        await alert(options, binding, reprobe.classification, 'red');
        continue;
      }
      hasWarn = true;
      if (reprobe.classification) await alert(options, binding, reprobe.classification, 'warn');
      continue;
    }

    const result = await runProviderProbe(
      { providerId: binding.providerId, modelId: binding.modelId, options: binding.options },
      options.cwd,
      options.getAgentProvider,
      { retryDelayMs: options.retryDelayMs }
    );
    if (result.ok) continue;
    if (!result.classification) continue;
    if (result.classification.kind === 'structural') {
      await options.store?.upsertKnownBadBinding?.({
        binding_key: binding.bindingKey,
        provider_id: binding.providerId,
        model_id: binding.modelId,
        auth_context_id: binding.authContextId,
        assistant_config_hash: binding.assistantConfigHash,
        node_override_hash: binding.nodeOverrideHash,
        error_class: result.classification.errorClass,
        http_status: result.classification.httpStatus,
        error_body_excerpt: result.classification.errorBodyExcerpt,
        source: 'fire_time_probe',
      });
      failures.push({ binding, classification: result.classification });
      await alert(options, binding, result.classification, 'red');
    } else {
      hasWarn = true;
      await alert(options, binding, result.classification, 'warn');
    }
  }

  return { status: failures.length > 0 ? 'block' : hasWarn ? 'warn' : 'pass', bindings, failures };
}

async function alert(
  options: FireTimeProbeOptions,
  binding: ResolvedWorkflowBinding,
  classification: ProbeClassification,
  level: 'red' | 'warn'
): Promise<void> {
  await options.alert?.({
    level,
    workflowName: options.workflow.name,
    providerId: binding.providerId,
    modelId: binding.modelId,
    bindingKey: binding.bindingKey,
    errorClass: classification.errorClass,
    errorBodyExcerpt: classification.errorBodyExcerpt,
  });
}
