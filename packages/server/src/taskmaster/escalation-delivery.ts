/**
 * Taskmaster escalation delivery (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01).
 *
 * When Taskmaster escalates a stuck P0 whose thread carries a
 * `gh:owner/repo#N` reference, the escalation is delivered as a comment ON THE
 * GITHUB ISSUE it is about -- where the owner and the Duty Officer actually look
 * -- instead of the operator dispatch mailbox (a drain_on_start principal with
 * no human reader). This mirrors the Duty Officer clock's marker-based
 * GitHub-comment nudge (packages/server/src/dispatch/duty-officer-clock.ts).
 *
 * DEDUPE CHOICE (spec: "Document the choice"). The spec defers the
 * "last non-Taskmaster activity vs. 72h cooldown" decision to the builder,
 * requiring only that it be deterministic. This module uses a 72h COOLDOWN
 * keyed to the escalation's OWN most-recent marker comment `created_at`:
 *   - Computing "the issue's last non-Taskmaster activity" would require the
 *     same events+comments fetch already paid for by the adoption evidence
 *     refresh, adding GitHub API load that competes with the per-tick
 *     rate-limit budget.
 *   - A cooldown against the marker comment is cheap (a comments listing
 *     narrowed by `since` to the cooldown window, normally one page, and
 *     paginated to the end so a marker past comment #100 is never missed),
 *     fully deterministic, and satisfies stop condition 4 (3 ticks with no new
 *     activity => exactly one marker comment survives) for any realistic tick
 *     interval, because the second and third ticks land well inside 72h of the
 *     first tick's comment.
 * Re-escalation therefore happens only after 72h has elapsed since the last
 * Taskmaster escalation comment on that issue.
 */
import { createLogger } from '@archon/paths';
import type { IDatabase } from '@archon/core/db/adapters/types';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import { githubToken } from '../dispatch/duty-officer-clock';

const log = createLogger('taskmaster/escalation-delivery');

/** Hidden marker that identifies a Taskmaster escalation comment on an issue. */
export const TASKMASTER_ESCALATION_MARKER = '<!-- taskmaster-escalation -->';

/** Re-escalate only after this long since the last marker comment. */
export const TASKMASTER_ESCALATION_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/**
 * Matches a canonical GitHub thread ref `gh:owner/repo#N`, splitting owner and
 * repo separately (loop.ts's existing parseGhRef returns a combined
 * "owner/repo" string, which is insufficient for the REST path). Mirrors the
 * GH_SUBJECT regex in duty-officer-clock.ts.
 */
