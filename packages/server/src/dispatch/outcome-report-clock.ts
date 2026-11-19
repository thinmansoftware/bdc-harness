/**
 * WO-HARNESS-DAILY-OUTCOME-REPORT-01: daily outcome report clock.
 *
 * Once a day, at or after 11:00 UTC, run scripts/run-completion-report.ts
 * (read-only) and post its "Outcomes (last 24h)" result as one comment on the
 * GitHub issue named by HARNESS_OUTCOME_REPORT_ISSUE (repo default
 * thinmansoftware/bdc-xo). The comment opens with the owner-visible flag line.
 *
 * - Unset or invalid HARNESS_OUTCOME_REPORT_ISSUE: log and skip, never fail.
 * - One comment per UTC day: a date marker in the comment is the dedupe key, so
 *   a restart reads the issue and does not post twice.
 * - Never posts to a Dispatch mailbox (t3-desktop has no reader yet; operator
 *   is unread).
 * - Token: the taskmaster service identity through getServiceGitHubToken (an
 *   App installation token when the App is configured), as in #1401.
 */
import { join } from 'path';
import { createLogger, getArchonHome } from '@archon/paths';
import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
} from '@archon/core/github/service-identity';

const log = createLogger('dispatch/outcome-report-clock');

export const OUTCOME_REPORT_HOUR_UTC = 11;
export const OUTCOME_REPORT_DEFAULT_REPO = 'thinmansoftware/bdc-xo';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const MAX_COMMENT_PAGES = 5;

export function outcomeReportMarker(date: string): string {
  return `<!-- harness-outcome-report:${date} -->`;
}

export interface OutcomeReportJson {
  outcome_flag_line: string;
  outcomes: {
    window: { start: string; end: string };
    mechanisms: { name: string; input: number; outcome: number }[];
    mailboxes: {
      recipient: string;
      depth: number;
      depth_live: number;
      oldest_live: string | null;
      oldest_live_age_hours: number | null;
    }[];
    flags: string[];
  };
}

export interface OutcomeReportClockDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  /** Run the read-only report for the 24h ending at asOf ('YYYY-MM-DD HH:MM:SS' UTC). */
  runReport: (asOf: string) => Promise<OutcomeReportJson>;
  /** Comment bodies on the issue whose updated_at is at or after sinceIso. */
  listComments: (repo: string, issue: number, sinceIso: string) => Promise<string[]>;
  postComment: (repo: string, issue: number, body: string) => Promise<void>;
}

export interface OutcomeReportClockState {
  lastPostedDate: string | null;
  inFlight: boolean;
}

export type OutcomeReportTickStatus =
  | 'skipped_no_issue'
  | 'not_due'
  | 'already_posted'
  | 'posted'
  | 'busy'
  | 'failed';

export function createOutcomeReportClockState(): OutcomeReportClockState {
  return { lastPostedDate: null, inFlight: false };
}

function parseIssue(raw: string | undefined): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export function formatOutcomeReportComment(report: OutcomeReportJson, date: string): string {
  const o = report.outcomes;
  const lines: string[] = [];
  lines.push(report.outcome_flag_line);
  lines.push('');
  lines.push(
    `Harness outcome report, 24h ${o.window.start} to ${o.window.end} (WO-HARNESS-DAILY-OUTCOME-REPORT-01).`
  );
  lines.push('');
  lines.push('| Mechanism | Input | Outcome |');
  lines.push('|---|---|---|');
  for (const m of o.mechanisms) lines.push(`| ${m.name} | ${m.input} | ${m.outcome} |`);
  lines.push('');
  lines.push('| Mailbox | Depth | Live | Oldest live | Age (h) |');
  lines.push('|---|---|---|---|---|');
  for (const m of o.mailboxes) {
    lines.push(
      `| ${m.recipient} | ${m.depth} | ${m.depth_live} | ${m.oldest_live ?? 'none'} | ${m.oldest_live_age_hours ?? 'none'} |`
    );
  }
  lines.push('');
  lines.push(outcomeReportMarker(date));
  return lines.join('\n');
}

