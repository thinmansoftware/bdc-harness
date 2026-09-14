import {
  resolveRequiredContexts,
  resetRequiredContextsAttemptCounters,
} from '@archon/overseer/adapters/required-contexts';
import type { RealGitHubOctokitLike } from '@archon/overseer/adapters/github-real-deps';
import {
  blockedResult,
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

/** Map the App-authenticated octokit onto the narrow shape C6 reads. */
export function createGateNotDeadGitHubAdapter(octokit: RealGitHubOctokitLike): GateNotDeadGitHub {
  const repos = octokit.repos;
  const hasBranch = typeof repos?.getBranch === 'function';
  const hasRules = typeof repos?.getBranchRules === 'function';
  const branchFn = hasBranch
    ? async (input: {
        owner: string;
        repo: string;
        branch: string;
      }): Promise<{ data: { protected?: boolean; commit?: { sha?: string } } }> => {
        if (!repos?.getBranch) throw new Error('github_getBranch_unavailable');
        const result = await repos.getBranch(input);
        // The runtime octokit branch payload carries commit.sha; the narrow type omits it.
        const commit = (result.data as { commit?: { sha?: string } }).commit;
        const sha = typeof commit?.sha === 'string' && commit.sha !== '' ? commit.sha : undefined;
        return {
          data: {
            protected: result.data.protected,
            ...(sha ? { commit: { sha } } : {}),
          },
        };
      }
    : undefined;
  const rulesFn = hasRules
    ? async (input: {
        owner: string;
        repo: string;
        branch: string;
      }): Promise<{ data: unknown[] }> => {
        if (!repos?.getBranchRules) throw new Error('github_getBranchRules_unavailable');
        return await repos.getBranchRules(input);
      }
    : undefined;
  return {
    getAllStatusCheckContexts: async (input: {
      owner: string;
      repo: string;
      branch: string;
    }): Promise<{ data: string[] }> => {
      if (!repos?.getAllStatusCheckContexts) {
        throw new Error('github_getAllStatusCheckContexts_unavailable');
      }
      return await repos.getAllStatusCheckContexts(input);
    },
    listCheckRunsForRef: (input: {
      owner: string;
      repo: string;
      ref: string;
    }): Promise<{
      data: { check_runs: { name?: string; status: string; conclusion: string | null }[] };
    }> =>
      octokit.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        per_page: 100,
      }),
    ...(branchFn ? { getBranch: branchFn } : {}),
    ...(rulesFn ? { getBranchRules: rulesFn } : {}),
  };
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
    return blockedResult('c6_github_client_unavailable', ['github_client=unavailable']);
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
      // A base with no required checks IS a dead gate: nothing can turn red, so
      // nothing can hold a merge. Review finding, PR #840 round 9.
      return failResult('c6_no_required_checks_on_base', [
        `branch=${branch}`,
        `head_sha=${headSha}`,
        'required_contexts=0',
        `source=${resolution.source}`,
      ]);
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
