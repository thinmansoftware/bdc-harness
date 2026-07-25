import { Octokit } from '@octokit/rest';
import { createLogger } from '@archon/paths';
import type {
  GitHubClientDeps,
  GitHubPullRequestMergeInput,
  GitHubPullRequestSearchInput,
  PullRequestCheckSummary,
  PullRequestEvidence,
} from '../types.ts';

const log = createLogger('overseer/github-real-deps');

const MISSING_EVIDENCE: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
};

/**
 * Minimal Octokit surface this module depends on. Kept narrow and structurally
 * typed (not `import type { Octokit }` directly) so tests can pass a plain
 * mock object without constructing a real client.
 */
export interface RealGitHubOctokitLike {
  pulls: {
    list(input: Record<string, unknown>): Promise<{
      data: {
        number: number;
        title: string;
        state: string;
        merged_at?: string | null;
        html_url: string;
        head: { sha: string };
      }[];
    }>;
    get(input: Record<string, unknown>): Promise<{
      data: {
        number: number;
        title: string;
        state: string;
        merged?: boolean;
        mergeable?: boolean | null;
        html_url: string;
        changed_files?: number;
        head: { sha: string };
      };
    }>;
    merge(input: {
      owner: string;
      repo: string;
      pull_number: number;
      sha: string;
    }): Promise<{ data: { merged: boolean; sha?: string | null } }>;
  };
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: { items: { number: number; pull_request?: unknown; repository_url?: string }[] };
    }>;
  };
  checks: {
    listForRef(input: Record<string, unknown>): Promise<{
      data: {
        check_runs: { status: string; conclusion: string | null }[];
      };
    }>;
  };
}

/** Resolve the GitHub token from the standard env vars. No fallback secrets. */
export function resolveGitHubToken(): string {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  if (!token) {
    throw new Error(
      'overseer_real_adapter_missing_github_token: set GH_TOKEN or GITHUB_TOKEN to run Overseer in real mode'
    );
  }
  return token;
}

/** Construct a real Octokit client from the standard env token. */
export function createRealOctokitClient(): RealGitHubOctokitLike {
  const auth = resolveGitHubToken();
  return new Octokit({ auth }) as unknown as RealGitHubOctokitLike;
}

function summarizeChecks(
  checkRuns: { status: string; conclusion: string | null }[]
): PullRequestCheckSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') {
      pending += 1;
      continue;
    }
    if (
      run.conclusion === 'success' ||
      run.conclusion === 'neutral' ||
      run.conclusion === 'skipped'
    ) {
      passed += 1;
    } else {
      failed += 1;
    }
  }
  return { total: checkRuns.length, passed, failed, pending };
}

/**
 * Real findPullRequest: looks up an open PR by head branch first (fast path),
 * falling back to a WO-ID title/body search (mirrors reconcile.ts's approach)
 * when no headBranch is supplied. Evidence fields are populated only from
 * live API data -- no invented defaults beyond the documented "missing" shape.
 */
export function createRealFindPullRequest(
  octokit: RealGitHubOctokitLike
): (input: GitHubPullRequestSearchInput) => Promise<PullRequestEvidence> {
  return async (input: GitHubPullRequestSearchInput): Promise<PullRequestEvidence> => {
    try {
      let prNumber: number | null = null;

      if (input.headBranch) {
        const list = await octokit.pulls.list({
          owner: input.owner,
          repo: input.repo,
          head: `${input.owner}:${input.headBranch}`,
          state: 'all',
          per_page: 5,
        });
        prNumber = list.data[0]?.number ?? null;
      }

      if (prNumber === null && input.woId) {
        const search = await octokit.search.issuesAndPullRequests({
          q: `repo:${input.owner}/${input.repo} is:pr ${input.woId} in:title`,
          per_page: 5,
        });
        const match = search.data.items.find(item => item.pull_request);
        prNumber = match?.number ?? null;
      }

      if (prNumber === null) return MISSING_EVIDENCE;

      const pr = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: prNumber,
      });

      const checkRunsResp = await octokit.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: pr.data.head.sha,
        per_page: 100,
      });
      const checks = summarizeChecks(checkRunsResp.data.check_runs);

      const state = pr.data.merged ? 'merged' : pr.data.state;

      return {
        exists: true,
        state,
        checks,
        mergeable: pr.data.mergeable ?? null,
        pr: { owner: input.owner, repo: input.repo, number: pr.data.number },
        prTitle: pr.data.title,
        filesChangedCount: pr.data.changed_files,
        htmlUrl: pr.data.html_url,
        // Provenance anchor: GitHub's own view of the PR head, not run metadata.
        headSha: pr.data.head.sha,
      };
    } catch (error) {
      log.error({ err: error, input }, 'overseer.github_real_deps.find_pull_request_failed');
      return MISSING_EVIDENCE;
    }
  };
}

/**
 * Real mergePullRequest for the GitHubClientDeps / merge-manager composition.
 *
 * NOTE: this deliberately calls octokit.pulls.merge directly rather than
 * routing through adapters/github-qualified-merge.ts's
 * createGitHubQualifiedMergeAdapter(). That adapter's attemptMerge() takes a
 * QualifiedMergeAdapterRequestV2 -- a permit/proposal/execution/digest-signed
 * request assembled only by the actions/merge-ready.ts assessor flow (a
 * separate, older merge path). merge-manager.ts's own doc comment says it
 * "deliberately does not call the legacy merge-ready assessment path"; wiring
 * this GitHubClientDeps.mergePullRequest through that adapter would require
 * fabricating permit_id/proposal_id/digest fields that mean something real
 * only in that other flow. This function instead composes the qualified
 * merge adapter's httpStatus-based error classification (409/422 =
 * rejected, other transport errors = ambiguous) directly against the plain
 * PR-ref input merge-manager.ts already provides.
 */
export function createRealMergePullRequest(
  octokit: RealGitHubOctokitLike
): (input: GitHubPullRequestMergeInput) => Promise<{ merged: boolean; message?: string }> {
  return async (
    input: GitHubPullRequestMergeInput
  ): Promise<{ merged: boolean; message?: string }> => {
    const pr = await octokit.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.number,
    });
    try {
      const response = await octokit.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        sha: pr.data.head.sha,
      });
      if (!response.data.merged) {
        return { merged: false, message: 'github_merge_not_merged' };
      }
      return { merged: true, message: input.commitTitle };
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 409 || status === 422) {
        return { merged: false, message: `github_merge_rejected_${status}` };
      }
      return { merged: false, message: 'github_merge_transport_ambiguous' };
    }
  };
}

/**
 * Build the real (non-fake) GitHubClientDeps composition for Overseer. Fails
 * loudly at construction time if the token is missing -- never silently
 * degrades to a stub in real mode.
 */
export function createRealGitHubClientDeps(
  octokit: RealGitHubOctokitLike = createRealOctokitClient()
): GitHubClientDeps {
  return {
    findPullRequest: createRealFindPullRequest(octokit),
    mergePullRequest: createRealMergePullRequest(octokit),
  };
}
