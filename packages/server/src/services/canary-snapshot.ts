import { loadConfig } from '@archon/core';
import { getCodebase } from '@archon/core/db/codebases';
import { getCauldronDrainState, type CauldronDrainState } from '@archon/core/db/workflows';
import { execFileAsync, getRemoteUrl, toRepoPath } from '@archon/git';
import { getProviderInfoList, type ProviderInfo } from '@archon/providers';
import { loadRuleset } from '@archon/smart-cauldron/conductor';
import { loadLadder } from '@archon/smart-cauldron/ladder';
import {
  captureRuntimeRevisions,
  hashWorkflowDefinition,
} from '@archon/workflows/reliability/runtime-revisions';
import { auditWorkflowExecutionCapabilities } from '@archon/workflows/reliability/workflow-capability-audit';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { CanarySnapshotResponse } from '../routes/schemas/canary.schemas';
import { normalizeGitHubRemote } from './canonical-remote';

export interface CanarySnapshotDeps {
  getCodebase(
    id: string
  ): Promise<{ id: string; default_cwd: string; repository_url: string | null } | null>;
  discover(cwd: string): Promise<WorkflowLoadResult>;
  getDrain(): Promise<CauldronDrainState>;
  getRemote(cwd: string): Promise<string | null>;
  gitRevision(cwd: string, revision: string): Promise<string>;
  getProviders(): ProviderInfo[];
  now(): Date;
}

export async function buildCanarySnapshot(
  codebaseId: string,
  baseBranch: 'dev',
  deps: CanarySnapshotDeps
): Promise<CanarySnapshotResponse> {
  const codebase = await deps.getCodebase(codebaseId);
  if (!codebase) throw new Error(`canary_codebase_missing: ${codebaseId}`);
  const discovery = await deps.discover(codebase.default_cwd);
  if (discovery.workflows.length === 0) throw new Error('canary_workflows_empty');
  const rawRemote = await deps.getRemote(codebase.default_cwd);
  if (!rawRemote) throw new Error('canary_remote_missing');
  const workflows = discovery.workflows.map(item => ({
    name: item.workflow.name,
    source: item.source,
    revision: hashWorkflowDefinition(item.workflow),
    capabilityIssues: auditWorkflowExecutionCapabilities(item.workflow).map(
      issue => `${issue.reason}: ${issue.nodeId}: ${issue.provider}: ${issue.detail}`
    ),
  }));
  const revisions = await captureRuntimeRevisions(discovery.workflows[0].workflow);
  return {
    observedAt: deps.now().toISOString(),
    codebase: {
      id: codebase.id,
      canonicalRemote: normalizeGitHubRemote(rawRemote),
      defaultCwd: codebase.default_cwd,
      baseBranch,
      baseSha: await deps.gitRevision(codebase.default_cwd, `refs/remotes/origin/${baseBranch}`),
      headSha: await deps.gitRevision(codebase.default_cwd, 'HEAD'),
    },
    revisions: {
      engineRevision: revisions.engineRevision,
      bundleRevision: revisions.bundleRevision,
      runtimeImageRevision: revisions.runtimeImageRevision,
    },
    drain: await deps.getDrain(),
    workflows,
    providers: deps.getProviders(),
    loaderErrors: [...discovery.errors],
    ladder: { tiers: loadLadder() },
    ruleset: loadRuleset(),
  };
}

async function gitRevision(cwd: string, revision: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', cwd, 'rev-parse', '--verify', `${revision}^{commit}`],
    { timeout: 10000 }
  );
  const value = stdout.trim();
  if (!value) throw new Error(`canary_git_revision_missing: ${revision}`);
  return value;
}

export async function buildProductionCanarySnapshot(
  codebaseId: string,
  baseBranch: 'dev'
): Promise<CanarySnapshotResponse> {
  return buildCanarySnapshot(codebaseId, baseBranch, {
    getCodebase,
    discover: cwd => discoverWorkflowsWithConfig(cwd, loadConfig),
    getDrain: getCauldronDrainState,
    getRemote: cwd => getRemoteUrl(toRepoPath(cwd)),
    gitRevision,
    getProviders: getProviderInfoList,
    now: () => new Date(),
  });
}