const GH_THREAD_REF =
  /^gh:([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/i;

export interface EscalationIssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** Parse `gh:owner/repo#N`; returns null for non-gh or malformed refs. */
export function parseGithubThreadRef(threadRef: string): EscalationIssueRef | null {
  const match = GH_THREAD_REF.exec(threadRef.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * Kill switch. Default `true`; only the literal `false` (any case, trimmed)
 * disables issue delivery and restores the prior operator-mailbox path.
 */
export function resolveEscalateToIssueEnabled(
  raw: string | undefined = process.env.TASKMASTER_ESCALATE_TO_ISSUE
): boolean {
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== 'false';
}

/**
 * A single GitHub login: 1-39 chars, ASCII alphanumerics or single hyphens,
 * not starting or ending with a hyphen.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** True only for a string that is exactly one valid GitHub login. */
export function isValidGithubLogin(login: string | null | undefined): login is string {
  return typeof login === 'string' && GITHUB_LOGIN.test(login);
}

/** Length caps for externally sourced text placed in the comment body. */
export const ESCALATION_TITLE_MAX_CHARS = 200;
export const ESCALATION_NEXT_ACTION_MAX_CHARS = 300;
export const ESCALATION_THREAD_REF_MAX_CHARS = 200;

/**
 * Reduce externally sourced text (issue title, tracker next action, thread ref)
 * to a single line of printable ASCII before it goes into a posted comment:
 * newlines, tabs and other control characters become spaces; non-ASCII
 * characters are dropped; '@' is removed (the only mention in the body is the
 * validated owner line); '<' and '>' are removed so the text cannot open an
 * HTML comment or tag that hides or forges body content (including a fake
 * escalation marker). Whitespace is collapsed and the result is capped at
 * maxChars (truncated text ends in "..."). Returns null when nothing is left.
 */
export function sanitizeExternalText(
  raw: string | null | undefined,
  maxChars: number
): string | null {
  if (typeof raw !== 'string') return null;
  let printable = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      printable += ' ';
    } else if (code > 0x7e || ch === '@' || ch === '<' || ch === '>') {
      continue;
    } else {
      printable += ch;
    }
  }
  const cleaned = printable.replace(/ {2,}/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  const cap = Math.max(1, maxChars - 3);
  return `${cleaned.slice(0, cap).trimEnd()}...`;
}

/**
 * Extract a single owner login from an `owner:<login>` LABEL (not a GitHub
 * assignee). labelsJson is TmAdoptionRow.labels_json, a JSON array of strings.
 * The suffix (surrounding spaces only trimmed) must be exactly one valid GitHub
 * login; anything else -- `owner:user @team`, a suffix containing a newline,
 * punctuation, or over-length -- is ignored so it can never produce an
 * unintended mention. Returns the first valid login, or null when there is none
 * or the JSON is absent/malformed.
 */
export function parseOwnerLabel(labelsJson: string | null | undefined): string | null {
  if (!labelsJson) return null;
  let labels: unknown;
  try {
    labels = JSON.parse(labelsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(labels)) return null;
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const lower = label.toLowerCase();
    if (lower.startsWith('owner:')) {
      const login = label.slice('owner:'.length).replace(/^ +| +$/g, '');
      if (isValidGithubLogin(login)) return login;
    }
  }
  return null;
}

function describeSince(sinceIso: string | null, nowMs: number): string | null {
  if (!sinceIso) return null;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return null;
  const diffMs = Math.max(0, nowMs - sinceMs);
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Build the plain-English, ASCII-only escalation comment body. Starts with the
 * hidden marker, then: what is stuck, since when (if known), the next step (if
 * the tracker names one), at most one owner @-mention (only from an
 * `owner:<login>` label), and a Taskmaster attribution line.
 *
 * Every externally sourced field (title, threadRef, nextAction) passes through
 * sanitizeExternalText, and ownerLabelLogin is re-validated as a single GitHub
 * login here as well (defense in depth for callers that skip parseOwnerLabel),
 * so the ASCII-only and at-most-one-mention invariants hold for any input.
 */
export function buildEscalationCommentBody(params: {
  title: string | null;
  threadRef: string;
  sinceIso: string | null;
  nextAction: string | null;
  ownerLabelLogin: string | null;
  nowMs: number;
}): string {
  const what =
    sanitizeExternalText(params.title, ESCALATION_TITLE_MAX_CHARS) ??
    sanitizeExternalText(params.threadRef, ESCALATION_THREAD_REF_MAX_CHARS) ??
    'an escalated issue';
  const since = describeSince(params.sinceIso, params.nowMs);
  const lines: string[] = [TASKMASTER_ESCALATION_MARKER];
  let stuck = `Stuck P0: ${what} has no owner and no forward movement`;
  if (since) stuck += ` for ${since}`;
  stuck += '.';
  lines.push(stuck);
  const nextAction = sanitizeExternalText(params.nextAction, ESCALATION_NEXT_ACTION_MAX_CHARS);
  if (nextAction) {
    lines.push(`Next step: ${nextAction}`);
  }
  const owner = params.ownerLabelLogin?.replace(/^ +| +$/g, '') ?? null;
  if (isValidGithubLogin(owner)) {
    lines.push(`Owner: @${owner}`);
  }
  lines.push('Escalated by Taskmaster (M-155).');
  return lines.join('\n\n');
}

export interface EscalationIssueComment {
  body: string;
  created_at: string;
}

export interface EscalationDeliveryDeps {
  /**
   * Return EVERY comment on the issue that could hold a marker inside the
   * cooldown window. sinceIso is the cooldown-window start; implementations
   * may use it to narrow the fetch (GitHub's `since` filters on updated_at,
   * which is always >= created_at, so no in-window marker is excluded) but
   * must not truncate: a missed recent marker means a duplicate escalation.
   */
  listIssueComments(
    issue: EscalationIssueRef,
    sinceIso?: string
  ): Promise<EscalationIssueComment[]>;
  postIssueComment(issue: EscalationIssueRef, body: string): Promise<void>;
  now?: () => Date;
  /**
   * Per-issue delivery claim taken BEFORE the GitHub list+post, so two ticks or
   * processes cannot both pass the marker check and both post. Production
   * wires the database-backed claim (createDbEscalationDeliveryClaim); when
   * absent, only the marker dedupe applies.
   */
  claim?: EscalationDeliveryClaim;
}

/**
 * An atomic per-issue claim. `claim` returns a claim id, or null when another
 * attempt holds the issue (in flight, or posted inside the cooldown).
 * `complete` records the post so the claim holds the issue for the cooldown;
 * `release` frees a claim that posted nothing. Both are fenced on the claim id.
 * A claim that is neither completed nor released (a crash) expires after its
 * lease.
 */
export interface EscalationDeliveryClaim {
  claim(issueKey: string, nowMs: number): Promise<string | null>;
  complete(issueKey: string, claimId: string, postedAtIso: string): Promise<void>;
  release(issueKey: string, claimId: string): Promise<void>;
}

/** Why an escalation was not posted. */
export type EscalationSuppressionReason = 'cooldown_marker' | 'claim_held';

export interface EscalationDeliveryResult {
  posted: boolean;
  /** Set when posted is false. */
  suppressedBy?: EscalationSuppressionReason;
}

/** Stable per-issue claim key: lowercased `owner/repo#N` (GitHub names are case-insensitive). */
export function escalationIssueKey(issue: EscalationIssueRef): string {
  return `${issue.owner}/${issue.repo}#${issue.number}`.toLowerCase();
}

/**
 * Deliver an escalation as a GitHub issue comment, deduped on the 72h cooldown
 * documented above and serialized per issue by deps.claim. Returns
 * `{ posted: true }` when a fresh comment was posted; `{ posted: false }` with
 * suppressedBy 'claim_held' when another attempt holds the issue's claim, or
 * 'cooldown_marker' when a marker comment newer than the cooldown already
 * covers this issue.
 */
export async function deliverEscalationToIssue(
  params: { issue: EscalationIssueRef; threadRef: string; body: string },
  deps: EscalationDeliveryDeps
): Promise<EscalationDeliveryResult> {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const issueKey = escalationIssueKey(params.issue);
  const claim = deps.claim;
  const claimId = claim ? await claim.claim(issueKey, nowMs) : null;
  if (claim && claimId === null) {
    return { posted: false, suppressedBy: 'claim_held' };
  }

  let posted = false;
  try {
    const windowStartIso = new Date(nowMs - TASKMASTER_ESCALATION_COOLDOWN_MS).toISOString();
    const comments = await deps.listIssueComments(params.issue, windowStartIso);
    let latestMarkerMs = Number.NEGATIVE_INFINITY;
    for (const comment of comments) {
      if (!(comment.body ?? '').includes(TASKMASTER_ESCALATION_MARKER)) continue;
      const createdMs = Date.parse(comment.created_at);
      if (Number.isFinite(createdMs) && createdMs > latestMarkerMs) latestMarkerMs = createdMs;
    }
    if (
      latestMarkerMs > Number.NEGATIVE_INFINITY &&
      nowMs - latestMarkerMs < TASKMASTER_ESCALATION_COOLDOWN_MS
    ) {
      return { posted: false, suppressedBy: 'cooldown_marker' };
    }
    await deps.postIssueComment(params.issue, params.body);
    posted = true;
  } finally {
    // Nothing was posted (suppressed or an error): free the issue now. A
    // failed release is not fatal -- the claim's lease expires on its own.
    if (claim && claimId !== null && !posted) {
      try {
        await claim.release(issueKey, claimId);
      } catch (error) {
        log.warn({ err: error as Error, issueKey }, 'taskmaster.escalation_claim_release_failed');
      }
    }
  }

  if (claim && claimId !== null) {
    // The comment IS posted, so this never turns the delivery into a failure.
    // If recording it fails, the claim expires after its lease and the marker
    // comment that now exists on the issue suppresses the next attempt.
    try {
      await claim.complete(issueKey, claimId, new Date(nowMs).toISOString());
    } catch (error) {
      log.warn({ err: error as Error, issueKey }, 'taskmaster.escalation_claim_complete_failed');
    }
  }
  return { posted: true };
}

function githubTimeoutMs(): number {
  return Math.max(1_000, Number(process.env.TASKMASTER_GITHUB_TIMEOUT_MS) || 15_000);
}

/**
 * Lease on an in-flight claim. It must outlast the slowest possible delivery
 * (every comment page plus the post, each at the GitHub request timeout), or
 * a live-but-slow attempt could lose its claim to a second one. Floor 30
 * minutes: after a crash the issue is re-claimable within one P0 bucket.
 */
export function escalationClaimLeaseMs(): number {
  return Math.max(30 * 60 * 1000, (ESCALATION_COMMENT_MAX_PAGES + 2) * githubTimeoutMs());
}

/**
 * The database-backed claim (tm_escalation_claims, migration 057). One
 * atomic statement per claim; see taskmasterDb.claimEscalationDelivery. A
 * recorded post holds the issue for TASKMASTER_ESCALATION_COOLDOWN_MS.
 * `database` is injectable for tests (e.g. two adapters on one file to model
 * two processes); production uses the shared connection.
 */
export function createDbEscalationDeliveryClaim(
  database?: Pick<IDatabase, 'query'>
): EscalationDeliveryClaim {
  return {
    claim: (issueKey, nowMs): Promise<string | null> =>
      taskmasterDb.claimEscalationDelivery(
        {
          issue_key: issueKey,
          now_iso: new Date(nowMs).toISOString(),
          lease_expires_at: new Date(nowMs + escalationClaimLeaseMs()).toISOString(),
          hold_cutoff_iso: new Date(nowMs - TASKMASTER_ESCALATION_COOLDOWN_MS).toISOString(),
        },
        database
      ),
    complete: async (issueKey, claimId, postedAtIso): Promise<void> => {
      await taskmasterDb.completeEscalationDelivery(
        { issue_key: issueKey, claim_id: claimId, posted_at: postedAtIso },
        database
      );
    },
    release: (issueKey, claimId): Promise<void> =>
      taskmasterDb.releaseEscalationDelivery({ issue_key: issueKey, claim_id: claimId }, database),
  };
}

const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * Hard ceiling on comment pages fetched per dedupe check (100 comments/page).
 * Reaching it throws instead of returning a partial list: a truncated list
 * could hide the newest marker and cause a duplicate escalation, so failing
 * closed (no post this tick) is the safe outcome.
 */
export const ESCALATION_COMMENT_MAX_PAGES = 50;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RealEscalationDeliveryOptions {
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to the shared container token accessor. */
  token?: string | null;
}

/** Return the rel="next" URL from a GitHub Link header, or null. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (match && /\brel="?next"?/.test(match[2])) return match[1];
  }
  return null;
}

/**
 * Minimal GitHub REST helper mirroring duty-officer-clock's private githubJson
 * (kept local rather than exported from that file, which the spec limits to a
 * single githubToken() export). Reuses the shared container token accessor.
 * Takes a full URL and returns the raw Response so callers can read headers
 * (the Link header drives comment pagination). Only api.github.com URLs are
 * requested, so a Link header can never send the token to another host.
 */
async function githubRequest(
  url: string,
  options: RealEscalationDeliveryOptions,
  init?: { method?: string; extraHeaders?: Record<string, string>; body?: string }
): Promise<Response> {
  if (!url.startsWith(`${GITHUB_API_ORIGIN}/`)) {
    throw new Error('taskmaster_github_url_not_api_origin');
  }
  const token = options.token !== undefined ? options.token : githubToken();
  if (!token) throw new Error('taskmaster_github_token_missing');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'bdc-harness-taskmaster-escalation',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (init?.extraHeaders) {
    for (const key of Object.keys(init.extraHeaders)) {
      headers[key] = init.extraHeaders[key];
    }
  }
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, reqInit): Promise<Response> => fetch(input, reqInit));
  const response = await fetchImpl(url, {
    method: init?.method,
    headers,
    body: init?.body,
    signal: AbortSignal.timeout(githubTimeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`taskmaster_github_http_${response.status}`);
  }
  return response;
}

function issueCommentsUrl(issue: EscalationIssueRef): string {
  return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`;
}

/**
 * Fetch every comment on the issue updated at or after sinceIso (all comments
 * when sinceIso is absent), following Link rel="next" pages to the end.
 * GitHub lists issue comments oldest-first, so reading only the first page
 * would miss the newest marker on an issue with more than 100 comments.
 */
async function listAllIssueComments(
  issue: EscalationIssueRef,
  sinceIso: string | undefined,
  options: RealEscalationDeliveryOptions
): Promise<EscalationIssueComment[]> {
  const params = new URLSearchParams({ per_page: '100' });
  if (sinceIso) params.set('since', sinceIso);
  let url: string | null = `${issueCommentsUrl(issue)}?${params.toString()}`;
  const all: EscalationIssueComment[] = [];
  let pages = 0;
  while (url) {
    if (pages >= ESCALATION_COMMENT_MAX_PAGES) {
      throw new Error('taskmaster_github_comment_pages_exceeded');
    }
    pages += 1;
    const response = await githubRequest(url, options);
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error('taskmaster_github_comments_not_array');
    for (const comment of page) all.push(comment);
    url = page.length > 0 ? parseNextLink(response.headers.get('link')) : null;
  }
  return all;
}

/**
 * Real GitHub REST delivery deps. The dedupe listing asks GitHub only for
 * comments updated inside the cooldown window (`since`) and follows every
 * Link rel="next" page, so a recent marker is found no matter how many
 * comments the issue carries.
 */
export function createRealEscalationDeliveryDeps(
  options: RealEscalationDeliveryOptions = {}
): EscalationDeliveryDeps {
  return {
    listIssueComments: (issue, sinceIso): Promise<EscalationIssueComment[]> =>
      listAllIssueComments(issue, sinceIso, options),
    postIssueComment: async (issue, body): Promise<void> => {
      await githubRequest(issueCommentsUrl(issue), options, {
        method: 'POST',
        extraHeaders: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
    },
  };
}
