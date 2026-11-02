import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  clearRegistry,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '@archon/providers';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseWorkflow } from '../loader';
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

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

function loadDefaultWorkflow(filename: string): WorkflowDefinition {
  const content = readFileSync(join(LANES_DIR, filename), 'utf-8');
  const result = parseWorkflow(content, filename);
  if (!result.workflow) throw new Error(`${filename}: ${result.error?.error ?? 'failed to parse'}`);
  return result.workflow;
}

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

test('accepts canary-covered Claude lanes with explicit registered providers', () => {
  for (const filename of [
    'bdc-feature-development.yaml',
    'bdc-feature-development-fable.yaml',
    'bdc-multi-stage-development.yaml',
  ]) {
    expect(auditWorkflowExecutionCapabilities(loadDefaultWorkflow(filename)), filename).toEqual([]);
  }
});
