import { createRealReadOnlyPatOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import { resolveRequiredContexts } from '@archon/overseer/adapters/required-contexts';
import { latestAttemptPerCheck } from '@archon/overseer/pr-review-check-ingest';
import type {
  CardCheck,
  PrData,
  RawCheckRun,
  RawReview,
  RawStatus,
  SourceStatus,
} from '../card-types';

export interface GitHubSnapshot {
  pr: PrData;
  reviews: RawReview[];
  checkRuns: RawCheckRun[];
  statuses: RawStatus[];
  checks: CardCheck[];
  /** Required contexts with no check run or status on the exact head. */
  requiredMissing?: string[];
  woId: string | null;
  issue: number | null;
  issueAssignee: string | null;
  status: SourceStatus;
}
export class GitHubUnavailableError extends Error {}

interface PullData {
  title?: string | null;
  body?: string | null;
  html_url: string;
  state: string;
  merged?: boolean | null;
  draft?: boolean | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head: { sha: string; ref?: string | null };
  base?: { ref?: string | null } | null;
  user?: { login?: string | null } | null;
}
type Get<T> = (args: Record<string, unknown>) => Promise<{ data: T }>;
/** The GET-only Octokit surface the card reads; the metered PAT client satisfies it. */
export interface CardGitHubClient {
  pulls: { get: Get<PullData>; listReviews: Get<RawReview[]> };
  checks: { listForRef: Get<{ check_runs: RawCheckRun[] }> };
  repos: {
    listCommitStatusesForRef: Get<RawStatus[]>;
    getAllStatusCheckContexts: (args: {
      owner: string;
      repo: string;
      branch: string;
    }) => Promise<{ data: string[] }>;
  };
  search: { issuesAndPullRequests: Get<{ items: { number: number }[] }> };
  issues: {
    get: Get<{ assignees?: { login: string }[] | null; assignee?: { login: string } | null }>;
  };
}
const woPattern = /WO-[A-Z0-9-]+-[0-9]+/;
const issuePattern = /closes\s+(?:thinmansoftware\/bdc-xo)?#(\d+)/i;

export async function readGitHub(
  owner: string,
  repo: string,
  number: number,
  supplied?: unknown
): Promise<GitHubSnapshot> {
  // Boundary assertion: tests inject fakes and the real metered client is Octokit-typed;
  // both expose this read-only surface.
  const client = (supplied ?? createRealReadOnlyPatOctokitClient()) as CardGitHubClient | null;
  if (!client) throw new GitHubUnavailableError('GitHub authentication unavailable');
  let requests = 0;
  let capHit = false;
  const call = async <T>(source: string, fn: () => Promise<T>): Promise<T> => {
    if (requests >= 10) {
      capHit = true;
      throw new GitHubUnavailableError(`GitHub request cap exceeded while retrieving ${source}`);
    }
    requests += 1;
    return fn();
  };
  const prResponse = await call('pull request', () =>
    client.pulls.get({ owner, repo, pull_number: number })
  );
  const p = prResponse.data;
  const head = p.head.sha;
  const title = p.title ?? '';
  const body = p.body ?? '';
  const woId = woPattern.exec(title)?.[0] ?? woPattern.exec(body)?.[0] ?? null;
  let issue = Number(issuePattern.exec(body)?.[1] ?? '') || null;
  try {
    const reviews: RawReview[] = [];
    for (let page = 1; ; page += 1) {
      const response = await call('reviews', () =>
        client.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100, page })
      );
      reviews.push(...response.data);
      if (response.data.length < 100) break;
    }
    const allCheckRuns: RawCheckRun[] = [];
    for (let page = 1; ; page += 1) {
      const response = await call('check runs', () =>
        client.checks.listForRef({
          owner,
          repo,
          ref: head,
          per_page: 100,
          page,
          filter: 'latest',
        })
      );
      const pageRuns = response.data.check_runs;
      allCheckRuns.push(...pageRuns);
      if (pageRuns.length < 100) break;
    }
    const statuses: RawStatus[] = [];
    for (let page = 1; ; page += 1) {
      const response = await call('statuses', () =>
        client.repos.listCommitStatusesForRef({ owner, repo, ref: head, per_page: 100, page })
      );
      statuses.push(...response.data);
      if (response.data.length < 100) break;
    }
    const checkRuns = latestAttemptPerCheck(allCheckRuns);
    // Fail closed: merge readiness needs a KNOWN required-context set. The resolver
    // turns fetch errors into state 'unknown', so a cap hit inside it is re-raised here.
    let required: Set<string> | null = null;
    let requiredStatus: SourceStatus = 'ok';
    try {
      const resolution = await resolveRequiredContexts({
        owner,
        repo,
        baseRef: p.base?.ref ?? null,
        headSha: head,
        fetchWithPatClient: async args =>
          call('required contexts', () => client.repos.getAllStatusCheckContexts(args)),
      });
      if (capHit)
        throw new GitHubUnavailableError(
          'GitHub request cap exceeded while retrieving required contexts'
        );
      if (resolution.state === 'known') required = new Set(resolution.contexts);
      else
        requiredStatus = `unavailable: required contexts ${resolution.state}: ${resolution.reason}`;
    } catch (error) {
      if (error instanceof GitHubUnavailableError) throw error;
      requiredStatus = `unavailable: required contexts lookup failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    const reported = new Set([
      ...checkRuns.map(c => c.name ?? ''),
      ...statuses.map(s => s.context ?? ''),
    ]);
    const requiredMissing = required ? [...required].filter(ctx => !reported.has(ctx)).sort() : [];
    if (!issue && woId) {
      const search = await call('linked WO search', () =>
        client.search.issuesAndPullRequests({
          q: `repo:thinmansoftware/bdc-xo is:issue in:title ${woId}`,
          per_page: 1,
        })
      );
      issue = search.data.items[0]?.number ?? null;
    }
    let issueAssignee: string | null = null;
    if (issue) {
      const response = await call('linked WO issue', () =>
        client.issues.get({ owner: 'thinmansoftware', repo: 'bdc-xo', issue_number: issue })
      );
      issueAssignee = response.data.assignees?.[0]?.login ?? response.data.assignee?.login ?? null;
    }
    const displayed: CardCheck[] = [
      ...checkRuns.map(c => ({
        name: c.name ?? '?',
        kind: 'run' as const,
        state: c.status === 'completed' ? (c.conclusion ?? 'unknown') : (c.status ?? 'unknown'),
        required: required ? required.has(c.name ?? '') : null,
      })),
      ...statuses.map(s => ({
        name: s.context ?? '?',
        kind: 'status' as const,
        state: s.state ?? 'unknown',
        required: required ? required.has(s.context ?? '') : null,
      })),
      ...requiredMissing.map(name => ({
        name,
        kind: 'run' as const,
        state: 'missing',
        required: true,
      })),
    ];
    return {
      pr: makePr(),
      reviews,
      checkRuns,
      statuses,
      checks: displayed,
      requiredMissing,
      woId,
      issue,
      issueAssignee,
      status: requiredStatus,
    };
  } catch (error) {
    if (
      !(error instanceof GitHubUnavailableError) ||
      !error.message.startsWith('GitHub request cap exceeded')
    )
      throw error;
    return {
      pr: makePr(),
      reviews: [],
      checkRuns: [],
      statuses: [],
      checks: [],
      woId,
      issue,
      issueAssignee: null,
      status: `unavailable: ${error.message}`,
    };
  }

  function makePr(): PrData {
    const state = p.merged ? 'MERGED' : p.state.toUpperCase();
    return {
      repo: `${owner}/${repo}`,
      number,
      title,
      url: p.html_url,
      state,
      draft: Boolean(p.draft),
      head_sha: head,
      head_ref: p.head.ref ?? '',
      base_ref: p.base?.ref ?? '',
      production_base:
        p.base?.ref === 'master' ||
        String(p.base?.ref).startsWith('release/') ||
        (repo === 'lspro-react' && p.base?.ref === 'main'),
      conflicting: p.mergeable === false || p.mergeable_state === 'dirty',
      author: p.user?.login ?? undefined,
    };
  }
}
