/**
 * already-satisfied.ts -- WO claim / already-landed detection.
 *
 * Anchor: bdc-xo#1546 (four lanes concurrently built the same WO; redundant PRs).
 * Anchor: M-123 Q5 (refuse fire when open/merged PR for WO already exists).
 * Anchor: fire.ps1 already-satisfied gate (human path only -- conductor was blind).
 *
 * Exact WO_ID match only (avoids #1490 false positives on shared prefixes like
 * WO-HARNESS-*-01). Injectable lookup for tests.
 */

import { matchesWoToken } from '@archon/overseer/wo-token';

import { execFile } from 'child_process';
import { promisify } from 'util';
import { isSpecOnlyFileList } from './spec-only-pr.js';

const execFileAsync = promisify(execFile);

export type WoClaimState = 'OPEN' | 'MERGED';

export interface WoClaim {
  readonly number: number;
  readonly state: WoClaimState;
  readonly title: string;
  readonly url: string;
  readonly repo: string;
}

export interface FindWoClaimOptions {
  readonly woId: string;
  readonly project: string;
  /** Override gh lookup (tests). */
  readonly lookup?: (repo: string, woId: string) => Promise<WoClaim[]>;
  readonly execFn?: typeof execFileAsync;
}

/**
 * Map a Smart Cauldron --project shortname to a GitHub owner/repo.
 * Accepts bare shortnames (shopops) or already-qualified names.
 */
export function resolveGithubRepo(project: string): string {
  const trimmed = project.trim();
  if (!trimmed) {
    throw new Error('[smart-cauldron/already-satisfied] project is required');
  }
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/').filter(Boolean);
    const owner = parts[parts.length - 2] ?? 'thinmansoftware';
    const repo = parts[parts.length - 1] ?? trimmed;
    return `${owner}/${repo}`;
  }
  return `thinmansoftware/${trimmed}`;
}

/**
 * Markdown headings that mark following lines as explicitly OUT of scope for
 * the PR that contains them -- a WO id mentioned there is a disclaimer
 * ("I deliberately did not touch this"), not a claim of having done it.
 *
 * Anchor: bdc-xo#1795 -- shopops-comic-theme PR #62
 * (WO-COMICTHEME-CARD-GUARANTEE-SCOPE-FIX-01) listed
 * "comic-card.liquid body/actions block (owned by WO-COMICTHEME-CARD-MODERN-PARITY-01)"
 * under "## Files explicitly out of scope". textClaimsWoId read that mention
 * as a claim and permanently blocked WO-COMICTHEME-CARD-MODERN-PARITY-01 from
 * firing. Mechanism was correct (real match); the inference was wrong
 * (ownership disclaimer, not completion claim).
 */
const EXCLUSION_HEADING_RE =
  /^\s{0,3}#{1,6}\s*(files?\s+)?(explicitly\s+)?(out\s+of\s+scope|not\s+in\s+scope|explicitly\s+excluded)\b/i;
/** Any markdown heading (# through ######) closes an exclusion section. */
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;

/**
 * Strip lines that fall under an "out of scope" / "not in scope" /
 * "explicitly excluded" heading, up to the next heading of any level (or
 * end of text). Applied before the WO-id scan so exclusion-listed mentions
 * never reach the matcher.
 */
