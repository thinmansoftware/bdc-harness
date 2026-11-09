/**
 * Post-merge stray-push sweep (WO-HARNESS-MERGE-OWNER-REWORKING-GUARD-01, rule (d)).
 *
 * A squash merge lands the PR head the Overseer approved. If the PR branch
 * still exists afterwards at a DIFFERENT sha, someone pushed after the merge
 * and that work never reached the base branch (bdc-xo #5021: two spec
 * amendments pushed after the merge, never on main). This sweep finds those
 * branches and raises ONE operator card per PR and stray sha.
 *
 * Scope (WO-HARNESS-POST-MERGE-SWEEP-COVERAGE-01): merges by any path. The candidates are
 * the pull requests GitHub reports as merged in the last 7 days in the repositories the
 * merge policy covers (createGitHubMergedSource), so a merge the bridge or the run-linked
 * manager never recorded, or a hand merge, is covered too. GitHub keeps pull.head.sha at the
 * merged head while the branch moves, so no event-store row is needed. The earlier
 * verdict-store source stays only as an injectable test seam (listMerged).
 *
 * Once per PR and stray sha: the card id is derived from a deterministic event
 * identity (PR + stray sha + merge time), and appendOperatorCard is
 * ON CONFLICT DO NOTHING. The sweep also looks the card up first so a repeat
 * run neither re-resolves the owner nor re-enters the escalation path. No new
 * table, no migration. The alert reaches the work's owner through the existing
 * escalation path (runEscalation: owner routing, operator card, delivery jobs).
 */

import { getOperatorCard, type OperatorCardRecord } from '@archon/core/db/overseer-briefing';
import { createLogger } from '@archon/paths';
import { runEscalation, type EscalationDeps } from './escalate';
import {
  deriveOperatorCardId,
  OPERATOR_CARD_IDENTITY_VERSION,
  type ActionableEventIdentity,
} from './operator-card';

const log = createLogger('overseer/post-merge-stray-sweep');

export const POST_MERGE_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const POST_MERGE_STRAY_EVENT_TYPE = 'post_merge_stray_push';
export const POST_MERGE_STRAY_STEP_NAME = 'post-merge-sweep';

/** The slice of an overseer_verdicts row the sweep needs. */
export interface MergedVerdictForSweep {
  id: string;
  run_id: string;
  wo_id: string;
  pr_url: string | null;
  /** The head the Overseer approved and the merge call was pinned to. */
  head_sha: string;
  /** When the merge outcome was recorded; stable after the merge. */
  updated_at: string;
}

export type BranchState =
  | { state: 'exists'; sha: string }
  | { state: 'gone' }
  | { state: 'unknown' };

/**
 * Where a PR's head branch lives. For a fork PR the head repository is NOT the base
 * repository, so the branch must be read there; reading the base repository would miss a
 * push to the fork, or alert on an unrelated upstream branch of the same name.
 */
export interface PullRequestHead {
  branch: string;
  owner: string;
  repo: string;
}

export interface StrayBranchReader {
  /**
   * The PR's head branch and the repository it lives in, or undefined when it cannot be
   * read (including a deleted head repository).
   */
  readPullRequestHead(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<PullRequestHead | undefined>;
  readBranch(input: { owner: string; repo: string; branch: string }): Promise<BranchState>;
}

export interface StrayBranchOctokitLike {
  pulls: {
    get(input: Record<string, unknown>): Promise<{
      data: {
        head: {
          ref?: string;
          repo?: { name?: string; owner?: { login?: string } | null } | null;
        };
      };
    }>;
  };
  git: {
    getRef(input: Record<string, unknown>): Promise<{ data: { object: { sha: string } } }>;
  };
}

export function createStrayBranchReader(octokit: StrayBranchOctokitLike): StrayBranchReader {
  return {
    async readPullRequestHead(input): Promise<PullRequestHead | undefined> {
      try {
        const pr = await octokit.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
        });
        const head = pr.data.head;
        const branch = head.ref;
        const owner = head.repo?.owner?.login;
        const repo = head.repo?.name;
        // A null head.repo is a deleted fork: unreadable, never a guess at the base repo.
        if (
          typeof branch !== 'string' ||
          branch.length === 0 ||
          typeof owner !== 'string' ||
          owner.length === 0 ||
          typeof repo !== 'string' ||
          repo.length === 0
        ) {
          return undefined;
        }
        return { branch, owner, repo };
      } catch {
        return undefined;
      }
    },
    async readBranch(input): Promise<BranchState> {
      try {
        const ref = await octokit.git.getRef({
          owner: input.owner,
          repo: input.repo,
          ref: `heads/${input.branch}`,
        });
        const sha = ref.data.object.sha;
        return typeof sha === 'string' && sha.length > 0
          ? { state: 'exists', sha }
          : { state: 'unknown' };
      } catch (error) {
        // 404 is the only answer that means the branch is gone; anything else
        // (rate limit, auth, network) is unknown and must never raise an alert.
        return (error as { status?: number }).status === 404
          ? { state: 'gone' }
          : { state: 'unknown' };
      }
    },
  };
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;

