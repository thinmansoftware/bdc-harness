/**
 * Post-merge stray-push sweep (WO-HARNESS-MERGE-OWNER-REWORKING-GUARD-01, rule (d)).
 *
 * A squash merge lands the PR head the Overseer approved. If the PR branch
 * still exists afterwards at a DIFFERENT sha, someone pushed after the merge
 * and that work never reached the base branch (bdc-xo #5021: two spec
 * amendments pushed after the merge, never on main). This sweep finds those
 * branches and raises ONE operator card per PR and stray sha.
 *
 * Scope: PRs the merge-execution bridge merged (overseer_verdicts rows with
 * action_reason 'merge_executed') in the last 7 days. Merges by the run-linked
 * merge manager are recorded only as overseer_actions rows and are not read here.
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

export interface StrayBranchReader {
  /** The PR's head branch name, or undefined when it cannot be read. */
  readPullRequestHeadRef(input: {
    owner: string;
    repo: string;
    number: number;
  }): Promise<string | undefined>;
  readBranch(input: { owner: string; repo: string; branch: string }): Promise<BranchState>;
}

export interface StrayBranchOctokitLike {
  pulls: {
    get(input: Record<string, unknown>): Promise<{ data: { head: { ref?: string } } }>;
  };
  git: {
    getRef(input: Record<string, unknown>): Promise<{ data: { object: { sha: string } } }>;
  };
}

export function createStrayBranchReader(octokit: StrayBranchOctokitLike): StrayBranchReader {
  return {
    async readPullRequestHeadRef(input): Promise<string | undefined> {
      try {
        const pr = await octokit.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
        });
        const ref = pr.data.head.ref;
        return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
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

export interface PostMergeSweepOptions {
  listMerged: (sinceIso: string) => Promise<readonly MergedVerdictForSweep[]>;
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

function strayIdentity(
  verdict: MergedVerdictForSweep,
  pr: { owner: string; repo: string; number: number },
  straySha: string
): ActionableEventIdentity {
  return {
    identity_version: OPERATOR_CARD_IDENTITY_VERSION,
    source_event_id: `post-merge-stray:${pr.owner}/${pr.repo}#${pr.number}:${straySha}`,
    run_id: verdict.run_id,
    wo_id: verdict.wo_id,
    event_type: POST_MERGE_STRAY_EVENT_TYPE,
    step_name: POST_MERGE_STRAY_STEP_NAME,
    event_created_at: new Date(verdict.updated_at).toISOString(),
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
  const merged = await options.listMerged(sinceIso);
  const result: PostMergeSweepResult = {
    examined: merged.length,
    alerted: [],
    alreadyAlerted: 0,
    noStray: 0,
    unreadable: 0,
  };

  for (const verdict of merged) {
    const pr = verdict.pr_url ? parsePullRequestUrl(verdict.pr_url) : null;
    if (!pr || !verdict.head_sha) {
      result.unreadable += 1;
      continue;
    }
    const branch = await options.reader.readPullRequestHeadRef(pr);
    if (!branch) {
      result.unreadable += 1;
      continue;
    }
    const state = await options.reader.readBranch({ owner: pr.owner, repo: pr.repo, branch });
    if (state.state === 'unknown') {
      result.unreadable += 1;
      continue;
    }
    // Gone, or still exactly at the merged head: nothing was pushed after the merge.
    if (state.state === 'gone' || state.sha === verdict.head_sha) {
      result.noStray += 1;
      continue;
    }

    const identity = strayIdentity(verdict, pr, state.sha);
    const cardId = deriveOperatorCardId(identity);
    if (await lookupCard(cardId)) {
      result.alreadyAlerted += 1;
      continue;
    }

    const prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;
    const repository = `${pr.owner}/${pr.repo}`;
    const card: OperatorCardRecord = await escalate(
      verdict.run_id,
      {
        decision: 'escalate',
        reason:
          `post-merge stray push: branch ${branch} of ${prUrl} is at ${state.sha}, ` +
          `not the merged head ${verdict.head_sha}; that work is not on the base branch`,
      },
      {
        errorClass: 'unknown',
        woId: verdict.wo_id,
        repository,
        branch,
        prUrl,
        prNumber: pr.number,
        headSha: state.sha,
        mergeability: 'merged',
        remediation: [
          `Compare ${verdict.head_sha}..${state.sha} on branch ${branch}.`,
          'Open a follow-up PR with the stray commits, or confirm they are disposable.',
        ],
        evidenceLinks: {
          pull_request: prUrl,
          merged_head_sha: verdict.head_sha,
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
      { prUrl, branch, straySha: state.sha, mergedHead: verdict.head_sha, cardId: card.card_id },
      'merge-sweep.stray_push_alert'
    );
    result.alerted.push({ prUrl, branch, straySha: state.sha, cardId: card.card_id });
  }
  return result;
}