function stripExclusionSections(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let inExclusion = false;
  for (const line of lines) {
    if (EXCLUSION_HEADING_RE.test(line)) {
      inExclusion = true;
      continue;
    }
    if (inExclusion && ANY_HEADING_RE.test(line)) {
      inExclusion = false;
    }
    if (!inExclusion) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * True when text contains the exact WO_ID as a token (not a longer sibling id),
 * OUTSIDE any "explicitly out of scope" section. "WO-FOO-01" must not match
 * "WO-FOO-010". The engine branch suffix "-thread-<id>" after the id is a
 * boundary; any other hyphen continuation names a longer id (matchesWoToken).
 * Case-insensitive.
 */
export function textClaimsWoId(text: string, woId: string): boolean {
  return matchesWoToken(stripExclusionSections(text), woId);
}

interface GhPrRow {
  number?: number;
  state?: string;
  title?: string;
  url?: string;
  headRefName?: string;
  body?: string;
}

export async function ghPrSearchDefault(
  repo: string,
  woId: string,
  execFn: typeof execFileAsync = execFileAsync
): Promise<WoClaim[]> {
  if (process.env.SMART_CAULDRON_HERMETIC === '1') {
    console.log('[smart-cauldron/already-satisfied] skipping GitHub search in hermetic mode');
    return [];
  }
  try {
    const { stdout } = await execFn(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--search',
        woId,
        '--limit',
        '20',
        '--json',
        'number,state,title,url,headRefName,body',
      ],
      { timeout: 30000 }
    );
    const rows = JSON.parse(stdout || '[]') as GhPrRow[];
    if (!Array.isArray(rows)) return [];
    const out: WoClaim[] = [];
    for (const row of rows) {
      const stateRaw = (row.state ?? '').toUpperCase();
      if (stateRaw !== 'OPEN' && stateRaw !== 'MERGED') continue;
      const number = typeof row.number === 'number' ? row.number : NaN;
      if (!Number.isFinite(number)) continue;
      const title = row.title ?? '';
      const body = row.body ?? '';
      const head = row.headRefName ?? '';
      const url = row.url ?? '';
      if (
        !textClaimsWoId(title, woId) &&
        !textClaimsWoId(body, woId) &&
        !textClaimsWoId(head, woId)
      ) {
        continue;
      }
      out.push({
        number,
        state: stateRaw as WoClaimState,
        title,
        url,
        repo,
      });
    }
    return out;
  } catch {
    // Fail open on gh outage -- cascade must not die because GitHub search blipped.
    // Callers treat null/empty as "unknown, proceed" and rely on other gates.
    return [];
  }
}

async function isSpecOnlyClaim(
  repo: string,
  number: number,
  woId: string,
  execFn: typeof execFileAsync = execFileAsync
): Promise<boolean> {
  if (process.env.SMART_CAULDRON_HERMETIC === '1') return false;
  try {
    const { stdout } = await execFn(
      'gh',
      ['api', `repos/${repo}/pulls/${String(number)}/files?per_page=100`, '--paginate', '--slurp'],
      { timeout: 30000 }
    );
    const pages: unknown = JSON.parse(stdout);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) return false;
    return isSpecOnlyFileList(woId, pages.flat());
  } catch {
    // An unreadable or malformed file list cannot disprove an existing claim.
    return false;
  }
}

/**
 * Find an open or merged PR that already claims this WO in the target repo.
 * Spec-only PRs are not build claims. Returns the strongest remaining claim
 * (MERGED preferred over OPEN), or null.
 */
export async function findWoClaim(opts: FindWoClaimOptions): Promise<WoClaim | null> {
  const repo = resolveGithubRepo(opts.project);
  const lookup =
    opts.lookup ??
    ((target: string, woId: string): Promise<WoClaim[]> =>
      ghPrSearchDefault(target, woId, opts.execFn));
  const claims = await lookup(repo, opts.woId);
  const remaining: WoClaim[] = [];
  for (const claim of claims) {
    if (!(await isSpecOnlyClaim(repo, claim.number, opts.woId, opts.execFn))) remaining.push(claim);
  }
  const merged = remaining.find(c => c.state === 'MERGED');
  if (merged) return merged;
  return remaining[0] ?? null;
}

/**
 * One-line manifest declaration. A value token-matches via textClaimsWoId.
 */
const WO_DECLARATION_LINE = /^WO[ \t]*:[ \t]*(\S.*)$/i;

const OPEN_PR_PAGE_SIZE = 100;
const OPEN_PR_MAX_PAGES = 10;

/** OPEN pull request in the target repo that claims a WO. Forks are excluded. */
export interface OpenWoPullRequest {
  readonly number: number;
  readonly headRefName: string;
  readonly headSha: string;
  readonly url: string;
  readonly createdAt: string;
  readonly isDraft: boolean;
  readonly isFork: boolean;
  readonly body: string;
}

interface GhOpenPullRow {
  number?: number;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  created_at?: string;
  head?: {
    ref?: string;
    sha?: string;
    repo?: { full_name?: string | null } | null;
  } | null;
}

export interface ListOpenWoPullRequestsOptions {
  readonly woId: string;
  readonly project: string;
  /**
   * Head branches of earlier runs for this WO (run metadata.head_branch). A PR on
   * one of them claims the WO even with no `WO:` line or WO token in its branch:
   * implement-agent PRs often carry neither (bdc-harness #1476, 2026-11-04).
   */
  readonly headBranches?: readonly string[];
  /**
   * Throw on a lookup error instead of failing open to []. A climb must tell
   * "no open PR" from "could not look" (bdc-xo #4638); the first-attempt guard
   * keeps failing open.
   */
  readonly failOnError?: boolean;
  /** Override the paginated open-PR read (tests). */
  readonly lookup?: (repo: string) => Promise<GhOpenPullRow[]>;
  readonly execFn?: typeof execFileAsync;
}

