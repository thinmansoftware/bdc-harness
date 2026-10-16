import type { WorkflowDeps } from './deps';
import type { MessageChunk } from '@archon/providers/types';
import type { WorkflowDefinition, WorkflowRun } from './schemas';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { buildRunAuthority } from './reliability/run-authority';
import { assertExecutionEnabled } from '@archon/paths/offline-qualification';
import {
  assertTeeTimeProvider,
  assertTeeTimeAuthority,
  assertTeeTimeRunPolicy,
  policyBlocked,
  policyDigest,
  resolveTeeTimePolicy,
  teeTimeRunPolicy,
  TEE_TIME_WORKFLOW,
} from '@archon/paths/tee-time-policy';

/** Only provider IDs with verified internal fallback behavior are admitted. */
export function guardTeeTimeProviders(deps: WorkflowDeps): WorkflowDeps {
  return {
    ...deps,
    getAgentProvider(provider): ReturnType<WorkflowDeps['getAgentProvider']> {
      assertTeeTimeProvider(provider, undefined, false);
      const client = deps.getAgentProvider(provider);
      return {
        getType: () => client.getType(),
        getCapabilities: () => client.getCapabilities(),
        async *sendQuery(prompt, cwd, sessionId, options): AsyncGenerator<MessageChunk> {
          assertTeeTimeProvider(provider, options?.model);
          // Disallow hidden model/agent selections and per-provider default overrides.
          if (
            options?.fallbackModel ||
            options?.nodeConfig?.fallbackModel ||
            options?.nodeConfig?.agents
          ) {
            policyBlocked('fallback models and nested agent definitions are not permitted');
          }
          const assistantModel = options?.assistantConfig?.model;
          if (assistantModel !== undefined && assistantModel !== options?.model) {
            policyBlocked('assistant model override differs from policy');
          }
          for await (const chunk of client.sendQuery(prompt, cwd, sessionId, options)) {
            if (chunk.type === 'result' && chunk.servedModelId) {
              assertTeeTimeProvider(provider, chunk.servedModelId);
            }
            yield chunk;
          }
        },
      };
    },
  };
}

export async function resolveRestrictedRun(
  deps: WorkflowDeps,
  codebaseId: string | undefined,
  message: string,
  workflow: Pick<WorkflowDefinition, 'name'>
): Promise<Record<string, unknown> | null> {
  assertExecutionEnabled();
  const codebase = codebaseId ? await deps.store.getCodebase(codebaseId) : null;
  if (!resolveTeeTimePolicy(codebase, message)) return null;
  if (!codebase) policyBlocked('stored codebase is missing');
  const { BUNDLED_WORKFLOWS } = await import('./defaults/bundled-defaults');
  const { parseWorkflow } = await import('./loader');
  const woIds = [...new Set(message.match(/\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) ?? [])];
  if (woIds.length !== 1 || !/^WO-TEETIME-FOUNDATION-[0-9]+$/.test(woIds[0])) {
    policyBlocked('exactly one foundation WO identity is required');
  }
  const bundled = BUNDLED_WORKFLOWS[TEE_TIME_WORKFLOW];
  if (!bundled) policyBlocked('reviewed bundled workflow is missing');
  const parsed = parseWorkflow(bundled, `${TEE_TIME_WORKFLOW}.yaml`);
  if (parsed.error) policyBlocked('reviewed bundled workflow is invalid');
  const trustedWorkflow = parsed.workflow;
  if (
    workflow.name !== TEE_TIME_WORKFLOW ||
    policyDigest(workflow) !== policyDigest(trustedWorkflow)
  ) {
    policyBlocked('workflow definition differs from reviewed foundation workflow');
  }
  return teeTimeRunPolicy(codebase.id, policyDigest(workflow), woIds[0]);
}

export function assertRestrictedResume(
  run: WorkflowRun,
  expected: Record<string, unknown> | null
): void {
  if (expected) {
    if (run.codebase_id !== expected.codebaseId)
      policyBlocked('resumed run belongs to a different codebase');
    assertTeeTimeRunPolicy(run.metadata?.execution_policy, expected);
  } else if (run.metadata?.execution_policy !== undefined) {
    policyBlocked('restricted run cannot resume without its policy');
  }
}

export async function assertRestrictedAuthority(
  deps: WorkflowDeps,
  run: WorkflowRun,
  policy: Record<string, unknown>,
  workflowName: string,
  cwd: string,
  artifactsDir: string
): Promise<void> {
  const authority = await deps.store.getRunAuthority(run.id);
  assertTeeTimeAuthority(policy, authority);
  if (
    authority?.runId !== run.id ||
    authority.workflowName !== workflowName ||
    authority.codebaseId !== run.codebase_id ||
    resolve(authority.worktreePath) !== resolve(cwd)
  ) {
    policyBlocked('persisted authority identity or worktree mismatch');
  }
  const specBytes = await readFile(join(artifactsDir, 'authority', 'work-order.md'));
  const rebuilt = buildRunAuthority({ ...authority, specBytes });
  const manifest = JSON.parse(
    await readFile(join(artifactsDir, 'authority', 'run-authority.json'), 'utf8')
  );
  if (
    rebuilt.specHash !== authority.specHash ||
    policyDigest(manifest) !== policyDigest(authority)
  ) {
    policyBlocked('frozen authority artifacts drifted');
  }
}
