/**
 * conflict-only.ts -- a completed run whose ONLY failing gate condition is that its pull request
 * cannot be merged does not climb (WO-HARNESS-CONFLICT-ONLY-GATE-NO-TIER-CLIMB-01, bdc-xo#5658).
 *
 * Run 17b2d1c3 completed cleanly on 2026-11-12 (PR 106 opened); 21 seconds later the conductor started
 * a codex rung for the same work order because PR 106 conflicted with a main that had moved during the
 * 81-minute run. A merge conflict is mechanical, so the cascade first tries ONE update of the branch
 * from its base (GitHub's update-branch: a merge commit, never a rebase or a force push). A clean
 * update means the normal checks and review run on the new head and nothing is escalated; a conflict
 * means one comment on the pull request naming the files changed on both sides, and the cascade
 * stops. Either way no higher rung is fired.
 *
 * Every step fails toward doing less: an unreadable pull request, a refused update or a failed
 * comment never starts a climb and never claims a conflict that was not observed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertGitHubPoolAvailable, recordGitHubApiCall } from '@archon/core/github/metering';
import { COVERED_PRODUCTION_BASES } from '@archon/overseer/m09-promotion-gate';
import { smartCauldronGhEnv } from './poll.js';

const execFileAsync = promisify(execFile);

export interface ConflictOnlyDeps {
  /** Run `gh <args>`; rejects on a non-zero exit with the CLI's stderr in `stderr` or `message`. */
  gh(args: readonly string[]): Promise<{ stdout: string }>;
  /** True when `baseRef` of `owner/repo` is a covered production base (M-09). */
  isCoveredProductionBase(ownerRepo: string, baseRef: string): boolean;
}

export type ConflictOnlyOutcome = 'updated' | 'conflict_only';

export interface ConflictOnlyResult {
  outcome: ConflictOnlyOutcome;
  prUrl: string;
  headSha: string | null;
  baseRef: string | null;
  /** HTTP status of the update-branch call; null when it was not attempted. */
  updateStatus: number | null;
  /** Files changed on both sides since the merge base (the likely conflict set); empty when unknown. */
  files: string[];
  /** True when this call posted the explanatory comment. */
  commented: boolean;
  /** True when the comment for this head already existed (nothing was done again). */
  alreadyRecorded: boolean;
  note: string;
}

const PR_URL_PATTERN = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i;
const HTTP_STATUS_PATTERN = /HTTP (\d{3})/;

export function conflictMarker(headSha: string): string {
  return `<!-- conflict-only:${headSha} -->`;
}

function httpStatusOf(error: unknown): number | null {
  const err = error as { stderr?: string; message?: string };
  const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
  const match = HTTP_STATUS_PATTERN.exec(text);
  return match ? Number(match[1]) : null;
}

function describeUpdate(status: number | null, baseRef: string | null, covered: boolean): string {
  if (covered) {
    return `Branch update: not attempted (${baseRef ?? 'the base'} is a covered production base; the update is left to a person).`;
  }
  if (status === 422) {
    return `Branch update: tried to merge ${baseRef ?? 'the base'} into this branch and it conflicts (HTTP 422).`;
  }
  if (status === null) {
    return 'Branch update: could not be attempted (no HTTP status was returned).';
  }
  return `Branch update: not done (HTTP ${String(status)}; the conductor may not be allowed to push to this branch). No conflict was observed by this call.`;
}

async function likelyConflictFiles(
  deps: ConflictOnlyDeps,
  owner: string,
  repo: string,
  number: number,
  baseRef: string,
  headSha: string
): Promise<string[]> {
  try {
    const forkPoint = (
      await deps.gh([
        'api',
        `repos/${owner}/${repo}/compare/${baseRef}...${headSha}`,
        '--jq',
        '.merge_base_commit.sha',
      ])
    ).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(forkPoint)) return [];
    const onBase = (
      await deps.gh([
        'api',
        `repos/${owner}/${repo}/compare/${forkPoint}...${baseRef}`,
        '--jq',
        '.files[].filename',
      ])
    ).stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const onPr = new Set(
      (
        await deps.gh([
          'api',
          '--paginate',
          `repos/${owner}/${repo}/pulls/${String(number)}/files`,
          '--jq',
          '.[].filename',
        ])
      ).stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    );
    return [...new Set(onBase.filter(file => onPr.has(file)))].sort();
  } catch {
    return [];
  }
}