function bodyLineClaimsWo(body: string, woId: string): boolean {
  for (const raw of body.split('\n')) {
    const match = WO_DECLARATION_LINE.exec(raw.trim());
    const value = match?.[1];
    if (value && textClaimsWoId(value, woId)) return true;
  }
  return false;
}

function toOpenWoPullRequest(
  row: GhOpenPullRow,
  targetRepo: string,
  woId: string,
  headBranches: ReadonlySet<string> = new Set()
): OpenWoPullRequest | null {
  if (row.draft === true) return null;
  const fullName = row.head?.repo?.full_name;
  if (typeof fullName !== 'string' || fullName.length === 0) return null;
  if (fullName.toLowerCase() !== targetRepo.toLowerCase()) return null;
  const number = row.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const headRefName = typeof row.head?.ref === 'string' ? row.head.ref : '';
  const body = typeof row.body === 'string' ? row.body : '';
  const branchClaims = matchesWoToken(headRefName, woId) || headBranches.has(headRefName);
  if (!branchClaims && !bodyLineClaimsWo(body, woId)) return null;
  return {
    number,
    headRefName,
    headSha: typeof row.head?.sha === 'string' ? row.head.sha : '',
    url: typeof row.html_url === 'string' ? row.html_url : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    isDraft: false,
    isFork: false,
    body,
  };
}

/**
 * Paginated open-PR listing. Fails open to [] on throw, timeout, a non-array
 * page, or SMART_CAULDRON_HERMETIC=1 (hermetic mode makes no GitHub call).
 * A full page at the cap returns the pages already read.
 */
async function ghListOpenPullRequestsDefault(
  repo: string,
  execFn: typeof execFileAsync = execFileAsync,
  failOnError = false
): Promise<GhOpenPullRow[]> {
  if (process.env.SMART_CAULDRON_HERMETIC === '1') {
    console.log('[smart-cauldron/already-satisfied] skipping open-PR list in hermetic mode');
    return [];
  }
  try {
    const out: GhOpenPullRow[] = [];
    for (let page = 1; page <= OPEN_PR_MAX_PAGES; page++) {
      const { stdout } = await execFn(
        'gh',
        [
          'api',
          '--method',
          'GET',
          '-H',
          'Accept: application/vnd.github+json',
          `repos/${repo}/pulls?state=open&per_page=${String(OPEN_PR_PAGE_SIZE)}&page=${String(page)}`,
        ],
        { timeout: 30000 }
      );
      const parsed: unknown = JSON.parse(stdout || '[]');
      if (!Array.isArray(parsed)) {
        if (failOnError) throw new Error('open_pr_list_not_an_array');
        return [];
      }
      out.push(...(parsed as GhOpenPullRow[]));
      if (parsed.length < OPEN_PR_PAGE_SIZE) return out;
    }
    return out;
  } catch (error) {
    if (failOnError) throw error;
    return [];
  }
}

/**
 * OPEN, non-fork PRs in the target repo whose body has a WO: line token-matching
 * woId, or whose head branch token-matches woId (matchesWoToken). Drafts excluded.
 * Head repositories that cannot be verified, and forks, are excluded.
 */
export async function listOpenWoPullRequests(
  opts: ListOpenWoPullRequestsOptions
): Promise<OpenWoPullRequest[]> {
  if (!opts.woId) return [];
  const failOnError = opts.failOnError === true;
  let repo: string;
  try {
    repo = resolveGithubRepo(opts.project);
  } catch (error) {
    if (failOnError) throw error;
    return [];
  }
  const lookup =
    opts.lookup ??
    ((target: string): Promise<GhOpenPullRow[]> =>
      ghListOpenPullRequestsDefault(target, opts.execFn, failOnError));
  let rows: GhOpenPullRow[];
  try {
    rows = await lookup(repo);
  } catch (error) {
    if (failOnError) throw error;
    return [];
  }
  if (!Array.isArray(rows)) {
    if (failOnError) throw new Error('open_pr_list_not_an_array');
    return [];
  }
  const headBranches = new Set(
    (opts.headBranches ?? []).filter(branch => typeof branch === 'string' && branch.length > 0)
  );
  const matched: OpenWoPullRequest[] = [];
  for (const row of rows) {
    const candidate = toOpenWoPullRequest(row, repo, opts.woId, headBranches);
    if (candidate) matched.push(candidate);
  }
  return matched;
}
