/**
 * open-pr-guard.ts -- the conductor guard that stops the ladder from climbing a
 * NEW tier while an open PR for the same WO already exists.
 *
 * WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01.
 *
 * WHY THIS EXISTS. The -AllowSatisfied override (bdc-xo fire.ps1) sets
 * SMART_CAULDRON_ALLOW_CLAIMED=1 so the cascade can fire a bdc-xo WO whose
 * merged spec PR (branch wo/<id>) would otherwise read as already-satisfied.
 * But that one flag ALSO disables the climb guard, so the ladder climbed over
 * an OPEN lane PR and burned tier after tier (bdc-xo#3167: one WO reached three
 * open CHANGES_REQUESTED PRs). And already-satisfied's gh search uses the
 * GitHub search index, which LAGS (bdc-xo#1412: a tier fired 49s after a PR
 * existed), so even without the override a fresh PR can be invisible.
 *
 * THE FIX. findBlockingOpenPrs unions two blind spots:
 *   (i)  GitHub search OPEN results that textClaimsWoId -- the normal case; and
 *   (ii) PRs the lane-pr-registry attributes to THIS cascade's own attempt run
 *        ids, re-read by number through the REST pull endpoint (NOT search, so
 *        the index lag cannot hide them) and kept only if still OPEN.
 * It always drops the author-wo.sh spec PR (head wo/<woId>) and an explicit
 * excludePrNumber (the repair target itself). Unlike already-satisfied's
 * fail-OPEN gh search, this guard FAILS CLOSED: on a lookup error it retries
 * once after a delay and then THROWS, so the cascade refuses the climb rather
 * than climbing blind over a PR it could not read. It runs whether or not
 * allowClaimed is set.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveGithubRepo, textClaimsWoId } from './already-satisfied.js';
import {
  listLanePrsForWo,
  type LanePrFetcher,
  type LanePrGithubInfo,
  type LanePrState,
} from '@archon/core/db/lane-pr-registry';

const execFileAsync = promisify(execFile);

/** A PR that must stop the ladder from climbing a new tier. */
export interface BlockingOpenPr {
  owner: string;
  repo: string;
  prNumber: number;
  headRef: string;
  prUrl: string;
}

/** One OPEN PR candidate from GitHub search. */
export interface OpenPrSearchRow {
  owner: string;
  repo: string;
  prNumber: number;
  state: string;
  headRef: string;
  url: string;
  title: string;
  body: string;
}

/** The live REST re-read of one PR by number (not via the lagging search index). */
export interface ReadPrState {
  state: string;
  headRef: string;
  url: string;
}

/**
 * The three reads findBlockingOpenPrs needs. Injected so the cascade tests run
 * with no network. Any call may throw; the guard retries the whole computation
 * once and then propagates (fail-closed).
 */
export interface OpenPrGuardLookup {
  /** GitHub search for PRs mentioning the WO (state included so OPEN can be kept). */
  searchOpenPrs(repo: string, woId: string): Promise<OpenPrSearchRow[]>;
  /** PRs the lane-pr-registry attributes to any of this cascade's attempt run ids. */
  registryAttributedPrs(input: {
    woId: string;
    attemptRunIds: string[];
  }): Promise<{ owner: string; repo: string; prNumber: number }[]>;
  /** Re-read one PR by number through the REST pull endpoint (not search). */
  readPr(input: { owner: string; repo: string; prNumber: number }): Promise<ReadPrState | null>;
}

