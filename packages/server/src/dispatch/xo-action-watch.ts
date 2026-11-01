/**
 * Pure helpers and production GitHub defaults for the inbox reader's
 * bdc-xo comment watch. Marker text, digest formatting, state files, and
 * Dispatch sends stay in inbox-reader.ts.
 */

export const XO_ACTION_RATE_REMAINING_FLOOR = 500;
export const XO_ACTION_COMMENT_PAGE_SIZE = 100;

const XO_ACTION_COMMENTS_URL =
  'https://api.github.com/repos/thinmansoftware/bdc-xo/issues/comments';

export interface XoActionComment {
  id: string;
  html_url: string;
  author: string;
  created_at: string;
  body: string;
  issue: number | null;
}

export function parseXoActionTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** First line only. One trailing CR is ignored so CRLF bodies still match. */
export function firstLineContainsXoAction(body: string): boolean {
  const firstLine = body.split('\n', 1)[0] ?? '';
  const line = firstLine.endsWith('\r') ? firstLine.slice(0, -1) : firstLine;
  return line.toLowerCase().includes('xo action');
}

/** True only for a non-empty lease id occurring exactly in the full body. */
export function bodyContainsLeaseId(body: string, leaseId: string): boolean {
  if (leaseId.length === 0) return false;
  return body.includes(leaseId);
}

export function xoActionListingBlockedByRate(remaining: number): boolean {
  return Number.isFinite(remaining) && remaining < XO_ACTION_RATE_REMAINING_FLOOR;
}

export function issueNumberFromIssueUrl(issueUrl: string): number | null {
  const match = /\/(\d+)$/.exec(issueUrl.trim());
  if (!match) return null;
  const issue = Number(match[1]);
  if (!Number.isSafeInteger(issue) || issue <= 0) return null;
  return issue;
}

export function buildXoActionMessageBody(comment: {
  html_url: string;
  author: string;
  created_at: string;
  body: string;
}): string {
  const author = comment.author.trim() === '' ? 'unknown' : comment.author;
  return [
    `url: ${comment.html_url}`,
    `author: ${author}`,
    `created_at: ${comment.created_at}`,
    comment.body.slice(0, 500),
  ].join('\n');
}

export function commentIsBeforeWatermark(createdAt: string, watermarkMs: number | null): boolean {
  if (watermarkMs === null) return false;
  const created = parseXoActionTimestamp(createdAt);
  if (created === null) return false;
  return created < watermarkMs;
}

/**
 * Cursor after a rate, auth, or probe skip. An existing cursor is kept.
 * A first run stores the run start so a later healthy run cannot backfill.
 */
export function selectSkippedXoActionCursor(prior: string | undefined, startedIso: string): string {
  return prior ?? startedIso;
}

/**
 * Cursor after a successful listing. Null means leave the stored cursor unchanged.
 * A candidate earlier than the prior cursor (or the run start, on the first run)
 * is not stored: GitHub `since` is inclusive, and rewinding would backfill.
 */
export function selectXoActionCursor(input: {
  prior: string | undefined;
  startedIso: string;
  comments: readonly { created_at: string }[];
}): string | null {
  const prior = input.prior;
  const startedMs = parseXoActionTimestamp(input.startedIso);
  const comments = input.comments;
  const floor = prior ?? input.startedIso;
  const isOlderThanStart = (comment: { created_at: string }): boolean => {
    if (startedMs === null) return false;
    const created = parseXoActionTimestamp(comment.created_at);
    return created !== null && created < startedMs;
  };
  const clamp = (candidate: string): string => {
    const candidateMs = parseXoActionTimestamp(candidate);
    const floorMs = parseXoActionTimestamp(floor);
    if (candidateMs === null || floorMs === null) return candidate;
    return candidateMs < floorMs ? floor : candidate;
  };

  if (prior === undefined && (comments.length === 0 || comments.every(isOlderThanStart))) {
    return input.startedIso;
  }
  if (comments.length === 0) return null;

  if (comments.length === XO_ACTION_COMMENT_PAGE_SIZE) {
    const last = comments[comments.length - 1];
    if (last && parseXoActionTimestamp(last.created_at) !== null) return clamp(last.created_at);
    return prior === undefined ? input.startedIso : null;
  }

  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const comment of comments) {
    const created = parseXoActionTimestamp(comment.created_at);
    if (created === null) continue;
    if (created >= newestMs) {
      newestMs = created;
      newest = comment.created_at;
    }
  }
  if (newest === null) return prior === undefined ? input.startedIso : null;
  return clamp(newest);
}

