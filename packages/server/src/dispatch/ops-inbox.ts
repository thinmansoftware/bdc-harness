/**
 * The pinned ops-inbox GitHub issue and its one-comment-per-day digest
 * (WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01).
 *
 * Every routine ops event the Duty Officer triages is appended to a single
 * daily digest comment on ONE pinned GitHub issue (label `ops-inbox`), instead
 * of interrupting the XO or piling into an unread Dispatch mailbox. The comment
 * is addressed by a per-UTC-date marker, and each writer owns a fenced section
 * so independent writers (the routine section here, the john-queue section in
 * WO-HARNESS-TASKMASTER-JOHN-DIGEST-01) can update the same comment without
 * clobbering each other.
 *
 * This module never closes, cancels, or deletes anything -- it only finds or
 * creates one issue and upserts sections of one comment per day.
 */

import { createLogger } from '@archon/paths';
import { serviceGitHubFetchWithPermissionFallback } from '@archon/core/github/request';

const log = createLogger('dispatch/ops-inbox');

export const OPS_INBOX_LABEL = 'ops-inbox';
export const OPS_INBOX_ISSUE_TITLE = 'OPS INBOX -- daily digest (do not close)';

export function opsInboxRepo(): { owner: string; repo: string } {
  const raw = process.env.OPS_INBOX_REPO?.trim() || 'thinmansoftware/bdc-xo';
  const slash = raw.indexOf('/');
  if (slash <= 0) return { owner: 'thinmansoftware', repo: 'bdc-xo' };
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

/** Minimal GitHub surface the ops-inbox digest needs. Injected for tests. */
export interface OpsInboxGitHub {
  /** Open issue carrying the label, or null when none exists. */
  findOpenIssueByLabel(label: string): Promise<{ number: number } | null>;
  /** True when the label already exists in the repo. */
  labelExists(label: string): Promise<boolean>;
  createLabel(label: string): Promise<void>;
  createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number }>;
  listComments(issueNumber: number): Promise<{ id: number; body: string }[]>;
  createComment(issueNumber: number, body: string): Promise<{ id: number }>;
  updateComment(commentId: number, body: string): Promise<void>;
}

function dateMarker(dateUtc: string): string {
  return `<!-- ops-inbox-digest:${dateUtc} -->`;
}

function sectionOpen(sectionKey: string): string {
  return `<!-- section:${sectionKey} -->`;
}

