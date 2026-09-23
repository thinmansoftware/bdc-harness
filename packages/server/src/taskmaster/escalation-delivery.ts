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
 *   - A cooldown against the marker comment is cheap (one comments-list call),
 *     fully deterministic, and satisfies stop condition 4 (3 ticks with no new
 *     activity => exactly one marker comment survives) for any realistic tick
 *     interval, because the second and third ticks land well inside 72h of the
 *     first tick's comment.
 * Re-escalation therefore happens only after 72h has elapsed since the last
 * Taskmaster escalation comment on that issue.
 */
import { githubToken } from '../dispatch/duty-officer-clock';

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
 * Extract a single owner login from an `owner:<login>` LABEL (not a GitHub
 * assignee). labelsJson is TmAdoptionRow.labels_json, a JSON array of strings.
 * Returns null when absent, malformed, or empty.
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
      const login = label.slice('owner:'.length).trim();
      if (login) return login;
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
 */
export function buildEscalationCommentBody(params: {
  title: string | null;
  threadRef: string;
  sinceIso: string | null;
  nextAction: string | null;
  ownerLabelLogin: string | null;
  nowMs: number;
}): string {
  const what = params.title?.trim() ? params.title.trim() : params.threadRef;
  const since = describeSince(params.sinceIso, params.nowMs);
  const lines: string[] = [TASKMASTER_ESCALATION_MARKER];
  let stuck = `Stuck P0: ${what} has no owner and no forward movement`;
  if (since) stuck += ` for ${since}`;
  stuck += '.';
  lines.push(stuck);
  if (params.nextAction?.trim()) {
    lines.push(`Next step: ${params.nextAction.trim()}`);
  }
  if (params.ownerLabelLogin?.trim()) {
    lines.push(`Owner: @${params.ownerLabelLogin.trim()}`);
  }
  lines.push('Escalated by Taskmaster (M-155).');
  return lines.join('\n\n');
}

export interface EscalationIssueComment {
  body: string;
  created_at: string;
}

export interface EscalationDeliveryDeps {
  listIssueComments(issue: EscalationIssueRef): Promise<EscalationIssueComment[]>;
  postIssueComment(issue: EscalationIssueRef, body: string): Promise<void>;
  now?: () => Date;
}

/**
 * Deliver an escalation as a GitHub issue comment, deduped on the 72h cooldown
 * documented above. Returns `{ posted: true }` when a fresh comment was posted,
 * `{ posted: false }` when a marker comment newer than the cooldown already
 * covers this issue.
 */
export async function deliverEscalationToIssue(
  params: { issue: EscalationIssueRef; threadRef: string; body: string },
  deps: EscalationDeliveryDeps
): Promise<{ posted: boolean }> {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const comments = await deps.listIssueComments(params.issue);
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
    return { posted: false };
  }
  await deps.postIssueComment(params.issue, params.body);
  return { posted: true };
}

function githubTimeoutMs(): number {
  return Math.max(1_000, Number(process.env.TASKMASTER_GITHUB_TIMEOUT_MS) || 15_000);
}

/**
 * Minimal GitHub REST helper mirroring duty-officer-clock's private githubJson
 * (kept local rather than exported from that file, which the spec limits to a
 * single githubToken() export). Reuses the shared container token accessor.
 */
async function githubJson<T>(
  path: string,
  options?: { method?: string; extraHeaders?: Record<string, string>; body?: string }
): Promise<T> {
  const token = githubToken();
  if (!token) throw new Error('taskmaster_github_token_missing');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'bdc-harness-taskmaster-escalation',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options?.extraHeaders) {
    for (const key of Object.keys(options.extraHeaders)) {
      headers[key] = options.extraHeaders[key];
    }
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method: options?.method,
    headers,
    body: options?.body,
    signal: AbortSignal.timeout(githubTimeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`taskmaster_github_http_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Real GitHub REST delivery deps. per_page=100 covers the full comment history
 * of every realistic escalated issue in one call; issues with >100 comments
 * would only surface the oldest page, at worst causing one redundant escalation
 * comment past the cooldown -- an acceptable, rare degradation, not a
 * correctness break for the target issues.
 */
export function createRealEscalationDeliveryDeps(): EscalationDeliveryDeps {
  return {
    listIssueComments: (issue): Promise<EscalationIssueComment[]> =>
      githubJson<EscalationIssueComment[]>(
        `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments?per_page=100`
      ),
    postIssueComment: async (issue, body): Promise<void> => {
      await githubJson(
        `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`,
        {
          method: 'POST',
          extraHeaders: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }
      );
    },
  };
}