/** One clock tick. Never throws. */
export async function tickOutcomeReportClock(
  deps: OutcomeReportClockDeps,
  state: OutcomeReportClockState
): Promise<OutcomeReportTickStatus> {
  const issue = parseIssue(deps.env.HARNESS_OUTCOME_REPORT_ISSUE);
  if (issue === null) {
    log.info('outcome_report_skipped_no_issue: set HARNESS_OUTCOME_REPORT_ISSUE to enable');
    return 'skipped_no_issue';
  }
  const now = deps.now();
  if (now.getUTCHours() < OUTCOME_REPORT_HOUR_UTC) return 'not_due';
  const date = now.toISOString().slice(0, 10);
  if (state.lastPostedDate === date) return 'already_posted';
  if (state.inFlight) return 'busy';
  state.inFlight = true;
  const repo = deps.env.HARNESS_OUTCOME_REPORT_REPO?.trim() || OUTCOME_REPORT_DEFAULT_REPO;
  try {
    const marker = outcomeReportMarker(date);
    const existing = await deps.listComments(repo, issue, `${date}T00:00:00Z`);
    if (existing.some(body => body.includes(marker))) {
      state.lastPostedDate = date;
      return 'already_posted';
    }
    const asOf = now.toISOString().slice(0, 19).replace('T', ' ');
    const report = await deps.runReport(asOf);
    await deps.postComment(repo, issue, formatOutcomeReportComment(report, date));
    state.lastPostedDate = date;
    log.info({ repo, issue, date, flags: report.outcomes.flags.length }, 'outcome_report_posted');
    return 'posted';
  } catch (error) {
    log.warn(
      { repo, issue, date, cause: (error as Error).message.slice(0, 200) },
      'outcome_report_failed'
    );
    return 'failed';
  } finally {
    state.inFlight = false;
  }
}

// ---------- real dependencies ----------

async function githubToken(env: Record<string, string | undefined>): Promise<string> {
  const identity = resolveServiceGitHubAuth('taskmaster', env);
  if (identity.kind === 'none') throw new Error('outcome_report_github_token_missing');
  const token = await getServiceGitHubToken(identity, { apiBaseUrl: GITHUB_API_ORIGIN });
  if (!token) throw new Error('outcome_report_github_token_missing');
  return token;
}

async function githubRequest(
  env: Record<string, string | undefined>,
  url: string,
  init?: { method?: string; body?: string }
): Promise<Response> {
  if (!url.startsWith(`${GITHUB_API_ORIGIN}/`)) throw new Error('outcome_report_url_not_api');
  const token = await githubToken(env);
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'bdc-harness-outcome-report',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body,
  });
  if (!response.ok) throw new Error(`outcome_report_github_${response.status}`);
  return response;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (m && /\brel="?next"?/.test(m[2])) return m[1];
  }
  return null;
}

export function createRealOutcomeReportRunner(
  env: Record<string, string | undefined>,
  scriptPath: string = env.HARNESS_OUTCOME_REPORT_SCRIPT ??
    join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'run-completion-report.ts'),
  dbPath: string = join(getArchonHome(), 'archon.db')
): (asOf: string) => Promise<OutcomeReportJson> {
  return async (asOf: string): Promise<OutcomeReportJson> => {
    if (env.DATABASE_URL) throw new Error('outcome_report_sqlite_only');
    const proc = Bun.spawn(
      ['bun', 'run', scriptPath, '--days', '1', '--as-of', asOf, '--db', dbPath, '--json'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`outcome_report_exit_${code}:${err.slice(0, 160)}`);
    const parsed = JSON.parse(out) as OutcomeReportJson;
    if (typeof parsed.outcome_flag_line !== 'string' || !parsed.outcomes) {
      throw new Error('outcome_report_bad_json');
    }
    return parsed;
  };
}

export function createRealOutcomeReportClockDeps(
  env: Record<string, string | undefined> = process.env
): OutcomeReportClockDeps {
  return {
    env,
    now: (): Date => new Date(),
    runReport: createRealOutcomeReportRunner(env),
    listComments: async (repo, issue, sinceIso): Promise<string[]> => {
      const bodies: string[] = [];
      let url: string | null =
        `${GITHUB_API_ORIGIN}/repos/${repo}/issues/${issue}/comments?per_page=100&since=${encodeURIComponent(sinceIso)}`;
      for (let page = 0; url && page < MAX_COMMENT_PAGES; page++) {
        const response = await githubRequest(env, url);
        const rows = (await response.json()) as { body?: unknown }[];
        for (const r of rows) if (typeof r.body === 'string') bodies.push(r.body);
        url = nextLink(response.headers.get('link'));
      }
      return bodies;
    },
    postComment: async (repo, issue, body): Promise<void> => {
      await githubRequest(env, `${GITHUB_API_ORIGIN}/repos/${repo}/issues/${issue}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    },
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

function outcomeReportClockEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.HARNESS_OUTCOME_REPORT_CLOCK_ENABLED === 'false') return false;
  return true;
}

export function startOutcomeReportClock(
  deps: OutcomeReportClockDeps = createRealOutcomeReportClockDeps()
): void {
  if (!outcomeReportClockEnabled() || timer) return;
  const state = createOutcomeReportClockState();
  void tickOutcomeReportClock(deps, state);
  const interval = Math.max(
    60_000,
    Number(process.env.HARNESS_OUTCOME_REPORT_INTERVAL_MS) || 900_000
  );
  timer = setInterval(() => void tickOutcomeReportClock(deps, state), interval);
  timer.unref?.();
}

export function stopOutcomeReportClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
