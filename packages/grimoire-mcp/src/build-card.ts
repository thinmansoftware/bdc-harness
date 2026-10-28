import type { BlockedPrCard, CauldronRun, RawReview, SourceStatus } from './card-types';
import { checksVerdict, decideBlocker, OVERSEER_BOT, reviewVerdict } from './decide-card';
import { readGitHub, type GitHubSnapshot } from './sources/github';
import { readEventStore, readTaskmaster } from './sources/event-store';

export const PR_REF_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;
export class InvalidPrRefError extends Error {
  constructor() {
    super('expected PR reference in owner/repo#N form');
  }
}
export interface CardDeps {
  github?: (owner: string, repo: string, number: number) => Promise<GitHubSnapshot>;
  eventStore?: (input: {
    owner: string;
    repo: string;
    number: number;
    headRef: string;
  }) => Promise<{ runs: CauldronRun[]; status: SourceStatus }>;
  taskmaster?: (input: {
    owner: string;
    repo: string;
    number: number;
  }) => Promise<{ recipient: string | null; status: SourceStatus }>;
  now?: () => Date;
}

function latestOverseer(reviews: RawReview[]): RawReview | undefined {
  return reviews
    .filter(r => r.user?.login === OVERSEER_BOT)
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    .at(-1);
}
function findings(reviews: RawReview[], head: string): string[] {
  const review = reviews
    .filter(r => r.user?.login === OVERSEER_BOT && r.commit_id === head && r.state !== 'APPROVED')
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    .at(-1);
  return (review?.body ?? '')
    .split(/\r?\n/)
    .filter(line => /^(- |\d+\.\s)/.test(line))
    .slice(0, 10);
}

export async function buildBlockedPrCard(ref: string, deps: CardDeps = {}): Promise<BlockedPrCard> {
  const match = PR_REF_PATTERN.exec(ref);
  if (!match) throw new InvalidPrRefError();
  const [, owner, repo, rawNumber] = match;
  const number = Number(rawNumber);
  const github = await (deps.github ?? readGitHub)(owner, repo, number);
  const [events, taskmaster] = await Promise.all([
    (deps.eventStore ?? readEventStore)({
      owner: owner,
      repo: repo,
      number,
      headRef: github.pr.head_ref,
    }),
    (deps.taskmaster ?? readTaskmaster)({ owner: owner, repo: repo, number }),
  ]);
  const rv = reviewVerdict(github.reviews, github.pr.head_sha);
  const cv = checksVerdict(github.checkRuns, github.statuses);
  const latest = latestOverseer(github.reviews);
  const latestByUser = new Map<string, RawReview>();
  github.reviews
    .filter(r => r.commit_id === github.pr.head_sha)
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    .forEach(r => latestByUser.set(r.user?.login ?? '?', r));
  const decision = decideBlocker({
    pr: github.pr,
    reviewVerdict: rv,
    checksVerdict: cv,
    woId: github.woId,
    runs: events.runs,
    githubAvailable: github.status === 'ok',
  });
  const ownerResult = github.issueAssignee
    ? { who: github.issueAssignee, source: 'issue_assignee' }
    : taskmaster.recipient
      ? { who: taskmaster.recipient, source: 'taskmaster_expectation' }
      : github.pr.author
        ? { who: github.pr.author, source: 'pr_author' }
        : { who: 'unowned', source: 'none' };
  return {
    pr: github.pr,
    owner: ownerResult,
    review: {
      latest_overseer: latest
        ? {
            state: latest.state ?? '',
            commit_id: latest.commit_id ?? null,
            on_exact_head: latest.commit_id === github.pr.head_sha,
          }
        : null,
      changes_requested_on_head_by: [...latestByUser]
        .filter(([, r]) => r.state === 'CHANGES_REQUESTED')
        .map(([u]) => u)
        .sort(),
      verdict: rv,
    },
    checks: github.checks,
    checks_verdict: cv,
    findings: findings(github.reviews, github.pr.head_sha),
    wo: { id: github.woId, issue: github.issue },
    cauldron_runs: events.runs,
    ...decision,
    sources: { github: github.status, event_store: events.status, taskmaster: taskmaster.status },
    generated_at: (deps.now?.() ?? new Date()).toISOString(),
  };
}