function sectionClose(sectionKey: string): string {
  return `<!-- /section:${sectionKey} -->`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace (or insert) exactly one fenced section inside a digest comment body,
 * leaving every other section untouched. Pure -- no GitHub call.
 */
export function upsertSectionInBody(
  existingBody: string | null,
  dateUtc: string,
  sectionKey: string,
  markdown: string
): string {
  const marker = dateMarker(dateUtc);
  const open = sectionOpen(sectionKey);
  const close = sectionClose(sectionKey);
  const block = `${open}\n${markdown}\n${close}`;

  const base = existingBody?.includes(marker) ? existingBody : `${marker}\n`;

  const fenceRe = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`);
  if (fenceRe.test(base)) {
    return base.replace(fenceRe, block);
  }
  // Append the new section, keeping a single trailing newline.
  const trimmed = base.replace(/\s+$/, '');
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Find the open ops-inbox issue, creating the label and the issue only when
 * none exists. Idempotent: a second call returns the same issue number.
 */
export async function ensureOpsInboxIssue(gh: OpsInboxGitHub): Promise<number> {
  const existing = await gh.findOpenIssueByLabel(OPS_INBOX_LABEL);
  if (existing) return existing.number;
  if (!(await gh.labelExists(OPS_INBOX_LABEL))) {
    await gh.createLabel(OPS_INBOX_LABEL);
  }
  const created = await gh.createIssue({
    title: OPS_INBOX_ISSUE_TITLE,
    body:
      `${dateMarker('index')}\n\nThis issue is the daily ops-inbox digest. ` +
      'The Duty Officer appends routine ops events here instead of interrupting ' +
      'the XO or filling an unread Dispatch mailbox. Do not close.',
    labels: [OPS_INBOX_LABEL],
  });
  return created.number;
}

/**
 * Upsert one fenced section of the day's digest comment. Maintains exactly one
 * comment per UTC date (addressed by its marker) and performs at most one
 * GitHub write (a create for a new day, otherwise one update).
 */
export async function upsertDigestSection(
  gh: OpsInboxGitHub,
  dateUtc: string,
  sectionKey: string,
  markdown: string
): Promise<{ issueNumber: number; commentId: number; created: boolean }> {
  const issueNumber = await ensureOpsInboxIssue(gh);
  const comments = await gh.listComments(issueNumber);
  const marker = dateMarker(dateUtc);
  const existing = comments.find(comment => comment.body.includes(marker)) ?? null;
  if (existing) {
    const nextBody = upsertSectionInBody(existing.body, dateUtc, sectionKey, markdown);
    await gh.updateComment(existing.id, nextBody);
    return { issueNumber, commentId: existing.id, created: false };
  }
  const body = upsertSectionInBody(null, dateUtc, sectionKey, markdown);
  const created = await gh.createComment(issueNumber, body);
  return { issueNumber, commentId: created.id, created: true };
}

async function githubJson(
  path: string,
  options?: { method?: string; body?: string }
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'bdc-harness-ops-inbox',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options?.body) headers['Content-Type'] = 'application/json';
  const timeoutMs = Math.max(1_000, Number(process.env.OPS_INBOX_GITHUB_TIMEOUT_MS) || 15_000);
  const response = await serviceGitHubFetchWithPermissionFallback({
    service: 'duty_officer',
    url: `https://api.github.com${path}`,
    init: {
      method: options?.method,
      headers,
      body: options?.body,
      signal: AbortSignal.timeout(timeoutMs),
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`ops_inbox_github_http_${response.status}`);
  }
  if (response.status === 204 || response.status === 404) {
    return { status: response.status, data: undefined };
  }
  return { status: response.status, data: await response.json() };
}

/** Production GitHub client, backed by the duty_officer service identity. */
export function createRealOpsInboxGitHub(): OpsInboxGitHub {
  const { owner, repo } = opsInboxRepo();
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    async findOpenIssueByLabel(label): Promise<{ number: number } | null> {
      const { data } = await githubJson(
        `${base}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=10`
      );
      const rows = (data as { number: number; pull_request?: unknown }[] | undefined) ?? [];
      const issue = rows.find(row => !row.pull_request);
      return issue ? { number: issue.number } : null;
    },
    async labelExists(label): Promise<boolean> {
      const { status } = await githubJson(`${base}/labels/${encodeURIComponent(label)}`);
      return status !== 404;
    },
    async createLabel(label): Promise<void> {
      await githubJson(`${base}/labels`, {
        method: 'POST',
        body: JSON.stringify({ name: label, color: 'ededed' }),
      });
    },
    async createIssue(input): Promise<{ number: number }> {
      const { data } = await githubJson(`${base}/issues`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return { number: (data as { number: number }).number };
    },
    async listComments(issueNumber): Promise<{ id: number; body: string }[]> {
      const { data } = await githubJson(`${base}/issues/${issueNumber}/comments?per_page=100`);
      const rows = (data as { id: number; body?: string }[] | undefined) ?? [];
      return rows.map(comment => ({ id: comment.id, body: comment.body ?? '' }));
    },
    async createComment(issueNumber, body): Promise<{ id: number }> {
      const { data } = await githubJson(`${base}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      return { id: (data as { id: number }).id };
    },
    async updateComment(commentId, body): Promise<void> {
      await githubJson(`${base}/issues/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      log.info({ commentId }, 'ops_inbox.comment_updated');
    },
  };
}
