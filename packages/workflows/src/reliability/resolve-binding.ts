import {
  createBindingKey,
  hashAssistantConfig,
  hashNodeOverride,
  type ProviderBindingFingerprint,
} from '@archon/providers/probe';
import type { SendQueryOptions } from '@archon/providers/types';
import type { WorkflowConfig } from '../deps';
import type { DagNode, WorkflowDefinition } from '../schemas';

export interface ResolvedWorkflowBinding extends ProviderBindingFingerprint {
  readonly bindingKey: string;
  readonly nodeIds: readonly string[];
  readonly options: SendQueryOptions;
}

export function resolveWorkflowBindings(
  workflow: WorkflowDefinition,
  config: WorkflowConfig,
  workflowProvider: string,
  workflowModel?: string
): ResolvedWorkflowBinding[] {
  const byKey = new Map<string, ResolvedWorkflowBinding>();
  for (const node of workflow.nodes) {
    const binding = resolveNodeBinding(node, workflow, config, workflowProvider, workflowModel);
    const existing = byKey.get(binding.bindingKey);
    if (existing) {
      byKey.set(binding.bindingKey, { ...existing, nodeIds: [...existing.nodeIds, node.id] });
    } else {
      byKey.set(binding.bindingKey, binding);
    }
  }
  return [...byKey.values()];
}

export function resolveNodeBinding(
  node: DagNode,
  workflow: WorkflowDefinition,
  config: WorkflowConfig,
  workflowProvider: string,
  workflowModel?: string
): ResolvedWorkflowBinding {
  const providerId = node.provider ?? workflowProvider;
  const assistantConfig = config.assistants[providerId] ?? {};
  const modelId =
    node.model ??
    (providerId === workflowProvider ? workflowModel : (assistantConfig.model as string | undefined)) ??
    '';
  const nodeOverrideHash = hashNodeOverride({
    model: node.model,
    provider: node.provider,
    effort: node.effort ?? workflow.effort,
    thinking: node.thinking ?? workflow.thinking,
    sandbox: node.sandbox ?? workflow.sandbox,
    fallbackModel: node.fallbackModel ?? workflow.fallbackModel,
    failover_provider: node.failover_provider ?? workflow.failover_provider,
    failover_model: node.failover_model ?? workflow.failover_model,
  });
  const fingerprint: ProviderBindingFingerprint = {
    providerId,
    modelId,
    authContextId: deriveAuthContextId(providerId, assistantConfig),
    assistantConfigHash: hashAssistantConfig(assistantConfig),
    nodeOverrideHash,
  };
  return {
    ...fingerprint,
    bindingKey: createBindingKey(fingerprint),
    nodeIds: [node.id],
    options: {
      ...(modelId ? { model: modelId } : {}),
      assistantConfig,
      nodeConfig: {
        effort: node.effort ?? workflow.effort,
        thinking: node.thinking ?? workflow.thinking,
        sandbox: node.sandbox ?? workflow.sandbox,
        fallbackModel: node.fallbackModel ?? workflow.fallbackModel,
      },
    },
  };
}

function deriveAuthContextId(providerId: string, assistantConfig: Record<string, unknown>): string {
  const hasApiKey = Object.keys(assistantConfig).some(key => /api[_-]?key/i.test(key));
  if (providerId.startsWith('codex')) return 'codex:chatgpt-account';
  if (providerId.startsWith('claude')) return hasApiKey ? 'claude:api-key' : 'claude:oauth';
  return `${providerId}:${hasApiKey ? 'api-key' : 'default'}`;
}
