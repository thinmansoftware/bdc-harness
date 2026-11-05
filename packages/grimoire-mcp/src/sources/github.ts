/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { createRealReadOnlyPatOctokitClient } from '@archon/overseer/adapters/github-real-deps';
import { resolveRequiredContexts } from '@archon/overseer/adapters/required-contexts';
import {
  latestAttemptPerCheck,
  conclusionIsPassing,
  PASSING_CONCLUSIONS,
} from '@archon/overseer/pr-review-check-ingest';
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
  woId: string | null;
  issue: number | null;
  issueAssignee: string | null;
  status: SourceStatus;
}
export class GitHubUnavailableError extends Error {}
const woPattern = /WO-[A-Z0-9-]+-[0-9]+/;
const issuePattern = /closes\s+(?:thinmansoftware\/bdc-xo)?#(\d+)/i;

export async function readGitHub(
  owner: string,
  repo: string,
  number: number,
  supplied?: unknown
): Promise<GitHubSnapshot> {
  const client: any = supplied ?? createRealReadOnlyPatOctokitClient();
  if (!client) throw new GitHubUnavailableError('GitHub authentication unavailable');
  let requests = 0;
  const call = async <T>(source: string, fn: () => Promise<T>): Promise<T> => {
    if (requests >= 10)
      throw new GitHubUnavailableError(`GitHub request cap exceeded while retrieving ${source}`);
    requests += 1;
    return fn();
  };
  const prResponse: any = await call('pull request', () =>
    client.pulls.get({ owner, repo, pull_number: number })
  );
  const p = prResponse.data;
  const head = p.head.sha;
  const title = p.title ?? '';
  const body = p.body ?? '';
  const woId = title.match(woPattern)?.[0] ?? body.match(woPattern)?.[0] ?? null;
  let issue = Number(body.match(issuePattern)?.[1] ?? '') || null;
  try {
    const reviews: RawReview[] = [];
    for (let page = 1; ; page += 1) {
      const response: any = await call('reviews', () =>
        client.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100, page })
      );
      reviews.push(...response.data);
      if (response.data.length < 100) break;
    }
    const checksResponse: any = await call('check runs', () =>
      client.checks.listForRef({ owner, repo, ref: head, per_page: 100, filter: 'latest' })
    );
    const statusesResponse: any = await call('statuses', () =>
      client.repos.listCommitStatusesForRef({ owner, repo, ref: head, per_page: 100 })
    );
    const checkRuns = latestAttemptPerCheck(checksResponse.data.check_runs as RawCheckRun[]);
    const statuses = statusesResponse.data as RawStatus[];
    let required: Set<string> | null = null;
    try {
      const resolution = await resolveRequiredContexts({
        owner,
        repo,
        baseRef: p.base?.ref,
        headSha: head,
        fetchWithPatClient: async args =>
          call('required contexts', () => client.repos.getAllStatusCheckContexts(args)),
      });
      if (resolution.state === 'known') required = new Set(resolution.contexts);
    } catch {
      required = null;
    }
    if (!issue && woId) {
      const search: any = await call('linked WO search', () =>
        client.search.issuesAndPullRequests({
          q: `repo:thinmansoftware/bdc-xo is:issue in:title ${woId}`,
          per_page: 1,
        })
      );
      issue = search.data.items[0]?.number ?? null;
    }
    let issueAssignee: string | null = null;
    if (issue) {
      const response: any = await call('linked WO issue', () =>
        client.issues.get({ owner: 'thinmansoftware', repo: 'bdc-xo', issue_number: issue })
      );
      issueAssignee = response.data.assignees?.[0]?.login ?? response.data.assignee?.login ?? null;
    }
    // These imports are intentional shared policy: latest attempts and accepted conclusions.
    void conclusionIsPassing;
    void PASSING_CONCLUSIONS;
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
    ];
    return {
      pr: makePr(),
      reviews,
      checkRuns,
      statuses,
      checks: displayed,
      woId,
      issue,
      issueAssignee,
      status: 'ok',
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
    const state = p.merged ? 'MERGED' : String(p.state).toUpperCase();
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