export function parsePullRequestUrl(
  url: string
): { owner: string; repo: string; number: number } | null {
  const match = PR_URL.exec(url.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * One merged pull request to examine. Both candidate sources produce this shape.
 * `head` is the PR's head branch and repository when the source already knows it,
 * 'unreadable' when it cannot be known (a deleted fork), and undefined to have the
 * reader look it up.
 */
export interface SweepCandidate {
  pr: { owner: string; repo: string; number: number };
  runId: string;
  woId: string;
  /** The head that was merged. */
  mergedHeadSha: string;
  /** When the PR merged; stable, so the card identity is stable. */
  eventAt: string;
  head?: PullRequestHead | 'unreadable';
}

/** The verdict-store seam (kept for tests): the run id and time are the verdict's. */
function candidateFromVerdict(verdict: MergedVerdictForSweep): SweepCandidate | null {
  const pr = verdict.pr_url ? parsePullRequestUrl(verdict.pr_url) : null;
  if (!pr || !verdict.head_sha) return null;
  return {
    pr,
    runId: verdict.run_id,
    woId: verdict.wo_id,
    mergedHeadSha: verdict.head_sha,
    eventAt: verdict.updated_at,
  };
}

/**
 * The first WO id in a pull request title or head branch (titles first), or null. WO ids
 * end in a short counter, so the lazy match stops at the counter and does not swallow a
 * trailing thread suffix such as -thread-12345678.
 */
const WO_TOKEN = /\bWO-[A-Z0-9]+(?:-[A-Z0-9]+)*?-\d{1,3}\b/i;
export function extractWoId(title: string, branch: string): string | null {
  for (const text of [title, branch]) {
    const match = WO_TOKEN.exec(text);
    if (match) return match[0].toUpperCase();
  }
  return null;
}

export const POST_MERGE_SWEEP_MAX_PAGES = 10;
const LIST_PAGE_SIZE = 100;

interface ListedPull {
  number: number;
  title?: string;
  merged_at?: string | null;
  updated_at?: string;
  head: {
    ref?: string;
    sha?: string;
    repo?: { name?: string; owner?: { login?: string } | null } | null;
  };
}

export interface GitHubMergedListOctokitLike {
  pulls: {
    list(input: Record<string, unknown>): Promise<{ data: ListedPull[] }>;
  };
}

/**
 * Candidates from GitHub: for each repository, closed pull requests sorted by updated
 * descending, paged until a page is short or wholly older than the window (a PR merged in
 * the window was updated at or after its merge, so nothing older can qualify), at most
 * POST_MERGE_SWEEP_MAX_PAGES pages. Reaching the cap is logged and never raises an alert.
 * A repository that cannot be listed is skipped and logged; it never throws.
 */
export function createGitHubMergedSource(
  octokit: GitHubMergedListOctokitLike,
  repos: readonly { owner: string; repo: string }[]
): (sinceIso: string) => Promise<SweepCandidate[]> {
  return async (sinceIso): Promise<SweepCandidate[]> => {
    const since = Date.parse(sinceIso);
    const out: SweepCandidate[] = [];
    for (const { owner, repo } of repos) {
      let capped = true;
      try {
        for (let page = 1; page <= POST_MERGE_SWEEP_MAX_PAGES; page++) {
          const listed = await octokit.pulls.list({
            owner,
            repo,
            state: 'closed',
            sort: 'updated',
            direction: 'desc',
            per_page: LIST_PAGE_SIZE,
            page,
          });
          const items = listed.data;
          for (const item of items) {
            const mergedAtMs = item.merged_at ? Date.parse(item.merged_at) : Number.NaN;
            if (!Number.isFinite(mergedAtMs) || mergedAtMs < since) continue;
            const branch = item.head.ref;
            const headOwner = item.head.repo?.owner?.login;
            const headRepo = item.head.repo?.name;
            const sha = item.head.sha;
            const hasHead =
              typeof branch === 'string' &&
              branch.length > 0 &&
              typeof headOwner === 'string' &&
              headOwner.length > 0 &&
              typeof headRepo === 'string' &&
              headRepo.length > 0;
            if (typeof sha !== 'string' || sha.length === 0) continue;
            const slug = `${owner}/${repo}#${item.number}`;
            out.push({
              pr: { owner, repo, number: item.number },
              runId: `post-merge-sweep:${slug}`,
              woId: extractWoId(item.title ?? '', branch ?? '') ?? `PR-${slug}`,
              mergedHeadSha: sha,
              eventAt: new Date(mergedAtMs).toISOString(),
              head: hasHead ? { branch, owner: headOwner, repo: headRepo } : 'unreadable',
            });
          }
          const last = items[items.length - 1];
          const lastUpdated = last?.updated_at ? Date.parse(last.updated_at) : Number.NaN;
          if (
            items.length < LIST_PAGE_SIZE ||
            (Number.isFinite(lastUpdated) && lastUpdated < since)
          ) {
            capped = false;
            break;
          }
        }
        if (capped) {
          log.warn(
            { owner, repo, pages: POST_MERGE_SWEEP_MAX_PAGES },
            'overseer.post_merge_sweep.page_cap_reached'
          );
        }
      } catch (error) {
        log.warn({ owner, repo, err: error as Error }, 'overseer.post_merge_sweep.list_failed');
      }
    }
    return out;
  };
}

export interface PostMergeSweepOptions {
  /** The candidate source: merged pull requests from GitHub. Give this or listMerged. */
  listCandidates?: (sinceIso: string) => Promise<readonly SweepCandidate[]>;
  /** Test seam: bridge merge verdicts from the event store. Give this or listCandidates. */
  listMerged?: (sinceIso: string) => Promise<readonly MergedVerdictForSweep[]>;
  reader: StrayBranchReader;
  now?: Date;
  windowMs?: number;
  /** Defaults to runEscalation; tests may wrap it to count calls. */
  escalate?: typeof runEscalation;
  /** Passed through to runEscalation (owner resolver). */
  escalationDeps?: EscalationDeps;
  /** Defaults to the real operator card lookup. */
  lookupCard?: (cardId: string) => Promise<unknown>;
}

export interface PostMergeSweepResult {
  examined: number;
  alerted: { prUrl: string; branch: string; straySha: string; cardId: string }[];
  alreadyAlerted: number;
  noStray: number;
  unreadable: number;
}

function strayIdentity(candidate: SweepCandidate, straySha: string): ActionableEventIdentity {
  const pr = candidate.pr;
  return {
    identity_version: OPERATOR_CARD_IDENTITY_VERSION,
    source_event_id: `post-merge-stray:${pr.owner}/${pr.repo}#${pr.number}:${straySha}`,
    run_id: candidate.runId,
    wo_id: candidate.woId,
    event_type: POST_MERGE_STRAY_EVENT_TYPE,
    step_name: POST_MERGE_STRAY_STEP_NAME,
    event_created_at: new Date(candidate.eventAt).toISOString(),
    error_class: 'unknown',
  };
}

export async function runPostMergeStraySweepOnce(
  options: PostMergeSweepOptions
): Promise<PostMergeSweepResult> {
  const now = options.now ?? new Date();
  const sinceIso = new Date(
    now.getTime() - (options.windowMs ?? POST_MERGE_SWEEP_WINDOW_MS)
  ).toISOString();
  const escalate = options.escalate ?? runEscalation;
  const lookupCard = options.lookupCard ?? getOperatorCard;
  const listMerged = options.listMerged;
  if ((options.listCandidates === undefined) === (listMerged === undefined)) {
    throw new Error('post_merge_sweep_needs_exactly_one_candidate_source');
  }
  let unreadableSources = 0;
  let candidates: readonly SweepCandidate[] = [];
  if (options.listCandidates) {
    candidates = await options.listCandidates(sinceIso);
  } else if (listMerged) {
    const rows = await listMerged(sinceIso);
    const converted: SweepCandidate[] = [];
    for (const row of rows) {
      const candidate = candidateFromVerdict(row);
      if (candidate) converted.push(candidate);
      else unreadableSources += 1;
    }
    candidates = converted;
  }
  const result: PostMergeSweepResult = {
    examined: candidates.length + unreadableSources,
    alerted: [],
    alreadyAlerted: 0,
    noStray: 0,
    unreadable: unreadableSources,
  };

  for (const candidate of candidates) {
    const pr = candidate.pr;
    const head =
      candidate.head === 'unreadable'
        ? undefined
        : (candidate.head ?? (await options.reader.readPullRequestHead(pr)));
    if (!head) {
      result.unreadable += 1;
      continue;
    }
    const state = await options.reader.readBranch({
      owner: head.owner,
      repo: head.repo,
      branch: head.branch,
    });
    if (state.state === 'unknown') {
      result.unreadable += 1;
      continue;
    }
    // Gone, or still exactly at the merged head: nothing was pushed after the merge.
    if (state.state === 'gone' || state.sha === candidate.mergedHeadSha) {
      result.noStray += 1;
      continue;
    }

    const identity = strayIdentity(candidate, state.sha);
    const cardId = deriveOperatorCardId(identity);
    if (await lookupCard(cardId)) {
      result.alreadyAlerted += 1;
      continue;
    }

    const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    const repository = `${pr.owner}/${pr.repo}`;
    const headRepository = `${head.owner}/${head.repo}`;
    // A fork branch is named with its repository so the owner looks in the right place.
    const branch =
      headRepository.toLowerCase() === repository.toLowerCase()
        ? head.branch
        : `${headRepository}:${head.branch}`;
    const card: OperatorCardRecord = await escalate(
      candidate.runId,
      {
        decision: 'escalate',
        reason:
          `post-merge stray push: branch ${branch} of ${prUrl} is at ${state.sha}, ` +
          `not the merged head ${candidate.mergedHeadSha}; that work is not on the base branch`,
      },
      {
        errorClass: 'unknown',
        woId: candidate.woId,
        repository,
        branch,
        prUrl,
        prNumber: pr.number,
        headSha: state.sha,
        mergeability: 'merged',
        remediation: [
          `Compare ${candidate.mergedHeadSha}..${state.sha} on branch ${branch}.`,
          'Open a follow-up PR with the stray commits, or confirm they are disposable.',
        ],
        evidenceLinks: {
          pull_request: prUrl,
          head_repository: headRepository,
          merged_head_sha: candidate.mergedHeadSha,
          stray_sha: state.sha,
        },
      },
      {
        sourceEventId: identity.source_event_id,
        eventType: identity.event_type,
        stepName: identity.step_name,
        eventCreatedAt: identity.event_created_at,
      },
      options.escalationDeps
    );
    log.info(
      {
        prUrl,
        branch,
        straySha: state.sha,
        mergedHead: candidate.mergedHeadSha,
        cardId: card.card_id,
      },
      'merge-sweep.stray_push_alert'
    );
    result.alerted.push({ prUrl, branch, straySha: state.sha, cardId: card.card_id });
  }
  return result;
}
