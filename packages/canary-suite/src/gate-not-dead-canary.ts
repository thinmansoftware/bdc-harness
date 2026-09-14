import {
  resolveRequiredContexts,
  resetRequiredContextsAttemptCounters,
} from '@archon/overseer/adapters/required-contexts';
import {
  failResult,
  passResult,
  type OutcomeCanaryDeps,
  type OutcomeCanaryResult,
} from './outcome-canary';

export interface GateNotDeadGitHub {
  readonly getAllStatusCheckContexts: (input: {
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<{ data: string[] }>;
  readonly listCheckRunsForRef: (input: { owner: string; repo: string; ref: string }) => Promise<{
    data: { check_runs: { name?: string; status: string; conclusion: string | null }[] };
  }>;
  readonly getBranch?: (input: {
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<{ data: { protected?: boolean; commit?: { sha?: string } } }>;
  readonly getBranchRules?: (input: {
    owner: string;
    repo: string;
    branch: string;
  }) => Promise<{ data: unknown[] }>;
}

export interface GateNotDeadCanaryDeps extends OutcomeCanaryDeps {
  readonly owner?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly headSha?: string;
  readonly github?: GateNotDeadGitHub;
  readonly env?: Record<string, string | undefined>;
}

function checkIsGreen(run: { status: string; conclusion: string | null } | undefined): boolean {
  return run?.status === 'completed' && run.conclusion === 'success';
}

export async function runGateNotDeadCanary(
  deps: GateNotDeadCanaryDeps
): Promise<OutcomeCanaryResult> {
  const github = deps.github;
  if (!github) {
    return failResult('c6_required_check_red_on_head:github_client_missing', [
      'github_client=missing',
    ]);
  }
  const owner = deps.owner ?? 'thinmansoftware';
  const repo = deps.repo ?? 'bdc-harness';
  const branch = deps.branch ?? 'dev';
  try {
    resetRequiredContextsAttemptCounters();
    let headSha = deps.headSha;
    if (!headSha && github.getBranch) {
      const branchInfo = await github.getBranch({ owner, repo, branch });
      headSha = branchInfo.data.commit?.sha;
    }
    if (!headSha) {
      return failResult('c6_required_check_red_on_head:head_sha_missing', [`branch=${branch}`]);
    }
    const resolution = await resolveRequiredContexts(
      {
        owner,
        repo,
        baseRef: branch,
        headSha,
        fetchWithAppClient: input => github.getAllStatusCheckContexts(input),
        fetchBranch: github.getBranch,
        fetchBranchRules: github.getBranchRules,
      },
      deps.env ?? {}
    );
    if (resolution.state !== 'known') {
      return failResult(`c6_required_check_red_on_head:required_contexts_${resolution.state}`, [
        `branch=${branch}`,
        `head_sha=${headSha}`,
        `state=${resolution.state}`,
      ]);
    }
    if (resolution.contexts.length === 0) {
      return passResult([`branch=${branch}`, 'required_contexts=0', `source=${resolution.source}`]);
    }
    const listed = await github.listCheckRunsForRef({ owner, repo, ref: headSha });
    const runs = listed.data.check_runs;
    for (const context of resolution.contexts) {
      const run = runs.find(item => (item.name?.trim() || '') === context);
      if (!checkIsGreen(run)) {
        return failResult(`c6_required_check_red_on_head:${context}`, [
          `branch=${branch}`,
          `head_sha=${headSha}`,
          `status=${run?.status ?? 'missing'}`,
          `conclusion=${run?.conclusion ?? 'null'}`,
        ]);
      }
    }
    return passResult([
      `branch=${branch}`,
      `head_sha=${headSha}`,
      `required_contexts=${resolution.contexts.join(',')}`,
    ]);
  } finally {
    resetRequiredContextsAttemptCounters();
  }
}
