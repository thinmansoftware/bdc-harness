import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { loadAgentRegistry, type AgentRegistry } from '../agents/registry';
import type { WorkflowDefinition } from '../schemas/workflow';
import { createHash } from 'node:crypto';
export interface CodexOnlyBinding {
  project: string;
  codebaseId: string;
  cwd: string;
  workflowDigest: string;
}

export function workflowDigest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)])
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Compare the registration and definition actually loaded by the dispatch handler. */
export function matchesCodexOnlyBinding(
  binding: CodexOnlyBinding,
  actual: { codebaseId?: string | null; cwd?: string; workflow: unknown }
): boolean {
  return (
    actual.codebaseId === binding.codebaseId &&
    actual.cwd === binding.cwd &&
    workflowDigest(actual.workflow) === binding.workflowDigest
  );
}

declare const validatedWorkflowBrand: unique symbol;
export interface ValidatedWorkflowHandle {
  readonly [validatedWorkflowBrand]: true;
}
export interface ValidatedWorkflowContext {
  readonly validatedWorkflow?: ValidatedWorkflowHandle;
}
interface CapturedWorkflow {
  binding: CodexOnlyBinding;
  workflow: WorkflowDefinition;
  original: WorkflowDefinition;
  registry: AgentRegistry;
  message: string;
}
const validatedWorkflows = new WeakMap<ValidatedWorkflowHandle, CapturedWorkflow>();

/** Internal v1 handoff only. It does not open any dispatch gate. */
export async function captureValidatedWorkflow(
  binding: CodexOnlyBinding,
  workflow: WorkflowDefinition,
  message: string
): Promise<ValidatedWorkflowHandle> {
  if (
    workflow.name !== 'bdc-feature-development-codex-only' ||
    workflow.provider !== 'codex' ||
    workflow.nodes.some(
      node =>
        (node.provider !== undefined && node.provider !== 'codex') ||
        ('failover_provider' in node &&
          node.failover_provider !== undefined &&
          node.failover_provider !== 'codex')
    ) ||
    (workflow.failover_provider !== undefined && workflow.failover_provider !== 'codex')
  )
    throw new Error('codex_only_provider_forbidden');
  if (
    !matchesCodexOnlyBinding(binding, {
      codebaseId: binding.codebaseId,
      cwd: binding.cwd,
      workflow,
    })
  )
    throw new Error('codex_only_binding_changed');
  const registry = structuredClone(await loadAgentRegistry(join(binding.cwd, '.archon', 'agents')));
  if (workflowDigest(workflow) !== binding.workflowDigest)
    throw new Error('codex_only_binding_changed');
  const handle = Object.freeze({}) as ValidatedWorkflowHandle;
  validatedWorkflows.set(handle, {
    binding: structuredClone(binding),
    workflow: structuredClone(workflow),
    original: workflow,
    registry,
    message,
  });
  return handle;
}

export function validatedWorkflowIdentity(
  handle: ValidatedWorkflowHandle
): Readonly<CodexOnlyBinding> {
  const state = validatedWorkflows.get(handle);
  if (!state) throw new Error('codex_only_binding_changed');
  return Object.freeze({ ...state.binding });
}

export async function readValidatedWorkflow(
  handle: ValidatedWorkflowHandle,
  actual: { codebaseId?: string | null; cwd: string }
): Promise<{
  binding: CodexOnlyBinding;
  workflow: WorkflowDefinition;
  registry: AgentRegistry;
  message: string;
}> {
  const state = validatedWorkflows.get(handle);
  if (
    !state ||
    actual.codebaseId !== state.binding.codebaseId ||
    actual.cwd !== state.binding.cwd ||
    workflowDigest(state.original) !== state.binding.workflowDigest ||
    workflowDigest(state.workflow) !== state.binding.workflowDigest
  )
    throw new Error('codex_only_binding_changed');
  const registry = await loadAgentRegistry(join(actual.cwd, '.archon', 'agents'));
  if (!isDeepStrictEqual(registry, state.registry)) throw new Error('codex_only_binding_changed');
  return {
    binding: { ...state.binding },
    workflow: state.workflow,
    registry: structuredClone(state.registry),
    message: state.message,
  };
}