export interface FindBlockingOpenPrsInput {
  woId: string;
  project: string;
  attemptRunIds: string[];
  /** The repair target PR, excluded so a repair never refuses on itself. */
  excludePrNumber?: number;
  lookup: OpenPrGuardLookup;
  /** Retry delay after the first lookup failure. Default 5000ms; tests pass 0. */
  retryDelayMs?: number;
  /** Sleep seam (tests). */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function computeBlocking(input: FindBlockingOpenPrsInput): Promise<BlockingOpenPr[]> {
  const repo = resolveGithubRepo(input.project);
  const specHead = `wo/${input.woId.toLowerCase()}`;
  const found = new Map<string, BlockingOpenPr>();

  const consider = (
    owner: string,
    repoFull: string,
    prNumber: number,
    headRef: string,
    url: string
  ): void => {
    if (input.excludePrNumber !== undefined && prNumber === input.excludePrNumber) return;
    if ((headRef ?? '').toLowerCase() === specHead) return;
    const key = `${owner.toLowerCase()}/${repoFull.toLowerCase()}#${prNumber}`;
    if (!found.has(key)) found.set(key, { owner, repo: repoFull, prNumber, headRef, prUrl: url });
  };

  // (i) GitHub search: OPEN rows that actually claim the WO.
  const rows = await input.lookup.searchOpenPrs(repo, input.woId);
  for (const row of rows) {
    if ((row.state ?? '').toUpperCase() !== 'OPEN') continue;
    if (
      !textClaimsWoId(row.title, input.woId) &&
      !textClaimsWoId(row.body, input.woId) &&
      !textClaimsWoId(row.headRef, input.woId)
    ) {
      continue;
    }
    consider(row.owner, row.repo, row.prNumber, row.headRef, row.url);
  }

  // (ii) Registry-attributed PRs, re-read live by number; keep only OPEN.
  const attributed = await input.lookup.registryAttributedPrs({
    woId: input.woId,
    attemptRunIds: input.attemptRunIds,
  });
  for (const pr of attributed) {
    const live = await input.lookup.readPr({
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.prNumber,
    });
    if (!live) continue;
    if ((live.state ?? '').toUpperCase() !== 'OPEN') continue;
    consider(pr.owner, pr.repo, pr.prNumber, live.headRef, live.url);
  }

  return [...found.values()];
}

/**
 * Open PRs that must block a climb for this WO. Fail-closed: on a lookup error,
 * retry the whole computation ONCE after retryDelayMs, then propagate the
 * second error to the caller (the cascade maps it to open-pr-lookup-failed).
 */
export async function findBlockingOpenPrs(
  input: FindBlockingOpenPrsInput
): Promise<BlockingOpenPr[]> {
  const sleep = input.sleep ?? defaultSleep;
  const retryDelayMs = input.retryDelayMs ?? 5000;
  try {
    return await computeBlocking(input);
  } catch {
    await sleep(retryDelayMs);
    // A second throw here propagates on purpose -- do NOT swallow it.
    return await computeBlocking(input);
  }
}

// ---------------------------------------------------------------------------
// Production lookup wiring (gh CLI search + REST, lane-pr-registry attribution)
// ---------------------------------------------------------------------------

interface GhSearchRow {
  number?: number;
  state?: string;
  title?: string;
  url?: string;
  headRefName?: string;
  body?: string;
}

function validPrState(value: unknown): value is LanePrState {
  return value === 'OPEN' || value === 'CLOSED' || value === 'MERGED';
}

function canonicalPrUrl(value: unknown, repo: string, number: number): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.toLowerCase() === `/${repo}/pull/${number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Build the real lookup. Uses gh for the OPEN search and the per-number REST
 * re-read, and lane-pr-registry for attribution. The GitHub PR fetcher the
 * registry needs is injected so the same gh binding serves both halves.
 */
export function createDefaultOpenPrGuardLookup(
  fetchPr: LanePrFetcher,
  execFn: typeof execFileAsync = execFileAsync
): OpenPrGuardLookup {
  return {
    async searchOpenPrs(repo, woId): Promise<OpenPrSearchRow[]> {
      const { stdout } = await execFn(
        'gh',
        [
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'open',
          '--search',
          woId,
          '--limit',
          '50',
          '--json',
          'number,state,title,url,headRefName,body',
        ],
        { timeout: 30000 }
      );
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error('open_pr_lookup_invalid');
      const slash = repo.indexOf('/');
      const owner = slash === -1 ? repo : repo.slice(0, slash);
      const shortRepo = slash === -1 ? repo : repo.slice(slash + 1);
      const out: OpenPrSearchRow[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('open_pr_lookup_invalid');
        const row = entry as GhSearchRow;
        if (
          typeof row.number !== 'number' ||
          !Number.isSafeInteger(row.number) ||
          row.number <= 0 ||
          !validPrState(row.state) ||
          typeof row.headRefName !== 'string' ||
          !row.headRefName.trim() ||
          typeof row.title !== 'string' ||
          !row.title.trim() ||
          (typeof row.body !== 'string' && row.body !== null) ||
          !canonicalPrUrl(row.url, repo, row.number)
        )
          throw new Error('open_pr_lookup_invalid');
        out.push({
          owner,
          repo: shortRepo,
          prNumber: row.number,
          state: row.state,
          headRef: row.headRefName,
          url: row.url,
          title: row.title,
          body: row.body ?? '',
        });
      }
      return out;
    },
    async registryAttributedPrs({
      woId,
      attemptRunIds,
    }): Promise<{ owner: string; repo: string; prNumber: number }[]> {
      if (attemptRunIds.length === 0) return [];
      const lanePrs = await listLanePrsForWo(woId, { fetchPr });
      const runIds = new Set(attemptRunIds);
      return lanePrs
        .filter(pr => runIds.has(pr.runId))
        .map(pr => ({ owner: pr.owner, repo: pr.repo, prNumber: pr.prNumber }));
    },
    async readPr({ owner, repo, prNumber }): Promise<ReadPrState | null> {
      const { stdout } = await execFn(
        'gh',
        [
          'pr',
          'view',
          String(prNumber),
          '--repo',
          `${owner}/${repo}`,
          '--json',
          'number,state,headRefName,url',
        ],
        { timeout: 30000 }
      );
      const parsed = JSON.parse(stdout) as {
        number?: number;
        state?: string;
        headRefName?: string;
        url?: string;
      };
      if (
        !parsed ||
        Array.isArray(parsed) ||
        parsed.number !== prNumber ||
        !validPrState(parsed.state) ||
        typeof parsed.headRefName !== 'string' ||
        !parsed.headRefName.trim() ||
        !canonicalPrUrl(parsed.url, `${owner}/${repo}`, prNumber)
      )
        throw new Error('open_pr_lookup_invalid');
      return { state: parsed.state, headRef: parsed.headRefName, url: parsed.url };
    },
  };
}

interface GhPrViewRow {
  number?: number;
  state?: string;
  reviewDecision?: string | null;
  createdAt?: string;
  headRefName?: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  title?: string;
  body?: string;
  url?: string;
}

/**
 * A lane-pr-registry GitHub fetcher backed by `gh pr view`. Reads only the
 * fields the LANE PR RULE needs. Fork detection uses isCrossRepository: a
 * cross-repo head is reported with a distinct headRepoFullName so rule (c)
 * drops it. Returns null when the PR cannot be read.
 */
export function createGhLanePrFetcher(execFn: typeof execFileAsync = execFileAsync): LanePrFetcher {
  return async (owner, repo, prNumber): Promise<LanePrGithubInfo | null> => {
    const { stdout } = await execFn(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'number,state,reviewDecision,createdAt,headRefName,headRefOid,isCrossRepository,title,body,url',
      ],
      { timeout: 30000 }
    );
    const row = JSON.parse(stdout) as GhPrViewRow;
    if (
      !row ||
      Array.isArray(row) ||
      row.number !== prNumber ||
      !canonicalPrUrl(row.url, `${owner}/${repo}`, prNumber) ||
      typeof row.isCrossRepository !== 'boolean' ||
      !validPrState(row.state) ||
      typeof row.headRefOid !== 'string' ||
      !/^[a-f0-9]{40}$/i.test(row.headRefOid) ||
      typeof row.headRefName !== 'string' ||
      !row.headRefName.trim() ||
      typeof row.title !== 'string' ||
      !row.title.trim() ||
      (typeof row.body !== 'string' && row.body !== null) ||
      typeof row.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      (row.reviewDecision !== null &&
        row.reviewDecision !== '' &&
        !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(row.reviewDecision ?? ''))
    )
      throw new Error('lane_pr_lookup_invalid');
    const stateRaw = (row.state ?? '').toUpperCase();
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(stateRaw)) throw new Error('lane_pr_lookup_invalid');
    const state: LanePrState =
      stateRaw === 'MERGED' ? 'MERGED' : stateRaw === 'CLOSED' ? 'CLOSED' : 'OPEN';
    const baseRepoFullName = `${owner}/${repo}`;
    return {
      number: row.number,
      state,
      // Empty review metadata is absence of approval, never a positive ruling.
      reviewDecision: row.reviewDecision === '' ? null : (row.reviewDecision ?? null),
      createdAt: row.createdAt ?? '',
      headRefName: row.headRefName ?? '',
      headSha: row.headRefOid ?? '',
      headRepoFullName: row.isCrossRepository ? `fork:${baseRepoFullName}` : baseRepoFullName,
      baseRepoFullName,
      title: row.title ?? '',
      body: row.body ?? '',
    };
  };
}
