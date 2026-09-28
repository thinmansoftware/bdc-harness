import { getWorker, type DispatchWorker } from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';
import {
  githubToken,
  githubIssueInAllowList,
  parseGithubSubject,
  type DutyOfficerStaleIssue,
} from './duty-officer-clock';

const log = createLogger('dispatch/worker-heartbeat-alarm');

const GITHUB_API_ORIGIN = 'https://api.github.com';
const ALARM_COMMENT_MAX_PAGES = 20;

export interface WorkerAlarmIssueComment {
  body: string;
  created_at: string;
}

export interface WorkerHeartbeatAlarmDeps {
  getWorker: (workerId: string) => Promise<DispatchWorker | null>;
  postAlarmComment: (issue: DutyOfficerStaleIssue, body: string) => Promise<void>;
  listIssueComments: (issue: DutyOfficerStaleIssue) => Promise<WorkerAlarmIssueComment[]>;
  now?: () => Date;
}

export interface WorkerHeartbeatAlarmConfig {
  enabled: boolean;
  workers: string[];
  staleMinutes: number;
  repeatHours: number;
  issue: string;
}

const DEFAULT_WATCHED_WORKERS = 'dispatch-worker-ASUS-ROG-DSK-2T,overseer-review-worker';
const DEFAULT_ALARM_ISSUE = 'gh:thinmansoftware/bdc-xo#2489';

export function readWorkerHeartbeatAlarmConfig(): WorkerHeartbeatAlarmConfig {
  const workers = (process.env.DISPATCH_WORKER_ALARM_WORKERS ?? DEFAULT_WATCHED_WORKERS)
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  const staleMinutes = Math.max(1, Number(process.env.DISPATCH_WORKER_ALARM_STALE_MINUTES) || 10);
  const repeatHours = Math.max(1, Number(process.env.DISPATCH_WORKER_ALARM_REPEAT_HOURS) || 6);
  return {
    // Default ON: only the literal string 'false' disables the alarm.
    enabled: process.env.DISPATCH_WORKER_ALARM_ENABLED !== 'false',
    workers,
    staleMinutes,
    repeatHours,
    issue: process.env.DISPATCH_WORKER_ALARM_ISSUE?.trim() || DEFAULT_ALARM_ISSUE,
  };
}

/**
 * Classify each watched worker as stale or healthy based purely on the age of
 * its last heartbeat. A missing row (null) is stale -- there is no third state.
 * The worker's own status column is deliberately ignored: a hung process can
 * report 'available' while its heartbeat clock stops.
 */
export function evaluateWorkerHeartbeats(
  workers: { workerId: string; row: DispatchWorker | null }[],
  nowMs: number,
  config: { staleMinutes: number }
): Record<string, 'stale' | 'healthy'> {
  const staleMs = config.staleMinutes * 60_000;
  const result: Record<string, 'stale' | 'healthy'> = {};
  for (const { workerId, row } of workers) {
    if (!row) {
      result[workerId] = 'stale';
      continue;
    }
    const last = Date.parse(row.last_heartbeat_at);
    if (!Number.isFinite(last)) {
      result[workerId] = 'stale';
      continue;
    }
    result[workerId] = nowMs - last > staleMs ? 'stale' : 'healthy';
  }
  return result;
}

function downMarker(workerId: string): string {
  return `<!-- dispatch-worker-alarm:${workerId}:down -->`;
}

function upMarker(workerId: string): string {
  return `<!-- dispatch-worker-alarm:${workerId}:up -->`;
}

