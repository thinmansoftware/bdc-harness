/**
 * Duty Officer security-scan detector (WO-HARNESS-DO-SECURITY-DETECTOR-01).
 *
 * A fourth, deterministic, ZERO-LLM check for the duty-officer-clock tick. It
 * evaluates the weekly security scan posture (scan freshness per repo, weekly
 * report acknowledgment, host-inventory receipt, an expected-report deadline)
 * and either PATCHes a single marker comment proving the detector ran, or opens
 * / updates / closes exactly one App-authenticated DETECTOR issue in
 * DUTY_OFFICER_GH_REPO.
 *
 * Entry point: runSecurityDetector(deps).
 *
 * Contracts implemented: C1-C8 and C10 (see the WO spec, section E7).
 * - Reads use the existing PAT (GH_TOKEN / GITHUB_TOKEN).
 * - Writes use a GitHub App installation token (thinman-overseer[bot]); when no
 *   App auth is configured the detector performs NO writes (W6 / C10).
 * - Every GitHub request carries AbortSignal.timeout and retries at most once on
 *   a 5xx / network error (N7).
 * - This module makes ZERO LLM calls and never imports the duty officer judge (N6).
 */
import { mintAppInstallationToken } from '@archon/overseer/adapters/github-real-deps';
import { createLogger } from '@archon/paths';

// Re-exported so the clock's createRealDutyOfficerClockDeps can wire it as the
// write-token provider. The mint itself lives in @archon/overseer where
// @octokit/auth-app is a dependency (W6 / C10); this package reaches it through
// the workspace export rather than depending on @octokit/auth-app directly.
export { mintAppInstallationToken };

const log = createLogger('dispatch/duty-officer-security-detector');

const DAY_MS = 86_400_000;
const APP_LOGIN = 'thinman-overseer[bot]';
const ISSUE_MARKER = '<!-- security-detector-issue -->';
const MARKER_COMMENT = '<!-- security-detector -->';
const RECEIPT_MARKER = '<!-- host-inventory -->';
const SCAN_LABEL = 'security-scan';
const DETECTOR_LABEL = 'security-detector';
const WEEKLY_TITLE_RE = /^Security Scan -- (\d{4})-W(\d{2})$/;
const TRIAGED_RE = /^TRIAGED\b/;
const DEFAULT_SCAN_REPOS = [
  'thinmansoftware/shopops',
  'thinmansoftware/lspro-react',
  'thinmansoftware/scout-service',
  'thinmansoftware/bdc-harness',
];

const P0_CODES = new Set([
  'scan_missing',
  'scan_stale',
  'receipt_missing',
  'unread',
  'report_missing',
]);
const P1_CODES = new Set(['scan_failed']);

export type SecurityDetectorVerdict = 'clean' | 'alarm' | 'disarmed' | 'observation_error';

export interface DetectorReason {
  code: string;
  repo?: string;
  detail?: string;
}

export interface SecurityDetectorDeps {
  fetchImpl: typeof fetch;
  readToken: () => string | null;
  writeTokenProvider: () => Promise<string | null>;
  now: () => Date;
  buildSha: string;
}

export interface SecurityDetectorResult {
  verdict: SecurityDetectorVerdict;
  reasons: DetectorReason[];
  evaluated_at: string;
  marker_home: number | null;
  wrote: string[];
  error_count: number;
  last_error: string | null;
}

interface WorkflowRun {
  created_at: string;
  conclusion: string | null;
  status: string;
}

interface IssueSummary {
  number: number;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  labels: string[];
}

interface CommentSummary {
  id: number;
  body: string;
  login: string;
}

// Module-level throttle state (v2 item 3 / C7: at most one run per interval).
let lastRunMs: number | null = null;

// Test-support: reset / seed the throttle state. Exported so the test suite can
// exercise the throttle deterministically without waiting real time.
export function resetSecurityDetectorThrottle(): void {
  lastRunMs = null;
}

export function setSecurityDetectorLastRunMs(ms: number | null): void {
  lastRunMs = ms;
}

/* ------------------------------------------------------------------ helpers */

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstLine(body: string): string {
  return body.trim().split('\n')[0] ?? '';
}

function parseRun(value: unknown): WorkflowRun | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  return {
    created_at: asString(o.created_at),
    conclusion: typeof o.conclusion === 'string' ? o.conclusion : null,
    status: asString(o.status),
  };
}

