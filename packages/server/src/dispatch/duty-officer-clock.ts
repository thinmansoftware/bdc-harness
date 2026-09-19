import {
  claimMessage,
  createAuthenticatedMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  releaseMessage,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
  type DispatchSenderContext,
  type DispatchTaskOutcome,
} from '@archon/core/db/dispatch';
import { getCurrentXoLease, type XoLease } from '@archon/core/db/board-authority';
import { createLogger } from '@archon/paths';
import { judgeDutyOfficerItem, type DutyOfficerJudgeVerdict } from './duty-officer-judge';

const log = createLogger('dispatch/duty-officer-clock');

export const DUTY_OFFICER_WORKER_ID = 'duty-officer-clock';
export const DUTY_OFFICER_RECIPIENTS = ['duty-officer', 'do'] as const;
export const DUTY_OFFICER_NUDGE_MARKER = '<!-- duty-officer-nudge -->';
const DUTY_OFFICER_SENDER: DispatchSenderContext = { kind: 'system', sender: 'dispatch' };
const GH_SUBJECT =
  /^gh:([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/i;

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export interface DutyOfficerStaleIssue {
  owner: string;
  repo: string;
  number: number;
}

export interface DutyOfficerClockDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  releaseMessage: typeof releaseMessage;
  createAuthenticatedMessage: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => Promise<unknown>;
  getCurrentXoLease: () => Promise<XoLease | null>;
  listStaleIssues: () => Promise<DutyOfficerStaleIssue[]>;
  postIssueComment: (issue: DutyOfficerStaleIssue, body: string) => Promise<void>;
  judge: (message: DispatchMessage) => Promise<DutyOfficerJudgeVerdict>;
}

function githubToken(): string | null {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return token ? token : null;
}

export function githubNudgeEnabled(): boolean {
  return process.env.DUTY_OFFICER_GH_NUDGE === 'true' && Boolean(githubToken());
}

export function isTaskmasterMailbox(message: DispatchMessage): boolean {
  const subject = message.subject_key ?? '';
  const key = message.idempotency_key ?? '';
  return (
    message.sender === 'taskmaster' ||
    key.startsWith('tm:') ||
    subject.startsWith('digest:') ||
    subject.startsWith('taskmaster:')
  );
}

function namedNextStep(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { next_step?: unknown; nextStep?: unknown };
    const step = parsed.next_step ?? parsed.nextStep;
    if (typeof step === 'string' && step.trim()) return step.trim();
  } catch {
    return null;
  }
  return null;
}

function shouldEscalate(message: DispatchMessage): boolean {
  if (message.task_type === 'run_report') return true;
  if (message.priority === 'blocker') return true;
  return namedNextStep(message.body) === null;
}

function parseGithubSubject(subjectKey: string | null): DutyOfficerStaleIssue | null {
  if (!subjectKey) return null;
  const match = GH_SUBJECT.exec(subjectKey);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function nudgeBody(): string {
  return `${DUTY_OFFICER_NUDGE_MARKER}\nDuty Officer nudge: this item has been idle. The next step is already in the spec or comments. Do not escalate to XO unless blocked.`;
}

async function githubJson<T>(
  path: string,
  options?: { method?: string; extraHeaders?: Record<string, string>; body?: string }
): Promise<T> {
  const token = githubToken();
  if (!token) throw new Error('duty_officer_github_token_missing');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'bdc-harness-duty-officer-clock',
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
  });
  if (!response.ok) {
    throw new Error(`duty_officer_github_http_${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listStaleGithubIssues(): Promise<DutyOfficerStaleIssue[]> {
  if (!githubNudgeEnabled()) {
    log.info('duty_officer_github_nudge_skipped');
    return [];
  }
  const repo = process.env.DUTY_OFFICER_GH_REPO?.trim() || 'thinmansoftware/bdc-xo';
  const slash = repo.indexOf('/');
  if (slash <= 0) {
    log.warn({ repo }, 'duty_officer_github_repo_invalid');
    return [];
  }
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const idleHours = Math.max(1, Number(process.env.DUTY_OFFICER_IDLE_HOURS) || 24);
  const cutoff = Date.now() - idleHours * 60 * 60 * 1000;
  const issues = await githubJson<{ number: number; updated_at: string; pull_request?: unknown }[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=open&labels=${encodeURIComponent('project')}&sort=updated&direction=asc&per_page=20`
  );
  return issues
    .filter(issue => !issue.pull_request && Date.parse(issue.updated_at) < cutoff)
    .map(issue => ({ owner, repo: name, number: issue.number }));
}

