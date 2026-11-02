import { getMissingProviderExecutionCapabilities, isRegisteredProvider } from '@archon/providers';
import type { WorkflowDefinition } from '../schemas';
import { deriveNodeExecutionRequirements } from '../schemas/dag-node';

export interface WorkflowCapabilityIssue {
  readonly workflowName: string;
  readonly nodeId: string;
  readonly provider: string;
  readonly reason: 'provider_not_registered' | 'provider_execution_capability_mismatch';
  readonly detail: string;
}

export function auditWorkflowExecutionCapabilities(
  workflow: WorkflowDefinition
): WorkflowCapabilityIssue[] {
  const issues: WorkflowCapabilityIssue[] = [];
  for (const node of workflow.nodes) {
    const required = deriveNodeExecutionRequirements(node);
    if (required.length === 0) continue;
    const provider = ('provider' in node ? node.provider : undefined) ?? workflow.provider;
    if (!provider || !isRegisteredProvider(provider)) {
      issues.push({
        workflowName: workflow.name,
        nodeId: node.id,
        provider: provider ?? '',
        reason: 'provider_not_registered',
        detail: 'effective provider is not registered',
      });
      continue;
    }
    const missing = getMissingProviderExecutionCapabilities(provider, required);
    if (missing.length > 0) {
      issues.push({
        workflowName: workflow.name,
        nodeId: node.id,
        provider,
        reason: 'provider_execution_capability_mismatch',
        detail: `missing ${missing.join(', ')}`,
      });
    }
  }
  return issues;
}
