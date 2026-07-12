import type { SendQueryOptions } from '@archon/providers/types';
import { stableHash, withBindingKey, type ProviderProbeBinding } from '@archon/providers/probe';
import { getRegisteredProviders, isRegisteredProvider } from '@archon/providers';
import type { WorkflowConfig } from '../deps';
import type { DagNode, WorkflowDefinition } from '../schemas';

export interface ResolveWorkflowBindingsInput {
  readonly workflow: WorkflowDefinition;
  readonly workflowProvider: string;
  readonly workflowModel: string | undefined;
  readonly config: WorkflowConfig;
}

function authContextId(providerId: string): string {
  const upper = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const hasApiKey =
    Boolean(process.env[`${upper}_API_KEY`]) ||
    (providerId === 'openrouter' && Boolean(process.env.OPENROUTER_API_KEY)) ||
    (providerId === 'claude' && Boolean(process.env.ANTHROPIC_API_KEY)) ||
    (providerId === 'codex' && Boolean(process.env.OPENAI_API_KEY));
  if (providerId.startsWith('codex')) return hasApiKey ? `${providerId}:api-key` : `${providerId}:chatgpt-account`;
  return hasApiKey ? `${providerId}:api-key` : `${providerId}:ambient-auth`;
}

function nodeOverrides(node: DagNode): Record<string, unknown> {
  return {
    model: node.model,
    provider: node.provider,
    effort: node.effort,
    thinking: node.thinking,
    sandbox: node.sandbox,
    fallbackModel: node.fallbackModel,
    failover_provider: (node as { failover_provider?: string }).failover_provider,
    failover_model: (node as { failover_model?: string }).failover_model,
  };
}

function optionsForNode(
  node: DagNode,
  providerId: string,
  modelId: string | undefined,
  config: WorkflowConfig
): SendQueryOptions {
  return {
    ...(modelId ? { model: modelId } : {}),
    assistantConfig: config.assistants[providerId] ?? {},
    nodeConfig: {
      mcp: node.mcp,
      hooks: node.hooks,
      skills: node.skills,
      agents: node.agents,
      allowed_tools: node.allowed_tools,
      denied_tools: node.denied_tools,
      effort: node.effort,
      thinking: node.thinking,
      sandbox: node.sandbox,
      fallbackModel: node.fallbackModel,
    },
  };
}

export function resolveWorkflowProbeBindings(
  input: ResolveWorkflowBindingsInput
): readonly ProviderProbeBinding[] {
  const bindings = new Map<string, ProviderProbeBinding>();
  for (const node of input.workflow.nodes) {
    if (!('prompt' in node) && !('command' in node)) continue;
    const providerId = node.provider ?? input.workflowProvider;
    if (!isRegisteredProvider(providerId)) {
      throw new Error(
        `Workflow '${input.workflow.name}': unknown provider '${providerId}'. Registered: ${getRegisteredProviders()
          .map(provider => provider.id)
          .join(', ')}`
      );
    }
    const assistantConfig = input.config.assistants[providerId] ?? {};
    const modelId =
      node.model ??
      (providerId === input.workflowProvider
        ? input.workflowModel
        : (assistantConfig.model as string | undefined)) ??
      'default';
    const binding = withBindingKey({
      providerId,
      modelId,
      authContextId: authContextId(providerId),
      assistantConfigHash: stableHash(assistantConfig),
      nodeOverrideHash: stableHash(nodeOverrides(node)),
      options: optionsForNode(node, providerId, modelId, input.config) as Record<string, unknown>,
    });
    bindings.set(binding.bindingKey ?? '', binding);
  }
  return [...bindings.values()];
}