function latestMarkerTime(comments: WorkerAlarmIssueComment[], marker: string): number | null {
  let latest: number | null = null;
  for (const comment of comments) {
    if (!(comment.body ?? '').includes(marker)) continue;
    const at = Date.parse(comment.created_at);
    if (!Number.isFinite(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

function restartPointer(): string {
  return "see the restart recipe in this issue's description";
}

function downBody(
  workerId: string,
  lastHeartbeatIso: string | null,
  minutesSilent: number | null
): string {
  const heartbeat =
    lastHeartbeatIso === null ? 'no heartbeat on record' : `last heartbeat ${lastHeartbeatIso} UTC`;
  const silence =
    minutesSilent === null
      ? 'the worker has never registered a heartbeat'
      : `silent for ${minutesSilent} minutes`;
  return (
    `${downMarker(workerId)}\n` +
    `ALARM: Dispatch worker \`${workerId}\` has stopped heartbeating (${silence}; ${heartbeat}). ` +
    `${restartPointer()}.`
  );
}

function upBody(workerId: string, lastHeartbeatIso: string | null): string {
  const heartbeat =
    lastHeartbeatIso === null ? 'heartbeat restored' : `last heartbeat ${lastHeartbeatIso} UTC`;
  return (
    `${upMarker(workerId)}\n` +
    `RECOVERED: Dispatch worker \`${workerId}\` is heartbeating again (${heartbeat}).`
  );
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Fetch every comment on the alarm issue, following Link rel="next" pages.
 * GitHub lists issue comments oldest-first, so a single page would miss the
 * newest marker on a busy issue. Mirrors the pagination in
 * packages/server/src/taskmaster/escalation-delivery.ts listAllIssueComments.
 */
export async function listWorkerAlarmIssueComments(
  issue: DutyOfficerStaleIssue
): Promise<WorkerAlarmIssueComment[]> {
  const token = githubToken();
  if (!token) throw new Error('worker_heartbeat_alarm_token_missing');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'bdc-harness-worker-heartbeat-alarm',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let url: string | null =
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments?per_page=100`;
  const all: WorkerAlarmIssueComment[] = [];
  let pages = 0;
  while (url) {
    if (pages >= ALARM_COMMENT_MAX_PAGES) {
      throw new Error('worker_heartbeat_alarm_comment_pages_exceeded');
    }
    pages += 1;
    const response: Response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      throw new Error(`worker_heartbeat_alarm_http_${response.status}`);
    }
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error('worker_heartbeat_alarm_comments_not_array');
    for (const raw of page) {
      const comment = (raw ?? {}) as { body?: unknown; created_at?: unknown };
      all.push({
        body: typeof comment.body === 'string' ? comment.body : '',
        created_at: typeof comment.created_at === 'string' ? comment.created_at : '',
      });
    }
    url = page.length > 0 ? parseNextLink(response.headers.get('link')) : null;
  }
  return all;
}

/**
 * Post a comment on the alarm issue directly via the GitHub API. Unlike
 * postGithubIssueComment in duty-officer-clock.ts this does NOT consult
 * DUTY_OFFICER_GH_NUDGE and does NOT dedupe against the nudge marker; dedup for
 * the alarm is handled by runWorkerHeartbeatAlarm via listWorkerAlarmIssueComments.
 * The repo allowlist check is preserved.
 */
export async function postWorkerAlarmComment(
  issue: DutyOfficerStaleIssue,
  body: string
): Promise<void> {
  if (!githubIssueInAllowList(issue)) {
    log.warn({ issue }, 'worker_heartbeat_alarm_repo_refused');
    return;
  }
  const token = githubToken();
  if (!token) throw new Error('worker_heartbeat_alarm_token_missing');
  const response = await fetch(
    `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'bdc-harness-worker-heartbeat-alarm',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) {
    throw new Error(`worker_heartbeat_alarm_http_${response.status}`);
  }
}

export function createRealWorkerHeartbeatAlarmDeps(): WorkerHeartbeatAlarmDeps {
  return {
    getWorker,
    postAlarmComment: postWorkerAlarmComment,
    listIssueComments: listWorkerAlarmIssueComments,
    now: () => new Date(),
  };
}

/**
 * Evaluate every watched Dispatch worker and post DOWN / UP alarm comments on
 * the configured issue. Reads env config each call. Never throws: per-worker
 * failures are caught and logged so one bad worker cannot block the others or
 * break the Duty Officer tick.
 */
export async function runWorkerHeartbeatAlarm(deps: WorkerHeartbeatAlarmDeps): Promise<void> {
  const config = readWorkerHeartbeatAlarmConfig();
  if (!config.enabled) {
    log.info('worker_heartbeat_alarm_disabled');
    return;
  }
  if (config.workers.length === 0) {
    log.info('worker_heartbeat_alarm_no_workers');
    return;
  }

  const issue = parseGithubSubject(config.issue);
  if (!issue) {
    log.warn({ issue: config.issue }, 'worker_heartbeat_alarm_issue_invalid');
    return;
  }
  if (!githubIssueInAllowList(issue)) {
    log.warn({ issue }, 'worker_heartbeat_alarm_repo_refused');
    return;
  }
  if (!githubToken()) {
    // Loud, not silent: without a token no alarm can ever fire.
    log.error('worker_heartbeat_alarm_no_token');
    return;
  }

  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();

  const rows = await Promise.all(
    config.workers.map(async workerId => ({
      workerId,
      row: await deps.getWorker(workerId),
    }))
  );
  const rowByWorker = new Map(rows.map(entry => [entry.workerId, entry.row] as const));
  const states = evaluateWorkerHeartbeats(rows, nowMs, { staleMinutes: config.staleMinutes });

  let comments: WorkerAlarmIssueComment[];
  try {
    comments = await deps.listIssueComments(issue);
  } catch (error) {
    log.error({ err: error, issue }, 'worker_heartbeat_alarm_list_comments_failed');
    return;
  }

  const repeatMs = config.repeatHours * 60 * 60 * 1000;

  for (const workerId of config.workers) {
    const state = states[workerId];
    const lastDown = latestMarkerTime(comments, downMarker(workerId));
    const lastUp = latestMarkerTime(comments, upMarker(workerId));
    // A DOWN cycle is "open" when the most recent DOWN marker is newer than the
    // most recent UP marker (or there is no UP yet).
    const activeDown = lastDown !== null && (lastUp === null || lastDown > lastUp);

    try {
      if (state === 'stale') {
        const withinRepeatWindow =
          lastDown !== null &&
          (lastUp === null || lastDown > lastUp) &&
          nowMs - lastDown <= repeatMs;
        if (withinRepeatWindow) continue;
        const row = rowByWorker.get(workerId) ?? null;
        const lastHeartbeatIso = row ? row.last_heartbeat_at : null;
        const minutesSilent = row
          ? Math.max(0, Math.floor((nowMs - Date.parse(row.last_heartbeat_at)) / 60_000))
          : null;
        await deps.postAlarmComment(issue, downBody(workerId, lastHeartbeatIso, minutesSilent));
        log.warn({ workerId, issue }, 'worker_heartbeat_alarm_down_posted');
      } else {
        // Healthy: post one recovery comment only if a DOWN is still open.
        if (!activeDown) continue;
        const row = rowByWorker.get(workerId) ?? null;
        await deps.postAlarmComment(issue, upBody(workerId, row ? row.last_heartbeat_at : null));
        log.info({ workerId, issue }, 'worker_heartbeat_alarm_up_posted');
      }
    } catch (error) {
      log.error({ err: error, workerId, issue }, 'worker_heartbeat_alarm_post_failed');
    }
  }
}
