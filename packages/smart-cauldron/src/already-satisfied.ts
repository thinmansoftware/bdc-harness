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

import { execFile } from 'child_process';
import { promisify } from 'util';

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
 * "WO-FOO-010". Branch suffixes like "-thread-abc" after the id are allowed
 * (hyphen is a boundary). Case-insensitive.
 */
export function textClaimsWoId(text: string, woId: string): boolean {
  if (!woId || !text) return false;
  const hay = stripExclusionSections(text).toLowerCase();
  const needle = woId.toLowerCase();
  let from = 0;
  while (from <= hay.length) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const afterIdx = idx + needle.length;
    const after = afterIdx >= hay.length ? '' : hay[afterIdx];
    const beforeOk = idx === 0 || /[^a-z0-9]/.test(before);
    const afterOk = after === '' || /[^a-z0-9]/.test(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

export class ClaimDiscoveryError extends Error {
  constructor(readonly code: 'request_failed' | 'invalid_response' | 'invalid_repository') {
    super(`claim_discovery_${code}`);
    this.name = 'ClaimDiscoveryError';
  }
}

export async function ghPrSearchDefault(
  repo: string,
  woId: string,
  execFn: (
    command: string,
    args: string[],
    options: { timeout: number; maxBuffer: number }
  ) => Promise<{ stdout: string; stderr: string }> = execFileAsync
): Promise<WoClaim[]> {
  if (process.env.SMART_CAULDRON_HERMETIC === '1') {
    console.log('[smart-cauldron/already-satisfied] skipping GitHub discovery in hermetic mode');
    return [];
  }
  const safeRepo = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
  if (safeRepo.exec(repo)?.[0] !== repo) throw new ClaimDiscoveryError('invalid_repository');
  let stdout: string;
  try {
    ({ stdout } = await execFn(
      'gh',
      [
        'api',
        `repos/${repo}/pulls?state=all&per_page=100&sort=created&direction=asc`,
        '--paginate',
        '--slurp',
      ],
      // Complete PR histories include bodies; keep a finite bound without the
      // default execFile buffer truncating ordinary multi-page repositories.
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }
    ));
  } catch {
    // Do not expose provider diagnostics or interpret failed pagination as absence.
    throw new ClaimDiscoveryError('request_failed');
  }
  try {
    const pages: unknown = JSON.parse(stdout);
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('missing pages');
    const out: WoClaim[] = [];
    const seen = new Map<number, string>();
    for (const page of pages) {
      if (!Array.isArray(page)) throw new Error('invalid page');
      for (const value of page) {
        if (!value || typeof value !== 'object') throw new Error('invalid row');
        const row = value as Record<string, unknown>;
        const head = row.head as Record<string, unknown> | null;
        if (
          typeof row.number !== 'number' ||
          !Number.isSafeInteger(row.number) ||
          row.number <= 0 ||
          (row.state !== 'open' && row.state !== 'closed') ||
          typeof row.title !== 'string' ||
          (row.body !== null && typeof row.body !== 'string') ||
          !head ||
          typeof head.ref !== 'string' ||
          !head.ref ||
          typeof row.html_url !== 'string' ||
          !row.html_url ||
          (row.merged_at !== null &&
            (typeof row.merged_at !== 'string' ||
              !Number.isFinite(Date.parse(row.merged_at)) ||
              row.state !== 'closed'))
        ) {
          throw new Error('invalid row');
        }
        const { number, title, html_url: url } = row;
        const body = row.body ?? '';
        const fingerprint = JSON.stringify([row.state, row.merged_at, title, body, head.ref, url]);
        const prior = seen.get(number);
        if (prior !== undefined) {
          if (prior !== fingerprint) throw new Error('conflicting page overlap');
          continue;
        }
        seen.set(number, fingerprint);
        // Validate every row before deciding whether it is a relevant claim.
        if (row.state === 'closed' && row.merged_at === null) continue;
        if (
          !textClaimsWoId(title, woId) &&
          !textClaimsWoId(body, woId) &&
          !textClaimsWoId(head.ref, woId)
        ) {
          continue;
        }
        out.push({ number, state: row.merged_at === null ? 'OPEN' : 'MERGED', title, url, repo });
      }
    }
    return out;
  } catch {
    throw new ClaimDiscoveryError('invalid_response');
  }
}

/**
 * Find an open or merged PR that already claims this WO in the target repo.
 * Returns the strongest claim (MERGED preferred over OPEN), or null.
 */
export async function findWoClaim(opts: FindWoClaimOptions): Promise<WoClaim | null> {
  const repo = resolveGithubRepo(opts.project);
  const lookup = opts.lookup ?? ghPrSearchDefault;
  const claims = await lookup(repo, opts.woId);
  if (claims.length === 0) return null;
  const merged = claims.find(c => c.state === 'MERGED');
  if (merged) return merged;
  return claims[0] ?? null;
}
