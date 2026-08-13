import { readFileSync } from 'node:fs';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createLogger } from '@archon/paths';
import type {
  GitHubClientDeps,
  GitHubPullRequestMergeInput,
  GitHubPullRequestSearchInput,
  PullRequestCheckSummary,
  PullRequestEvidence,
  PullRequestRef,
} from '../types.ts';

const log = createLogger('overseer/github-real-deps');

/** The lookup ran and found nothing. A genuine "this PR does not exist". */
const MISSING_EVIDENCE: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: false,
};

/**
 * The lookup itself broke (API error, rate limit, bad credentials) so we learned
 * NOTHING about whether a PR exists. Distinct from MISSING_EVIDENCE: both keep the
 * merge door shut, but only this one means "ask again", and conflating them is what
 * let 493 unactioned runs report a confident "no PR" that was never established.
 */
const LOOKUP_FAILED_EVIDENCE: PullRequestEvidence = {
  exists: false,
  state: 'lookup_failed',
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  mergeable: null,
  lookupFailed: true,
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
    /**
     * Optional (like `issues` below) so existing structural mocks keep
     * compiling; createRealApprovePullRequest throws loudly when absent.
     */
    createReview?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      event: string;
    }): Promise<{ data: { id?: number; state?: string; html_url?: string } }>;
  };
  search: {
    issuesAndPullRequests(input: Record<string, unknown>): Promise<{
      data: { items: { number: number; pull_request?: unknown; repository_url?: string }[] };
    }>;
  };
  issues?: {
    createComment(input: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<{ data: { html_url?: string } }>;
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

/** Resolved GitHub App installation auth config (Thinman Overseer App). */
export interface GitHubAppAuthConfig {
  appId: number;
  installationId: number;
  privateKey: string;
}

/**
 * Resolve GitHub App auth from env (WO-HARNESS-OVERSEER-APP-AUTH-01).
 *
 * Returns null ONLY when ALL App vars are absent (caller falls back to the
 * PAT path). If ANY App var is set but the set is incomplete or malformed,
 * this THROWS naming the broken variable. It must NEVER fall back to the PAT
 * in that case: a silent downgrade would keep Overseer acting as John's
 * personal token instead of thinman-overseer[bot], which is the exact
 * failure this seam exists to prevent (M-141).
 */
export function resolveGitHubAppAuth(): GitHubAppAuthConfig | null {
  const appIdRaw = process.env.GITHUB_APP_ID ?? '';
  const installationIdRaw = process.env.GITHUB_APP_INSTALLATION_ID ?? '';
  const inlineKey = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? '';

  if (!appIdRaw && !installationIdRaw && !inlineKey && !keyPath) {
    return null;
  }

  if (!appIdRaw) {
    throw new Error(
      'overseer_real_adapter_app_auth_incomplete: GITHUB_APP_ID missing while other GITHUB_APP_* vars are set'
    );
  }
  if (!installationIdRaw) {
    throw new Error(
      'overseer_real_adapter_app_auth_incomplete: GITHUB_APP_INSTALLATION_ID missing while other GITHUB_APP_* vars are set'
    );
  }
  if (!inlineKey && !keyPath) {
    throw new Error(
      'overseer_real_adapter_app_auth_incomplete: set GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_PATH'
    );
  }

  const appId = Number(appIdRaw);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error(
      `overseer_real_adapter_app_auth_malformed: GITHUB_APP_ID must be a positive integer, got "${appIdRaw}"`
    );
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(
      `overseer_real_adapter_app_auth_malformed: GITHUB_APP_INSTALLATION_ID must be a positive integer, got "${installationIdRaw}"`
    );
  }

  let privateKey: string;
  if (inlineKey) {
    // Env-var-passed PEMs commonly arrive with literal backslash-n escapes;
    // normalize them so the RSA key survives the env boundary.
    privateKey = inlineKey.replace(/\\n/g, '\n');
  } else {
    try {
      privateKey = readFileSync(keyPath, 'utf8');
    } catch (error) {
      throw new Error(
        `overseer_real_adapter_app_auth_malformed: GITHUB_APP_PRIVATE_KEY_PATH not readable (${keyPath}): ${(error as Error).message}`
      );
    }
  }
  if (!privateKey.includes('-----BEGIN')) {
    const source = inlineKey
      ? 'GITHUB_APP_PRIVATE_KEY'
      : `GITHUB_APP_PRIVATE_KEY_PATH (${keyPath})`;
    throw new Error(
      `overseer_real_adapter_app_auth_malformed: ${source} does not contain a PEM (missing -----BEGIN header)`
    );
  }

  return { appId, installationId, privateKey };
}

/**
 * Construct a real Octokit client. Prefers GitHub App installation auth
 * (attributed to thinman-overseer[bot]) when the App env vars are present;
 * otherwise uses the standard PAT env token exactly as before.
 */
export function createRealOctokitClient(): RealGitHubOctokitLike {
  const appAuth = resolveGitHubAppAuth();
  if (appAuth) {
    log.info(
      { appId: appAuth.appId, installationId: appAuth.installationId },
      'overseer.github_real_deps.app_auth_selected'
    );
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: appAuth.appId,
        installationId: appAuth.installationId,
        privateKey: appAuth.privateKey,
      },
    }) as unknown as RealGitHubOctokitLike;
  }
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
      return LOOKUP_FAILED_EVIDENCE;
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
 * Real approvePullRequest: submits an APPROVED review via
 * octokit.pulls.createReview. GitHub rejects self-approval (a PR author
 * cannot approve its own PR, App identity or not) with a 422; that rejection
 * is surfaced with a named, actionable message instead of a raw API error.
 */
export function createRealApprovePullRequest(
  octokit: RealGitHubOctokitLike
): (input: PullRequestRef) => Promise<{ approved: boolean; message?: string }> {
  return async (input: PullRequestRef): Promise<{ approved: boolean; message?: string }> => {
    if (!octokit.pulls.createReview) {
      throw new Error('overseer_real_adapter_missing_create_review_api');
    }
    try {
      const response = await octokit.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        event: 'APPROVE',
      });
      return { approved: true, message: response.data.state };
    } catch (error) {
      const err = error as { status?: number; message?: string };
      if (err.status === 422) {
        throw new Error(
          `overseer_real_adapter_self_approval_rejected: GitHub refused the APPROVE review (a PR author cannot approve its own PR): ${err.message ?? 'unprocessable'}`
        );
      }
      log.error({ err: error, input }, 'overseer.github_real_deps.approve_pull_request_failed');
      throw error;
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
    approvePullRequest: createRealApprovePullRequest(octokit),
    commentOnPullRequest: async (input): Promise<{ commented: boolean; url?: string }> => {
      if (!octokit.issues) {
        throw new Error('overseer_real_adapter_missing_issues_api');
      }
      const response = await octokit.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.number,
        body: input.body,
      });
      return { commented: true, url: response.data.html_url };
    },
  };
}