function buildComment(input: {
  headSha: string;
  baseRef: string;
  updateLine: string;
  files: string[];
}): string {
  const fileLines =
    input.files.length > 0
      ? input.files.map(file => `- ${file}`).join('\n')
      : '(could not be computed, or no file was changed on both sides)';
  return [
    conflictMarker(input.headSha),
    `conflict_only: the run that opened this pull request completed and no reviewer rejected it, but it cannot be merged into \`${input.baseRef}\`. That is the only reason the gate failed, so **no higher rung was started**.`,
    '',
    input.updateLine,
    '',
    "Files changed on both sides since the merge base (the likely conflict set, not git's exact list):",
    fileLines,
    '',
    `Merge \`${input.baseRef}\` into this branch by hand and resolve the conflicts, or close this pull request if it is superseded.`,
  ].join('\n');
}

/**
 * Handle one conflict-only gate verdict. Never throws for a GitHub failure: the worst outcome is
 * `conflict_only` with no comment and a note saying what could not be done.
 */
export async function handleConflictOnly(
  prUrl: string,
  deps: ConflictOnlyDeps
): Promise<ConflictOnlyResult> {
  const base: ConflictOnlyResult = {
    outcome: 'conflict_only',
    prUrl,
    headSha: null,
    baseRef: null,
    updateStatus: null,
    files: [],
    commented: false,
    alreadyRecorded: false,
    note: '',
  };
  const parsed = PR_URL_PATTERN.exec(prUrl);
  if (!parsed)
    return { ...base, note: 'the pull request URL could not be parsed; nothing was attempted' };
  const [, owner, repo, numberText] = parsed as unknown as [string, string, string, string];
  const number = Number(numberText);
  const ownerRepo = `${owner}/${repo}`;

  let headSha: string;
  let baseRef: string;
  let comments: { body?: string }[];
  try {
    const view = JSON.parse(
      (
        await deps.gh([
          'pr',
          'view',
          String(number),
          '--repo',
          ownerRepo,
          '--json',
          'headRefOid,baseRefName,comments',
        ])
      ).stdout
    ) as { headRefOid?: string; baseRefName?: string; comments?: { body?: string }[] };
    if (!view.headRefOid || !view.baseRefName) throw new Error('missing head or base');
    headSha = view.headRefOid;
    baseRef = view.baseRefName;
    comments = view.comments ?? [];
  } catch (error) {
    return {
      ...base,
      note: `the pull request could not be read (${(error as Error).message}); nothing was attempted`,
    };
  }

  const marker = conflictMarker(headSha);
  if (comments.some(comment => (comment.body ?? '').includes(marker))) {
    return {
      ...base,
      headSha,
      baseRef,
      alreadyRecorded: true,
      note: 'conflict_only was already recorded for this head; nothing was done again',
    };
  }

  const covered = deps.isCoveredProductionBase(ownerRepo, baseRef);
  let updateStatus: number | null = null;
  if (!covered) {
    try {
      await deps.gh([
        'api',
        '-X',
        'PUT',
        `repos/${ownerRepo}/pulls/${String(number)}/update-branch`,
        '-f',
        `expected_head_sha=${headSha}`,
      ]);
      return {
        ...base,
        outcome: 'updated',
        headSha,
        baseRef,
        updateStatus: 202,
        note: `merged ${baseRef} into the branch; the new head is checked and reviewed by the normal path`,
      };
    } catch (error) {
      updateStatus = httpStatusOf(error);
    }
  }

  const files = await likelyConflictFiles(deps, owner, repo, number, baseRef, headSha);
  const updateLine = describeUpdate(updateStatus, baseRef, covered);
  let commented = false;
  try {
    await deps.gh([
      'api',
      '-X',
      'POST',
      `repos/${ownerRepo}/issues/${String(number)}/comments`,
      '-f',
      `body=${buildComment({ headSha, baseRef, updateLine, files })}`,
    ]);
    commented = true;
  } catch {
    commented = false;
  }
  return {
    ...base,
    headSha,
    baseRef,
    updateStatus,
    files,
    commented,
    note: commented ? updateLine : `${updateLine} The explanatory comment could not be posted.`,
  };
}

/** The real dependencies: `gh` through the smart-cauldron GitHub identity, metered. */
export function createGhConflictOnlyDeps(): ConflictOnlyDeps {
  return {
    gh: async (args): Promise<{ stdout: string }> => {
      const auth = await smartCauldronGhEnv();
      assertGitHubPoolAvailable(auth.poolId, 'core');
      const { stdout } = await execFileAsync('gh', [...args], { env: auth.env });
      recordGitHubApiCall({
        service: 'smart_cauldron',
        poolId: auth.poolId,
        resource: 'core',
        status: 0,
        endpoint: `cli:gh ${args[0] ?? ''}`,
      });
      return { stdout };
    },
    isCoveredProductionBase: (ownerRepo, baseRef): boolean =>
      (COVERED_PRODUCTION_BASES[ownerRepo.toLowerCase()] ?? []).includes(baseRef),
  };
}
