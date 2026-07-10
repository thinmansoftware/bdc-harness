import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import type { WorkflowDefinition } from '../schemas';
import { auditWorkflowExecutionCapabilities } from './workflow-capability-audit';

beforeEach(() => {
  clearRegistry();
  registerBuiltinProviders();
  registerCommunityProviders();
});

afterEach(clearRegistry);

const writeWorkflowWithProvider = (provider: string) =>
  ({
    name: `fixture-${provider}`,
    description: 'capability audit fixture',
    provider,
    nodes: [
      {
        id: 'implement',
        prompt: 'Implement.',
        allowed_tools: ['Read', 'Edit', 'Bash'],
      },
    ],
  }) as WorkflowDefinition;

test('reports a registered provider that cannot execute a mutating node', () => {
  expect(auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('opr-zero'))).toContainEqual(
    expect.objectContaining({ reason: 'provider_execution_capability_mismatch' })
  );
});

test('reports an unknown effective provider', () => {
  expect(
    auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('missing-provider'))
  ).toContainEqual(expect.objectContaining({ reason: 'provider_not_registered' }));
});

test('accepts a capable provider', () => {
  expect(auditWorkflowExecutionCapabilities(writeWorkflowWithProvider('claude'))).toEqual([]);
});
