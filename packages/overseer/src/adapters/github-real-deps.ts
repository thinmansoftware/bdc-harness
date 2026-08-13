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
     * Optional so unrelated mocks (e.g. github-qualified-merge.test.ts's
     * createOctokitMock) that never approve keep type-checking. The real
     * approve path guards for its absence and throws loudly.
     */
    createReview?(input: {
      owner: string;
      repo: string;
      pull_number: number;
      event: 'APPROVE';
    }): Promise<{ data: { id: number; state: string } }>;
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

/** Resolved GitHub App installation-auth configuration. */
export interface GitHubAppAuthConfig {
  appId: string;
  installationId: string;
  privateKey: string;
}

/**
 * Resolve GitHub App (installation) auth from env, or null when no App vars are
 * set at all.
 *
 * Precedence contract (see WO-HARNESS-OVERSEER-APP-AUTH-01 sec 4.2 + risk 10):
 * - NONE of the App vars set  -> return null. Caller falls back to the PAT path.
 *   This is the "absent" case, and it is the ONLY case that falls back.
 * - App auth requested but incomplete/broken (any App var set, but the trio does
 *   not fully resolve to a real PEM) -> THROW naming the offending var. We never
 *   silently degrade to the PAT here: a half-configured App downgrading to John's
 *   PAT identity is the exact failure this WO exists to prevent.
 *
 * Private key may come from GITHUB_APP_PRIVATE_KEY (raw PEM contents, with
 * literal "\n" sequences from single-line env packing normalized to newlines) or
 * GITHUB_APP_PRIVATE_KEY_PATH (a file read at resolution time). Inline contents
 * win when both are set.
 */
export function resolveGitHubAppAuth(): GitHubAppAuthConfig | null {
  const appId = (process.env.GITHUB_APP_ID ?? '').trim();
  const installationId = (process.env.GITHUB_APP_INSTALLATION_ID ?? '').trim();
  const privateKeyInline = process.env.GITHUB_APP_PRIVATE_KEY ?? '';
  const privateKeyPath = (process.env.GITHUB_APP_PRIVATE_KEY_PATH ?? '').trim();

  const anyAppVarPresent =
    appId !== '' ||
    installationId !== '' ||
    privateKeyInline.trim() !== '' ||
    privateKeyPath !== '';
  if (!anyAppVarPresent) {
    return null; // Absent -> PAT fallback (the only fallback path).
  }

  // From here App auth was requested; any gap is a loud failure, never a PAT downgrade.
  if (appId === '') {
    throw new Error(
      'overseer_github_app_auth_incomplete: GITHUB_APP_ID is missing but other GITHUB_APP_* vars are set'
    );
  }
  if (installationId === '') {
    throw new Error(
      'overseer_github_app_auth_incomplete: GITHUB_APP_INSTALLATION_ID is missing but other GITHUB_APP_* vars are set'
    );
  }

  let privateKey = privateKeyInline;
  if (privateKey.trim() === '' && privateKeyPath !== '') {
    try {
      privateKey = readFileSync(privateKeyPath, 'utf8');
    } catch (error) {
      throw new Error(
        `overseer_github_app_auth_private_key_unreadable: could not read GITHUB_APP_PRIVATE_KEY_PATH (${privateKeyPath}): ${(error as Error).message}`
      );
    }
  }

  // Normalize single-line "\n"-packed PEMs back to real newlines. A PEM already
  // carrying real newlines (the file-path case) is unaffected by this replace.
  privateKey = privateKey.replace(/\\n/g, '\n').trim();

  if (privateKey === '') {
    throw new Error(
      'overseer_github_app_auth_private_key_missing: set GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_PATH'
    );
  }
  if (!privateKey.includes('-----BEGIN')) {
    throw new Error(
      'overseer_github_app_auth_private_key_malformed: GITHUB_APP_PRIVATE_KEY does not look like a PEM (missing -----BEGIN marker)'
    );
  }

  return { appId, installationId, privateKey };
}

/**
 * Octokit constructor options for real mode. App installation auth wins when App
 * vars are complete; otherwise the PAT path. Exposed as a network-free seam so
 * tests can assert which identity was selected without constructing a live
 * client or making an API call.
 */
export type RealOctokitAuthOptions =
  | {
      authStrategy: typeof createAppAuth;
      auth: { appId: string; privateKey: string; installationId: string };
    }
  | { auth: string };

export function resolveRealOctokitAuthOptions(): RealOctokitAuthOptions {
  const appAuth = resolveGitHubAppAuth();
  if (appAuth) {
    return {
      authStrategy: createAppAuth,
      auth: {
        appId: appAuth.appId,
        privateKey: appAuth.privateKey,
        installationId: appAuth.installationId,
      },
    };
  }
  return { auth: resolveGitHubToken() };
}

/**
 * Construct a real Octokit client. Uses GitHub App installation auth when the
 * App env vars are complete (attributing API calls to thinman-overseer[bot]),
 * otherwise falls back to the GH_TOKEN/GITHUB_TOKEN PAT path unchanged.
 */
export function createRealOctokitClient(): RealGitHubOctokitLike {
  return new Octokit(resolveRealOctokitAuthOptions()) as unknown as RealGitHubOctokitLike;
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
 * Real approvePullRequest: submits an APPROVE review via octokit.pulls.createReview.
 *
 * This is the capability the App identity unlocks -- GitHub forbids a user from
 * approving their own PR, and John is the only human in the org, so only a second
 * identity (thinman-overseer[bot]) can record a required-review approval.
 *
 * Self-approval is still rejected by GitHub regardless of identity (an App cannot
 * approve a PR it authored). GitHub returns 422 with a body message containing
 * "own pull request"; we surface that as a stable, usable code
 * ('github_review_self_approval_rejected') rather than letting a raw Octokit
 * error escape -- mirroring createRealMergePullRequest's httpStatus classification.
 */
export function createRealApprovePullRequest(
  octokit: RealGitHubOctokitLike
): (input: PullRequestRef) => Promise<{ approved: boolean; message?: string }> {
  return async (input: PullRequestRef): Promise<{ approved: boolean; message?: string }> => {
    if (!octokit.pulls.createReview) {
      throw new Error('overseer_real_adapter_missing_review_api');
    }
    try {
      const response = await octokit.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        event: 'APPROVE',
      });
      if (response.data.state !== 'APPROVED') {
        return {
          approved: false,
          message: `github_review_unexpected_state_${response.data.state}`,
        };
      }
      return { approved: true };
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? (error as { status?: number }).status
          : undefined;
      const messageValue =
        typeof error === 'object' && error !== null && 'message' in error
          ? (error as { message?: unknown }).message
          : undefined;
      const rawMessage = typeof messageValue === 'string' ? messageValue : '';
      if (status === 422 && /own pull request/i.test(rawMessage)) {
        return { approved: false, message: 'github_review_self_approval_rejected' };
      }
      if (status === 422) {
        return { approved: false, message: 'github_review_unprocessable' };
      }
      return { approved: false, message: 'github_review_transport_ambiguous' };
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
    approvePullRequest: createRealApprovePullRequest(octokit),
  };
}