function parseIssue(value: unknown): IssueSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.number !== 'number') return null;
  const labels = asArray(o.labels)
    .map(label => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object') {
        const name = (label as Record<string, unknown>).name;
        return typeof name === 'string' ? name : '';
      }
      return '';
    })
    .filter(Boolean);
  return {
    number: o.number,
    title: asString(o.title),
    body: asString(o.body),
    created_at: asString(o.created_at),
    updated_at: asString(o.updated_at) || asString(o.created_at),
    labels,
  };
}

function parseComment(value: unknown): CommentSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const user = o.user && typeof o.user === 'object' ? (o.user as Record<string, unknown>) : null;
  return {
    id: typeof o.id === 'number' ? o.id : 0,
    body: asString(o.body),
    login: user ? asString(user.login) : '',
  };
}

/* ------------------------------------------------------------------- config */

function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

function githubTimeoutMs(): number {
  return Math.max(1000, Number(process.env.DUTY_OFFICER_GITHUB_TIMEOUT_MS) || 15_000);
}

function intervalMs(): number {
  return Number(process.env.DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS) || 21_600_000;
}

function scanWorkflow(): string {
  return envTrim('DUTY_OFFICER_SECURITY_SCAN_WORKFLOW') || 'security-scan.yml';
}

function scanRepos(): string[] {
  const raw = envTrim('DUTY_OFFICER_SECURITY_SCAN_REPOS');
  if (!raw) return DEFAULT_SCAN_REPOS;
  return raw
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function ghRepo(): { owner: string; repo: string } {
  const raw = envTrim('DUTY_OFFICER_GH_REPO') || 'thinmansoftware/bdc-xo';
  const slash = raw.indexOf('/');
  if (slash <= 0) return { owner: 'thinmansoftware', repo: 'bdc-xo' };
  return { owner: raw.slice(0, slash), repo: raw.slice(slash + 1) };
}

function armedAtRaw(): string {
  return envTrim('DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT') || 'unset';
}

function armedAtDate(): Date | null {
  const raw = envTrim('DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function splitRepo(full: string): { owner: string; repo: string } | null {
  const slash = full.indexOf('/');
  if (slash <= 0 || slash === full.length - 1) return null;
  return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
}

/* -------------------------------------------------------------- pure logic */

export function isoWeekUtc(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function isoWeekMondayMs(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (dayNum - 1)); // back to Monday 00:00 UTC
  return date.getTime();
}

export function classifyRuns(runs: WorkflowRun[], now: Date): 'scan_stale' | 'scan_failed' | 'ok' {
  const nowMs = now.getTime();
  const withinWindow = runs.filter(run => {
    const created = Date.parse(run.created_at);
    if (Number.isNaN(created)) return false;
    const age = nowMs - created;
    return age >= 0 && age <= 8 * DAY_MS;
  });
  if (withinWindow.length === 0) return 'scan_stale';
  withinWindow.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return withinWindow[0].conclusion === 'success' ? 'ok' : 'scan_failed';
}

export function receiptValid(body: string, issueCreatedAt: Date, now: Date): boolean {
  if (!body.includes(RECEIPT_MARKER)) return false;
  const match = /posted_at:\s*(\S+)/.exec(body);
  if (!match) return false;
  const posted = new Date(match[1]);
  if (Number.isNaN(posted.getTime())) return false;
  const nowMs = now.getTime();
  if (nowMs - posted.getTime() > 8 * DAY_MS) return false; // older than 8 days
  if (posted.getTime() - nowMs > 5 * 60 * 1000) return false; // more than 5 min in the future
  if (posted.getTime() < issueCreatedAt.getTime()) return false; // earlier than the issue
  return true;
}

export function parseMarker(body: string): Record<string, string> | null {
  if (!body.includes(MARKER_COMMENT)) return null;
  const out: Record<string, string> = {};
  for (const raw of body.split('\n')) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(raw.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function priorityLabel(
  verdict: SecurityDetectorVerdict,
  reasons: DetectorReason[]
): 'prio:P0' | 'prio:P1' | 'prio:P3' | null {
  if (verdict === 'disarmed') return 'prio:P3';
  if (reasons.some(r => P0_CODES.has(r.code))) return 'prio:P0';
  if (reasons.some(r => P1_CODES.has(r.code))) return 'prio:P1';
  return null;
}

function detectorLabels(verdict: SecurityDetectorVerdict, reasons: DetectorReason[]): string[] {
  const labels = [DETECTOR_LABEL];
  const prio = priorityLabel(verdict, reasons);
  if (prio) labels.push(prio);
  return labels;
}

function reasonSummary(reasons: DetectorReason[]): string {
  if (reasons.length === 0) return 'none';
  return reasons.map(r => (r.repo ? `${r.code}:${r.repo}` : r.code)).join(', ');
}

function detectorTitle(reasons: DetectorReason[]): string {
  const parts =
    reasons.length === 0
      ? 'no reasons'
      : reasons.map(r => (r.repo ? `${r.code} (${r.repo})` : r.code)).join(', ');
  return `DETECTOR: security scan -- ${parts}`;
}

function detectorIssueBody(
  verdict: SecurityDetectorVerdict,
  reasons: DetectorReason[],
  evaluatedAt: string,
  buildSha: string,
  armedStr: string
): string {
  const json = JSON.stringify(
    {
      verdict,
      reasons: reasons.map(r => ({ code: r.code, repo: r.repo ?? null, detail: r.detail ?? null })),
      evaluated_at: evaluatedAt,
      build_sha: buildSha,
      armed_at: armedStr,
    },
    null,
    2
  );
  return `${ISSUE_MARKER}\n\nSecurity scan detector state. Do not label this issue ${SCAN_LABEL}.\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

function markerBody(
  evaluatedAt: string,
  buildSha: string,
  armedStr: string,
  verdict: SecurityDetectorVerdict,
  reasons: DetectorReason[]
): string {
  return [
    MARKER_COMMENT,
    `last_run: ${evaluatedAt}`,
    `build_sha: ${buildSha || 'unknown'}`,
    `armed_at: ${armedStr}`,
    `verdict: ${verdict}`,
    `reasons: ${reasonSummary(reasons)}`,
  ].join('\n');
}

function extractIssueJson(body: string): Record<string, unknown> | null {
  const match = /```json\s*([\s\S]*?)```/.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeReasons(reasons: DetectorReason[]): string {
  return JSON.stringify(reasons.map(r => ({ code: r.code, repo: r.repo ?? null })));
}

function normalizeStoredReasons(value: unknown): string {
  return JSON.stringify(
    asArray(value).map(entry => {
      const o = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return { code: asString(o.code), repo: o.repo == null ? null : asString(o.repo) };
    })
  );
}

function sameDetectorState(
  existing: Record<string, unknown> | null,
  verdict: SecurityDetectorVerdict,
  reasons: DetectorReason[],
  buildSha: string,
  armedStr: string
): boolean {
  if (!existing) return false;
  return (
    asString(existing.verdict) === verdict &&
    asString(existing.build_sha) === buildSha &&
    asString(existing.armed_at) === armedStr &&
    normalizeStoredReasons(existing.reasons) === normalizeReasons(reasons)
  );
}

/* ----------------------------------------------------------- GitHub request */

interface GhResponse {
  status: number;
  body: unknown;
  error?: string;
}

async function ghRequest(
  deps: SecurityDetectorDeps,
  token: string,
  method: string,
  path: string,
  bodyObj?: unknown
): Promise<GhResponse> {
  const url = `https://api.github.com${path}`;
  const payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'bdc-harness-duty-officer-security-detector',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await deps.fetchImpl(url, {
        method,
        headers,
        signal: AbortSignal.timeout(githubTimeoutMs()),
        ...(payload !== undefined ? { body: payload } : {}),
      });
      if (response.status >= 500 && attempt === 0) continue; // retry once on 5xx (N7)
      let parsed: unknown = null;
      if (response.status !== 204) {
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
      }
      return { status: response.status, body: parsed };
    } catch (err) {
      if (attempt === 0) continue; // retry once on a network / abort error (N7)
      return {
        status: 0,
        body: null,
        error: `duty_officer_github_network:${(err as Error).message}`,
      };
    }
  }
  return { status: 0, body: null, error: 'duty_officer_github_unreachable' };
}

/* --------------------------------------------------------------- detector */

export async function runSecurityDetector(
  deps: SecurityDetectorDeps
): Promise<SecurityDetectorResult | null> {
  const now = deps.now();
  const nowMs = now.getTime();
  const interval = intervalMs();
  if (lastRunMs !== null && nowMs - lastRunMs < interval) {
    log.info({ interval }, 'duty_officer_security_detector_skipped_throttle');
    return null;
  }
  lastRunMs = nowMs;

  const nowIso = now.toISOString();
  const buildSha = deps.buildSha || 'unknown';
  const armedStr = armedAtRaw();
  const armedDate = armedAtDate();
  const armed = armedDate === null ? true : nowMs >= armedDate.getTime();
  const { owner, repo } = ghRepo();

  const reasons: DetectorReason[] = [];
  const wrote: string[] = [];
  let errorCount = 0;
  let lastError: string | null = null;
  const recordError = (message: string): void => {
    errorCount += 1;
    if (!lastError) lastError = message;
  };
  // A write succeeded only on a 2xx status with no transport error. Any other
  // outcome must surface in error_count / last_error rather than being recorded
  // as a successful `wrote` entry.
  const writeSucceeded = (res: GhResponse): boolean => {
    if (res.error) {
      recordError(res.error);
      return false;
    }
    if (res.status < 200 || res.status >= 300) {
      recordError(`duty_officer_github_http_${res.status}`);
      return false;
    }
    return true;
  };

  const readToken = deps.readToken();
  if (!readToken) {
    recordError('read_token_missing');
    log.error('duty_officer_security_detector_observation_error');
    return {
      verdict: 'observation_error',
      reasons,
      evaluated_at: nowIso,
      marker_home: null,
      wrote,
      error_count: errorCount,
      last_error: lastError,
    };
  }

  // C4 -- scan freshness per repo.
  const allowedReadRepos = new Set(
    [...scanRepos(), `${owner}/${repo}`].map(entry => entry.toLowerCase())
  );
  for (const full of scanRepos()) {
    const parts = splitRepo(full);
    if (!parts) {
      log.warn({ repo: full }, 'duty_officer_github_repo_refused');
      continue;
    }
    if (!allowedReadRepos.has(full.toLowerCase())) {
      log.warn({ repo: full }, 'duty_officer_github_repo_refused');
      continue;
    }
    const path = `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/actions/workflows/${encodeURIComponent(scanWorkflow())}/runs?status=completed&per_page=10`;
    const res = await ghRequest(deps, readToken, 'GET', path);
    if (res.error) {
      recordError(res.error);
      continue;
    }
    if (res.status === 404) {
      reasons.push({
        code: 'scan_missing',
        repo: full,
        detail: 'security scan workflow not found',
      });
      continue;
    }
    if (res.status >= 400) {
      recordError(`duty_officer_github_http_${res.status}`);
      continue;
    }
    const runsRaw =
      res.body && typeof res.body === 'object'
        ? (res.body as Record<string, unknown>).workflow_runs
        : null;
    const runs = asArray(runsRaw)
      .map(parseRun)
      .filter((r): r is WorkflowRun => r !== null);
    const cls = classifyRuns(runs, now);
    if (cls === 'scan_stale') {
      reasons.push({ code: 'scan_stale', repo: full, detail: 'no completed run within 8 days' });
    } else if (cls === 'scan_failed') {
      reasons.push({
        code: 'scan_failed',
        repo: full,
        detail: 'newest completed run did not succeed',
      });
    }
  }

  // C1 -- weekly reports (real reports only: title match + no detector-issue marker, N3).
  const issuesPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&labels=${encodeURIComponent(SCAN_LABEL)}&sort=created&direction=desc&per_page=30`;
  const issuesRes = await ghRequest(deps, readToken, 'GET', issuesPath);
  let reports: IssueSummary[] = [];
  // Any unexpected non-2xx read (401/403/404/5xx/...) is an observation error,
  // never a silent empty result -- a silent empty here yields false alarms.
  if (issuesRes.error || issuesRes.status < 200 || issuesRes.status >= 300) {
    recordError(issuesRes.error ?? `duty_officer_github_http_${issuesRes.status}`);
  } else {
    reports = asArray(issuesRes.body)
      .map(parseIssue)
      .filter((i): i is IssueSummary => i !== null)
      .filter(i => WEEKLY_TITLE_RE.test(i.title) && !i.body.includes(ISSUE_MARKER));
    reports.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  const newestReport = reports[0] ?? null;

  const commentsCache = new Map<number, CommentSummary[]>();
  const getComments = async (issueNumber: number): Promise<CommentSummary[]> => {
    const cached = commentsCache.get(issueNumber);
    if (cached) return cached;
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`;
    const res = await ghRequest(deps, readToken, 'GET', path);
    // Any unexpected non-2xx read (401/403/404/5xx/...) is an observation error,
    // never a silent empty result.
    if (res.error || res.status < 200 || res.status >= 300) {
      recordError(res.error ?? `duty_officer_github_http_${res.status}`);
      commentsCache.set(issueNumber, []);
      return [];
    }
    const comments = asArray(res.body)
      .map(parseComment)
      .filter((c): c is CommentSummary => c !== null);
    commentsCache.set(issueNumber, comments);
    return comments;
  };

  // C5 -- expected report missing (D-6): only after Monday 06:00 UTC of the current ISO week.
  if (nowMs >= isoWeekMondayMs(now) + 6 * 60 * 60 * 1000) {
    const week = isoWeekUtc(now);
    const hasCurrent = reports.some(i => i.title === `Security Scan -- ${week}`);
    if (!hasCurrent) reasons.push({ code: 'report_missing', detail: week });
  }

  // C2 -- unread: any weekly report past its 7-day ack deadline with no ^TRIAGED comment.
  for (const rep of reports) {
    const deadline = Date.parse(rep.created_at) + 7 * DAY_MS;
    if (Number.isNaN(deadline) || nowMs <= deadline) continue;
    const comments = await getComments(rep.number);
    const acked = comments.some(c => TRIAGED_RE.test(firstLine(c.body)));
    if (!acked) {
      reasons.push({
        code: 'unread',
        repo: `#${rep.number}`,
        detail: `report ${rep.number} past ack deadline`,
      });
    }
  }

  // C3 -- host-inventory receipt on the newest weekly report.
  if (newestReport) {
    const comments = await getComments(newestReport.number);
    const created = new Date(newestReport.created_at);
    const valid = comments.some(c => receiptValid(c.body, created, now));
    if (!valid) {
      reasons.push({
        code: 'receipt_missing',
        detail: `no valid host-inventory receipt on #${newestReport.number}`,
      });
    }
  }

  // C6 -- search the single open DETECTOR issue.
  const detectorPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&labels=${encodeURIComponent(DETECTOR_LABEL)}&per_page=30`;
  const detectorRes = await ghRequest(deps, readToken, 'GET', detectorPath);
  let detectorIssue: IssueSummary | null = null;
  // Any unexpected non-2xx read (401/403/404/5xx/...) is an observation error.
  // A silent empty here would create a duplicate DETECTOR issue every run.
  if (detectorRes.error || detectorRes.status < 200 || detectorRes.status >= 300) {
    recordError(detectorRes.error ?? `duty_officer_github_http_${detectorRes.status}`);
  } else {
    detectorIssue =
      asArray(detectorRes.body)
        .map(parseIssue)
        .filter((i): i is IssueSummary => i !== null)
        .find(i => i.body.includes(ISSUE_MARKER)) ?? null;
  }

  // C8 -- verdict.
  let verdict: SecurityDetectorVerdict;
  if (errorCount > 0) verdict = 'observation_error';
  else if (!armed) verdict = 'disarmed';
  else if (reasons.length > 0) verdict = 'alarm';
  else verdict = 'clean';

  // C7 -- marker home: newest weekly report updated within 14 days, else the DETECTOR issue.
  let markerHomeNumber: number | null = null;
  if (newestReport && nowMs - Date.parse(newestReport.updated_at) <= 14 * DAY_MS) {
    markerHomeNumber = newestReport.number;
  }

  let writeToken: string | null = null;
  try {
    const provided = await deps.writeTokenProvider();
    writeToken = provided?.trim() ? provided : null;
  } catch (err) {
    recordError(`app_auth_error:${(err as Error).message}`);
  }

  const finalize = (home: number | null): SecurityDetectorResult => {
    if (verdict === 'observation_error') {
      log.error(
        { reasons: reasons.map(r => r.code), errorCount },
        'duty_officer_security_detector_observation_error'
      );
    } else {
      log.info(
        { verdict, reasons: reasons.map(r => r.code), wrote },
        'duty_officer_security_detector_ran'
      );
    }
    return {
      verdict,
      reasons,
      evaluated_at: nowIso,
      marker_home: home,
      wrote,
      error_count: errorCount,
      last_error: lastError,
    };
  };

  if (!writeToken) {
    if (!lastError) lastError = 'app_auth_missing';
    log.warn('duty_officer_security_detector_write_refused_no_app_auth');
    return finalize(null);
  }
  const appToken: string = writeToken;

  const patchMarker = async (home: number): Promise<void> => {
    const comments = await getComments(home);
    const existing = comments.find(c => c.body.includes(MARKER_COMMENT) && c.login === APP_LOGIN);
    const body = markerBody(nowIso, buildSha, armedStr, verdict, reasons);
    const res = existing
      ? await ghRequest(
          deps,
          appToken,
          'PATCH',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existing.id}`,
          { body }
        )
      : await ghRequest(
          deps,
          appToken,
          'POST',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${home}/comments`,
          { body }
        );
    if (!writeSucceeded(res)) {
      log.warn({ home, status: res.status }, 'duty_officer_security_detector_marker_write_failed');
      return;
    }
    log.info({ home, verdict }, 'duty_officer_security_detector_marker_patched');
    wrote.push('marker');
  };

  const createDetectorIssue = async (): Promise<number | null> => {
    const title = detectorTitle(reasons);
    const body = detectorIssueBody(verdict, reasons, nowIso, buildSha, armedStr);
    const labels = detectorLabels(verdict, reasons);
    const createPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
    let res = await ghRequest(deps, appToken, 'POST', createPath, { title, body, labels });
    if (res.status === 422 && labels.length > 1) {
      // The volatile priority label (prio:P0/P1/P3) may not exist yet (sibling WO
      // creates them, N2). Retry once preserving DETECTOR_LABEL -- dropping it
      // would make this issue invisible to the label-filtered discovery query
      // (C6), causing a duplicate DETECTOR issue on every subsequent run.
      log.warn({ labels }, 'duty_officer_security_detector_label_missing');
      res = await ghRequest(deps, appToken, 'POST', createPath, {
        title,
        body,
        labels: [DETECTOR_LABEL],
      });
    }
    if (res.status >= 200 && res.status < 300) {
      const created = parseIssue(res.body);
      log.info({ number: created?.number ?? null }, 'duty_officer_security_detector_issue_opened');
      wrote.push('issue_opened');
      return created?.number ?? null;
    }
    recordError(`duty_officer_github_http_${res.status}`);
    return null;
  };

  // observation_error: PATCH the marker only; never open/close an issue on a partial read.
  if (verdict === 'observation_error') {
    const home = markerHomeNumber ?? detectorIssue?.number ?? null;
    if (home !== null) await patchMarker(home);
    return finalize(home);
  }

  if (verdict === 'clean') {
    if (detectorIssue) {
      await ghRequest(
        deps,
        appToken,
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${detectorIssue.number}/comments`,
        { body: 'Security scan detector: full evaluation clean and armed; closing.' }
      );
      const closeRes = await ghRequest(
        deps,
        appToken,
        'PATCH',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${detectorIssue.number}`,
        { state: 'closed' }
      );
      if (writeSucceeded(closeRes)) {
        log.info({ number: detectorIssue.number }, 'duty_officer_security_detector_issue_closed');
        wrote.push('issue_closed');
      } else {
        log.warn(
          { number: detectorIssue.number, status: closeRes.status },
          'duty_officer_security_detector_issue_close_failed'
        );
      }
    }
    const home = markerHomeNumber ?? detectorIssue?.number ?? null;
    if (home !== null) await patchMarker(home);
    return finalize(home);
  }

  // alarm or disarmed.
  let homeNumber = markerHomeNumber;
  if (verdict === 'alarm') {
    if (detectorIssue) {
      const existingJson = extractIssueJson(detectorIssue.body);
      if (!sameDetectorState(existingJson, verdict, reasons, buildSha, armedStr)) {
        const updateRes = await ghRequest(
          deps,
          appToken,
          'PATCH',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${detectorIssue.number}`,
          {
            title: detectorTitle(reasons),
            body: detectorIssueBody(verdict, reasons, nowIso, buildSha, armedStr),
            state: 'open',
            labels: detectorLabels(verdict, reasons),
          }
        );
        if (writeSucceeded(updateRes)) {
          log.info(
            { number: detectorIssue.number },
            'duty_officer_security_detector_issue_updated'
          );
          wrote.push('issue_updated');
        } else {
          log.warn(
            { number: detectorIssue.number, status: updateRes.status },
            'duty_officer_security_detector_issue_update_failed'
          );
        }
      }
      if (homeNumber === null) homeNumber = detectorIssue.number;
    } else {
      const created = await createDetectorIssue();
      if (homeNumber === null) homeNumber = created;
    }
  } else {
    // disarmed: create the DETECTOR issue only as a marker home when absent.
    if (!detectorIssue) {
      const created = await createDetectorIssue();
      if (homeNumber === null) homeNumber = created;
    } else if (homeNumber === null) {
      homeNumber = detectorIssue.number;
    }
  }

  if (homeNumber !== null) await patchMarker(homeNumber);
  return finalize(homeNumber);
}
