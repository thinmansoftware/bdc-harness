import {
  resolveGitHubAppAuth,
  resolveRealOctokitAuthOptions,
} from '@archon/overseer/adapters/github-real-deps';
import { createLogger } from '@archon/paths';

const log = createLogger('dispatch/duty-officer-security-detector');
const API = 'https://api.github.com';
const DETECTOR_MARKER = '<!-- security-detector-issue -->';
const COMMENT_MARKER = '<!-- security-detector -->';
const REPORT_TITLE = /^Security Scan -- (\d{4})-W(\d{2})$/;
const PROCESS_RUNS = new WeakMap<object, number>();

export type SecurityDetectorVerdict = 'clean' | 'alarm' | 'disarmed' | 'observation_error';
export interface SecurityDetectorReason {
  code: string;
  repo?: string;
  detail?: string;
}
export interface SecurityDetectorDeps {
  fetchImpl: typeof fetch;
  readToken: () => string | null;
  writeTokenProvider: (signal: AbortSignal) => Promise<string | null>;
  signal?: AbortSignal;
  now: () => Date;
  buildSha: string;
}
export interface SecurityDetectorResult {
  verdict: SecurityDetectorVerdict;
  reasons: SecurityDetectorReason[];
  evaluated_at: string;
  marker_home: number | null;
  wrote: string[];
  last_error?: string;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  created_at: string;
  updated_at: string;
  state?: string;
  labels?: (string | { name?: string })[];
}
interface Comment {
  id: number;
  body?: string | null;
  user?: { login?: string };
}
interface WorkflowRun {
  created_at: string;
  conclusion: string | null;
}

function positiveMs(name: string, fallback: number, floor = 1): number {
  return Math.max(floor, Number(process.env[name]) || fallback);
}