function isMissingGitHubAuth(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('github_auth_missing:');
}

function readCoreRemaining(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || !('resources' in payload)) return null;
  const resources = payload.resources;
  if (typeof resources !== 'object' || resources === null || !('core' in resources)) return null;
  const core = resources.core;
  if (typeof core !== 'object' || core === null || !('remaining' in core)) return null;
  const remaining = core.remaining;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return null;
  return remaining;
}

function mapGitHubIssueComment(value: unknown): XoActionComment {
  if (typeof value !== 'object' || value === null) throw new Error('xo_action_list_malformed');
  const row = value as Record<string, unknown>;
  const idValue = row.id;
  const id =
    typeof idValue === 'number' && Number.isFinite(idValue)
      ? String(idValue)
      : typeof idValue === 'string'
        ? idValue
        : '';
  let author = 'unknown';
  const user = row.user;
  if (
    typeof user === 'object' &&
    user !== null &&
    'login' in user &&
    typeof user.login === 'string'
  ) {
    const login = user.login.trim();
    if (login !== '') author = login;
  }
  const issueUrl = typeof row.issue_url === 'string' ? row.issue_url : '';
  return {
    id,
    html_url: typeof row.html_url === 'string' ? row.html_url : '',
    author,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    body: typeof row.body === 'string' ? row.body : '',
    issue: issueNumberFromIssueUrl(issueUrl),
  };
}

/** One core rate-limit read. Null means GitHub authentication is unavailable. */
export async function defaultProbeCoreRemaining(): Promise<number | null> {
  const { resolveServiceGitHubAuth } = await import('@archon/core/github/service-identity');
  const { serviceGitHubFetch } = await import('@archon/core/github/request');
  let identity;
  try {
    identity = resolveServiceGitHubAuth('duty_officer');
  } catch (error) {
    if (isMissingGitHubAuth(error)) return null;
    throw error;
  }
  if (identity.kind === 'none' || (identity.kind === 'pat' && identity.token.trim() === '')) {
    return null;
  }
  const response = await serviceGitHubFetch({
    service: 'duty_officer',
    url: 'https://api.github.com/rate_limit',
    identity,
  });
  if (!response.ok) throw new Error(`xo_action_rate_probe_http_${response.status}`);
  const payload: unknown = await response.json();
  const remaining = readCoreRemaining(payload);
  if (remaining === null) throw new Error('xo_action_rate_probe_malformed');
  return remaining;
}

/** One comment page. Link headers are not followed. */
export async function defaultListXoActionComments(sinceIso: string): Promise<XoActionComment[]> {
  const { serviceGitHubFetch } = await import('@archon/core/github/request');
  const url = new URL(XO_ACTION_COMMENTS_URL);
  url.searchParams.set('since', sinceIso);
  url.searchParams.set('per_page', String(XO_ACTION_COMMENT_PAGE_SIZE));
  url.searchParams.set('sort', 'created');
  url.searchParams.set('direction', 'asc');
  const response = await serviceGitHubFetch({
    service: 'duty_officer',
    url,
  });
  if (!response.ok) throw new Error(`xo_action_list_http_${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('xo_action_list_malformed');
  return payload.map(mapGitHubIssueComment);
}