function allowedGithubRepo(): { owner: string; repo: string } | null {
  const repo = process.env.DUTY_OFFICER_GH_REPO?.trim() || 'thinmansoftware/bdc-xo';
  const slash = repo.indexOf('/');
  if (slash <= 0) return null;
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) };
}

export async function postGithubIssueComment(
  issue: DutyOfficerStaleIssue,
  body: string
): Promise<void> {
  if (!githubNudgeEnabled()) return;
  const allowed = allowedGithubRepo();
  if (
    !allowed ||
    allowed.owner.toLowerCase() !== issue.owner.toLowerCase() ||
    allowed.repo.toLowerCase() !== issue.repo.toLowerCase()
  ) {
    log.warn({ issue }, 'duty_officer_github_repo_refused');
    return;
  }
  const comments = await githubJson<{ body?: string }[]>(
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments?per_page=30`
  );
  if (comments.some(comment => (comment.body ?? '').includes(DUTY_OFFICER_NUDGE_MARKER))) {
    return;
  }
  await githubJson(
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`,
    {
      method: 'POST',
      extraHeaders: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
}

export function createRealDutyOfficerClockDeps(): DutyOfficerClockDeps {
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    releaseMessage,
    createAuthenticatedMessage,
    getCurrentXoLease,
    listStaleIssues: listStaleGithubIssues,
    postIssueComment: postGithubIssueComment,
    judge: judgeDutyOfficerItem,
  };
}

async function finishItem(
  deps: DutyOfficerClockDeps,
  claimed: DispatchMessage,
  status: 'done' | 'failed',
  task_outcome: DispatchTaskOutcome,
  result: Record<string, unknown>
): Promise<void> {
  await deps.postResult({
    id: claimed.id,
    worker_id: DUTY_OFFICER_WORKER_ID,
    fencing_token: claimed.fencing_token,
    status,
    task_outcome,
    result_body: JSON.stringify(result),
  });
}

async function cueGithubIfPresent(
  deps: DutyOfficerClockDeps,
  message: DispatchMessage
): Promise<void> {
  const issue = parseGithubSubject(message.subject_key);
  if (!issue) return;
  if (!githubNudgeEnabled()) return;
  await deps.postIssueComment(issue, nudgeBody());
}

function escalationSubjectKey(subjectKey: string | null): string | undefined {
  if (!subjectKey) return undefined;
  if (parseGithubSubject(subjectKey)) return subjectKey;
  if (/^wo:WO-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(subjectKey)) return subjectKey;
  if (/^digest:\d{4}-\d{2}-\d{2}$/.test(subjectKey)) return subjectKey;
  return undefined;
}

function mechanicalVerdict(claimed: DispatchMessage): DutyOfficerJudgeVerdict {
  if (isTaskmasterMailbox(claimed)) {
    return {
      status: 'unconfigured',
      action: 'hold',
      reason: 'taskmaster_mailbox',
      body: '',
      failures: [],
    };
  }
  if (shouldEscalate(claimed)) {
    return {
      status: 'unconfigured',
      action: 'escalate_xo',
      reason: 'mechanical_escalate',
      body: claimed.body.slice(0, 500),
      failures: [],
    };
  }
  return {
    status: 'unconfigured',
    action: 'nudge',
    reason: 'mechanical_nudge',
    body: '',
    failures: [],
  };
}

async function escalateToXo(
  deps: DutyOfficerClockDeps,
  claimed: DispatchMessage,
  verdict: DutyOfficerJudgeVerdict
): Promise<void> {
  const excerpt = (verdict.body || claimed.body).slice(0, 500);
  const subjectKey = escalationSubjectKey(claimed.subject_key);
  await deps.createAuthenticatedMessage(DUTY_OFFICER_SENDER, {
    correlation_id: claimed.correlation_id || `do-clock:${claimed.id}`,
    idempotency_key: `do-clock-escalation:${claimed.id}`,
    task_type: 'agent_message',
    recipient: 'xo',
    priority: claimed.priority === 'blocker' ? 'blocker' : 'normal',
    body: JSON.stringify({
      kind: 'duty_officer_escalation',
      source_id: claimed.id,
      task_type: claimed.task_type,
      subject_key: claimed.subject_key,
      transport: verdict.transport ?? null,
      reason: verdict.reason,
      excerpt,
    }),
    ...(subjectKey
      ? { subject_key: subjectKey, repeat_reason: `duty_officer_clock:${claimed.id}` }
      : {}),
  });
}

function holdBackoffMs(): number {
  return Math.max(60_000, Number(process.env.DUTY_OFFICER_HOLD_BACKOFF_MS) || 6 * 60 * 60 * 1000);
}

async function holdItem(deps: DutyOfficerClockDeps, claimed: DispatchMessage): Promise<void> {
  await deps.releaseMessage({
    id: claimed.id,
    worker_id: DUTY_OFFICER_WORKER_ID,
    fencing_token: claimed.fencing_token,
    not_before: new Date(Date.now() + holdBackoffMs()).toISOString(),
  });
}

async function handleClaimed(deps: DutyOfficerClockDeps, claimed: DispatchMessage): Promise<void> {
  let verdict = await deps.judge(claimed);
  if (verdict.status === 'unconfigured') {
    verdict = mechanicalVerdict(claimed);
  }
  if (verdict.status === 'failed') {
    await holdItem(deps, claimed);
    return;
  }
  if (isTaskmasterMailbox(claimed)) {
    if (verdict.action === 'escalate_xo') {
      await escalateToXo(deps, claimed, verdict);
    }
    await holdItem(deps, claimed);
    return;
  }
  if (verdict.action === 'escalate_xo') {
    await escalateToXo(deps, claimed, verdict);
    await finishItem(deps, claimed, 'done', 'succeeded', {
      disposition: 'escalated_to_xo',
      transport: verdict.transport ?? null,
    });
    return;
  }
  if (verdict.action === 'nudge') {
    await cueGithubIfPresent(deps, claimed);
    await finishItem(deps, claimed, 'done', 'succeeded', {
      disposition: 'cued',
      transport: verdict.transport ?? null,
    });
    return;
  }
  await holdItem(deps, claimed);
}

export async function tickDutyOfficerClock(
  deps: DutyOfficerClockDeps = createRealDutyOfficerClockDeps()
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await deps.registerWorker({
      worker_id: DUTY_OFFICER_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: ['run_report', 'agent_message'], principal: 'duty-officer' },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: DUTY_OFFICER_WORKER_ID, status: 'available' });

    const lease = await deps.getCurrentXoLease();
    if (!lease) {
      log.warn('duty_officer_clock_lease_empty');
    }

    const seen = new Set<string>();
    for (const recipient of DUTY_OFFICER_RECIPIENTS) {
      const queued = await deps.listMessages({ recipient, status: 'queued' });
      for (const message of queued) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        try {
          const claimed = await deps.claimMessage({
            id: message.id,
            worker_id: DUTY_OFFICER_WORKER_ID,
          });
          if (!claimed) continue;
          await handleClaimed(deps, claimed);
        } catch (error) {
          log.error({ err: error, messageId: message.id }, 'duty_officer_work_item_failed');
        }
      }
    }

    if (!githubNudgeEnabled()) {
      log.info('duty_officer_github_nudge_skipped');
      return;
    }
    try {
      const stale = await deps.listStaleIssues();
      for (const issue of stale) {
        await deps.postIssueComment(issue, nudgeBody());
      }
    } catch (error) {
      log.error({ err: error }, 'duty_officer_github_nudge_failed');
    }
  } catch (error) {
    log.error({ err: error }, 'duty_officer_clock_tick_failed');
  } finally {
    inFlight = false;
  }
}

export function dutyOfficerClockEnabled(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (process.env.DUTY_OFFICER_CLOCK_ENABLED === 'false') return false;
  return true;
}

export function startDutyOfficerClock(
  deps: DutyOfficerClockDeps = createRealDutyOfficerClockDeps()
): void {
  if (!dutyOfficerClockEnabled() || timer) return;
  void tickDutyOfficerClock(deps);
  const interval = Math.max(1_000, Number(process.env.DUTY_OFFICER_CLOCK_INTERVAL_MS) || 900_000);
  timer = setInterval(() => void tickDutyOfficerClock(deps), interval);
  timer.unref?.();
}

export function stopDutyOfficerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