function configuredRepos(): string[] {
  return (
    process.env.DUTY_OFFICER_SECURITY_SCAN_REPOS ??
    'thinmansoftware/shopops,thinmansoftware/lspro-react,thinmansoftware/scout-service,thinmansoftware/bdc-harness'
  )
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function targetRepo(): string {
  return process.env.DUTY_OFFICER_GH_REPO?.trim() || 'thinmansoftware/bdc-xo';
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function assertReadRepo(repo: string): void {
  const allowed = new Set([...configuredRepos(), targetRepo()].map(value => value.toLowerCase()));
  if (!validRepo(repo) || !allowed.has(repo.toLowerCase())) {
    log.warn({ repo }, 'duty_officer_github_repo_refused');
    throw new Error('duty_officer_github_repo_refused');
  }
}

function assertWriteRepo(repo: string): void {
  if (!validRepo(repo) || repo.toLowerCase() !== targetRepo().toLowerCase()) {
    log.warn({ repo }, 'duty_officer_github_repo_refused');
    throw new Error('duty_officer_github_repo_refused');
  }
}

async function request<T>(
  deps: SecurityDetectorDeps,
  repo: string,
  path: string,
  token: string,
  method = 'GET',
  body?: unknown
): Promise<T> {
  if (method === 'GET') assertReadRepo(repo);
  else assertWriteRepo(repo);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      deps.signal?.throwIfAborted();
      const signal = AbortSignal.any([
        ...(deps.signal ? [deps.signal] : []),
        AbortSignal.timeout(positiveMs('DUTY_OFFICER_GITHUB_TIMEOUT_MS', 15_000, 1_000)),
      ]);
      const response = await abortable(
        deps.fetchImpl(`${API}${path}`, {
          method,
          signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'bdc-harness-security-detector',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        signal
      );
      if (!response.ok) {
        const error = new Error(`duty_officer_github_http_${response.status}`);
        if (response.status >= 500 && attempt === 0) {
          lastError = error;
          continue;
        }
        throw error;
      }
      if (response.status === 204) return undefined as T;
      return (await abortable(response.json(), signal)) as T;
    } catch (error) {
      deps.signal?.throwIfAborted();
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 0 && !/http_(?!5\d\d)/.exec(lastError.message)) continue;
      throw lastError;
    }
  }
  throw lastError ?? new Error('duty_officer_github_request_failed');
}

export function parseMarker(body: string): Record<string, string> | null {
  if (!body.includes(COMMENT_MARKER)) return null;
  const result: Record<string, string> = {};
  for (const line of body.split('\n').slice(1)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export function isoWeekUtc(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function classifyRuns(
  runs: WorkflowRun[],
  repo: string,
  now: Date
): SecurityDetectorReason | null {
  const newest = [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!newest || now.getTime() - Date.parse(newest.created_at) > 8 * 86_400_000) {
    return { code: 'scan_stale', repo, detail: 'no completed run within 8 days' };
  }
  if (newest.conclusion !== 'success') {
    return { code: 'scan_failed', repo, detail: newest.conclusion ?? 'unknown conclusion' };
  }
  return null;
}

export function receiptValid(body: string, issueCreatedAt: string, now: Date): boolean {
  if (!body.includes('<!-- host-inventory -->')) return false;
  const match = /^posted_at:\s*(\S+)\s*$/m.exec(body);
  if (!match) return false;
  const posted = Date.parse(match[1]);
  return (
    Number.isFinite(posted) &&
    posted >= Date.parse(issueCreatedAt) &&
    posted >= now.getTime() - 8 * 86_400_000 &&
    posted <= now.getTime() + 5 * 60_000
  );
}

export async function mintAppInstallationToken(signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const config = resolveGitHubAppAuth();
  if (!config) return null;
  const options = resolveRealOctokitAuthOptions();
  if (!('authStrategy' in options)) return null;
  const auth = options.authStrategy(options.auth);
  const app = await auth({ type: 'app' });
  signal.throwIfAborted();
  const response = await abortable(
    fetch(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${app.token}`, Accept: 'application/vnd.github+json' },
    }),
    signal
  );
  if (!response.ok) throw new Error(`duty_officer_github_http_${response.status}`);
  const result = (await abortable(response.json(), signal)) as { token: string };
  return result.token;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
    if (signal.aborted) onAbort();
  });
}

function issueLabels(issue: Issue): string[] {
  return (issue.labels ?? []).map(label =>
    typeof label === 'string' ? label : (label.name ?? '')
  );
}

function mondaySixUtc(now: Date): Date {
  const result = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result;
}

function priority(reasons: SecurityDetectorReason[], verdict: SecurityDetectorVerdict): string {
  if (verdict === 'disarmed') return 'prio:P3';
  return reasons.every(reason => reason.code === 'scan_failed') ? 'prio:P1' : 'prio:P0';
}

function markerBody(result: SecurityDetectorResult, armedAt: string, buildSha: string): string {
  const reasons = result.reasons.length
    ? result.reasons
        .map(reason => `${reason.code}${reason.repo ? `:${reason.repo}` : ''}`)
        .join(',')
    : 'none';
  return `${COMMENT_MARKER}\nlast_run: ${result.evaluated_at}\nbuild_sha: ${buildSha}\narmed_at: ${armedAt}\nverdict: ${result.verdict}\nreasons: ${reasons}`;
}

async function writeWithLabelFallback<T>(
  deps: SecurityDetectorDeps,
  repo: string,
  path: string,
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  try {
    return await request<T>(deps, repo, path, token, method, payload);
  } catch (error) {
    if ((error as Error).message !== 'duty_officer_github_http_422' || !payload.labels) throw error;
    log.warn('duty_officer_security_detector_label_missing');
    const withoutLabels = { ...payload };
    delete withoutLabels.labels;
    return request<T>(deps, repo, path, token, method, withoutLabels);
  }
}

// runSecurityDetector is the clock's deterministic, zero-LLM detector entry point.
export async function runSecurityDetector(
  deps: SecurityDetectorDeps,
  signal: AbortSignal = deps.signal ?? new AbortController().signal
): Promise<SecurityDetectorResult | null> {
  signal.throwIfAborted();
  const now = deps.now();
  const interval = positiveMs('DUTY_OFFICER_SECURITY_DETECTOR_INTERVAL_MS', 21_600_000);
  const previous = PROCESS_RUNS.get(deps as object);
  if (previous !== undefined && now.getTime() - previous < interval) {
    log.info('duty_officer_security_detector_skipped_throttle');
    return null;
  }
  PROCESS_RUNS.set(deps as object, now.getTime());
  const trustedLogins = new Set(
    (
      process.env.DUTY_OFFICER_SECURITY_TRUSTED_LOGINS ??
      'bluedevilcollectibles,thinman-overseer[bot]'
    )
      .split(',')
      .map(login => login.trim().toLowerCase())
      .filter(Boolean)
  );
  deps = { ...deps, signal };
  const evaluatedAt = now.toISOString();
  const armedAt = process.env.DUTY_OFFICER_SECURITY_DETECTOR_ARMED_AT?.trim() || '9999-12-31';
  const armed = now.getTime() >= Date.parse(`${armedAt}T00:00:00Z`);
  const repo = targetRepo();
  const token = deps.readToken();
  const result: SecurityDetectorResult = {
    verdict: armed ? 'clean' : 'disarmed',
    reasons: [],
    evaluated_at: evaluatedAt,
    marker_home: null,
    wrote: [],
  };
  if (!token) {
    result.verdict = 'observation_error';
    result.last_error = 'duty_officer_github_token_missing';
    log.error('duty_officer_security_detector_observation_error');
    return result;
  }

  let issues: Issue[] = [];
  let detector: Issue | undefined;
  let reports: Issue[] = [];
  const comments = new Map<number, Comment[]>();
  const trustedComments = new Map<number, Comment[]>();
  try {
    for (const scanRepo of configuredRepos()) {
      try {
        const workflow =
          process.env.DUTY_OFFICER_SECURITY_SCAN_WORKFLOW?.trim() || 'security-scan.yml';
        const data = await request<{ workflow_runs: WorkflowRun[] }>(
          deps,
          scanRepo,
          `/repos/${scanRepo}/actions/workflows/${encodeURIComponent(workflow)}/runs?status=completed&per_page=10`,
          token
        );
        const reason = classifyRuns(data.workflow_runs, scanRepo, now);
        if (reason) result.reasons.push(reason);
      } catch (error) {
        signal.throwIfAborted();
        if ((error as Error).message === 'duty_officer_github_http_404') {
          result.reasons.push({
            code: 'scan_missing',
            repo: scanRepo,
            detail: 'workflow not found',
          });
        } else {
          result.verdict = 'observation_error';
          result.last_error = (error as Error).message;
          log.error({ err: error }, 'duty_officer_security_detector_observation_error');
        }
      }
    }
    issues = await request<Issue[]>(
      deps,
      repo,
      `/repos/${repo}/issues?state=all&per_page=100`,
      token
    );
    reports = issues
      .filter(issue => REPORT_TITLE.test(issue.title) && !issue.body?.includes(DETECTOR_MARKER))
      .filter(issue => issueLabels(issue).includes('security-scan'))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    detector = issues.find(
      issue =>
        issue.state !== 'closed' &&
        issueLabels(issue).includes('security-detector') &&
        issue.body?.includes(DETECTOR_MARKER)
    );
    const currentWeek = isoWeekUtc(now);
    if (now >= mondaySixUtc(now) && !reports.some(issue => issue.title.endsWith(currentWeek))) {
      result.reasons.push({ code: 'report_missing', detail: currentWeek });
    }
    for (const report of reports) {
      const list = await request<Comment[]>(
        deps,
        repo,
        `/repos/${repo}/issues/${report.number}/comments?per_page=100`,
        token
      );
      comments.set(report.number, list);
      let loggedUntrustedMarker = false;
      const trustedMarkers = list.filter(comment => {
        const body = comment.body ?? '';
        if (!body.includes('<!-- host-inventory -->') && !/^TRIAGED\b/.test(body.split('\n')[0])) {
          return false;
        }
        // Board M-190 J4 (2026-09-23) accepts that all humans and agents share
        // bluedevilcollectibles: this allow-list excludes other collaborators,
        // but cannot distinguish John from an agent on that login. That residual
        // is accepted on the record; the detector's own outputs use App identity.
        if (trustedLogins.has((comment.user?.login ?? '').toLowerCase())) return true;
        if (!loggedUntrustedMarker) {
          log.warn(
            { issue: report.number, login: comment.user?.login ?? null, comment_id: comment.id },
            'duty_officer_security_detector_untrusted_marker_ignored'
          );
          loggedUntrustedMarker = true;
        }
        return false;
      });
      trustedComments.set(report.number, trustedMarkers);
      if (
        now.getTime() > Date.parse(report.created_at) + 7 * 86_400_000 &&
        !trustedMarkers.some(comment => /^TRIAGED\b/.test((comment.body ?? '').split('\n')[0]))
      ) {
        result.reasons.push({ code: 'unread', detail: `issue ${report.number}` });
      }
    }
    const newest = [...reports].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    )[0];
    if (
      !newest ||
      !(trustedComments.get(newest.number) ?? []).some(comment =>
        receiptValid(comment.body ?? '', newest.created_at, now)
      )
    ) {
      result.reasons.push({
        code: 'receipt_missing',
        detail: newest ? `issue ${newest.number}` : 'no weekly report',
      });
    }
  } catch (error) {
    signal.throwIfAborted();
    result.verdict = 'observation_error';
    result.last_error = (error as Error).message;
    log.error({ err: error }, 'duty_officer_security_detector_observation_error');
  }

  if (result.verdict !== 'observation_error') {
    result.verdict = armed ? (result.reasons.length ? 'alarm' : 'clean') : 'disarmed';
  }
  const recentReport = reports.find(
    issue => now.getTime() - Date.parse(issue.updated_at) <= 14 * 86_400_000
  );
  result.marker_home = recentReport?.number ?? detector?.number ?? null;
  let writeToken: string | null;
  try {
    signal.throwIfAborted();
    writeToken = await abortable(deps.writeTokenProvider(signal), signal);
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    result.last_error = (error as Error).message;
    log.error({ err: error }, 'duty_officer_security_detector_write_refused_no_app_auth');
    return result;
  }
  if (!writeToken) {
    result.last_error = 'app_auth_missing';
    log.warn('duty_officer_security_detector_write_refused_no_app_auth');
    return result;
  }

  if (result.verdict !== 'observation_error') {
    const json = {
      verdict: result.verdict,
      reasons: result.reasons,
      evaluated_at: evaluatedAt,
      build_sha: deps.buildSha,
      armed_at: armedAt,
    };
    const titleReasons =
      result.verdict === 'disarmed'
        ? 'disarmed'
        : [...new Set(result.reasons.map(r => r.code))].join(',') || 'clean';
    const body = `${DETECTOR_MARKER}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
    if (result.verdict === 'clean' && detector) {
      await request(
        deps,
        repo,
        `/repos/${repo}/issues/${detector.number}/comments`,
        writeToken,
        'POST',
        {
          body: 'Security detector evaluation is clean; closing the persistent alarm.',
        }
      );
      await request(deps, repo, `/repos/${repo}/issues/${detector.number}`, writeToken, 'PATCH', {
        state: 'closed',
      });
      result.wrote.push('issue_closed');
      log.info('duty_officer_security_detector_issue_closed');
    } else if (result.verdict !== 'clean') {
      const payload = {
        title: `DETECTOR: security scan -- ${titleReasons}`,
        body,
        labels: ['security-detector', priority(result.reasons, result.verdict)],
      };
      if (detector) {
        const existingLabels = issueLabels(detector);
        const sameLabels = payload.labels.every(label => existingLabels.includes(label));
        if (detector.title !== payload.title || detector.body !== payload.body || !sameLabels) {
          await writeWithLabelFallback(
            deps,
            repo,
            `/repos/${repo}/issues/${detector.number}`,
            writeToken,
            'PATCH',
            payload
          );
          result.wrote.push('issue_updated');
          log.info('duty_officer_security_detector_issue_updated');
        }
      } else {
        const created = await writeWithLabelFallback<Issue>(
          deps,
          repo,
          `/repos/${repo}/issues`,
          writeToken,
          'POST',
          payload
        );
        detector = created;
        result.marker_home ??= created.number;
        result.wrote.push('issue_opened');
        log.info('duty_officer_security_detector_issue_opened');
      }
    }
  }

  if (result.marker_home !== null) {
    let list = comments.get(result.marker_home);
    if (!list) {
      list = await request<Comment[]>(
        deps,
        repo,
        `/repos/${repo}/issues/${result.marker_home}/comments?per_page=100`,
        token
      );
    }
    const marker = list.find(
      comment =>
        comment.body?.includes(COMMENT_MARKER) && comment.user?.login === 'thinman-overseer[bot]'
    );
    const payload = { body: markerBody(result, armedAt, deps.buildSha) };
    if (marker) {
      await request(
        deps,
        repo,
        `/repos/${repo}/issues/comments/${marker.id}`,
        writeToken,
        'PATCH',
        payload
      );
    } else {
      await request(
        deps,
        repo,
        `/repos/${repo}/issues/${result.marker_home}/comments`,
        writeToken,
        'POST',
        payload
      );
    }
    result.wrote.push('marker_patched');
    log.info('duty_officer_security_detector_marker_patched');
  }
  log.info({ verdict: result.verdict }, 'duty_officer_security_detector_ran');
  return result;
}
