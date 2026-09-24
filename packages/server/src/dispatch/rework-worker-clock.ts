/**
 * Drains run_rework Dispatch items and fires a direct workflow run that
 * repairs the same pull-request branch.
 */
import {
  claimMessage,
  deferMessage,
  heartbeatWorker,
  listMessages,
  postResult,
  registerWorker,
  releaseMessage,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import { pool } from '@archon/core/db/connection';
import { createLogger } from '@archon/paths';
import {
  createRealReworkDeps,
  escalateRework,
  parseReworkBody,
  type ReworkEnqueueBody,
  type ReworkPullRequest,
} from '@archon/overseer/pr-rework';

const log = createLogger('dispatch/rework-worker-clock');

export const REWORK_CAPABLE_WORKFLOWS = ['bdc-feature-development-codex'] as const;
const REWORK_WORKER_ID = 'overseer-rework-worker';
const REWORK_TASK_TYPE = 'run_rework';
const REWORK_RECIPIENT = 'overseer-rework';
const FIRE_BACKOFF_MS = 5 * 60 * 1000;
const ACTIVE_RUN_DEFER_MS = 10 * 60 * 1000;
const FIRE_ATTEMPT_LIMIT = 3;
const DEFAULT_API_BASE = 'http://localhost:3090';
const DEFAULT_MODEL_OVERRIDE = {
  nodes: {
    implement: { provider: 'cursor', model: 'grok-4.7-high' },
    'diff-repair': { provider: 'cursor', model: 'grok-4.7-high' },
    'opus-repair': { provider: 'cursor', model: 'grok-4.7-high' },
  },
};

export interface ReworkFireRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    conversationId: string;
    message: string;
    modelOverride: typeof DEFAULT_MODEL_OVERRIDE;
  };
}

export interface ReworkWorkerDeps {
  registerWorker: typeof registerWorker;
  heartbeatWorker: typeof heartbeatWorker;
  listMessages: typeof listMessages;
  claimMessage: typeof claimMessage;
  postResult: typeof postResult;
  releaseMessage: typeof releaseMessage;
  deferMessage: typeof deferMessage;
  env?: Record<string, string | undefined>;
  getPullRequest(input: {
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<ReworkPullRequest>;
  hasActiveRun(woId: string): Promise<boolean>;
  fire(request: ReworkFireRequest): Promise<{ status: number; body: unknown }>;
  escalate(input: {
    body: ReworkEnqueueBody;
    reason: string;
    findings: string;
    correlationId: string;
  }): Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

function resolveWorkflow(env: Record<string, string | undefined>): string | null {
  const name = env.OVERSEER_REWORK_WORKFLOW?.trim() || 'bdc-feature-development-codex';
  if (!(REWORK_CAPABLE_WORKFLOWS as readonly string[]).includes(name)) {
    log.error({ workflow: name }, 'overseer_rework_workflow_not_capable');
    return null;
  }
  return name;
}

function resolveModelOverride(
  env: Record<string, string | undefined>
): typeof DEFAULT_MODEL_OVERRIDE | null {
  const raw = env.OVERSEER_REWORK_MODEL_OVERRIDE;
  if (!raw || raw.trim() === '') return DEFAULT_MODEL_OVERRIDE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as typeof DEFAULT_MODEL_OVERRIDE;
  } catch {
    log.error({}, 'overseer_rework_model_override_invalid');
    return null;
  }
}

export function createRealReworkWorkerDeps(): ReworkWorkerDeps {
  const rework = createRealReworkDeps();
  return {
    registerWorker,
    heartbeatWorker,
    listMessages,
    claimMessage,
    postResult,
    releaseMessage,
    deferMessage,
    getPullRequest: input => rework.getPullRequest(input),
    async hasActiveRun(woId: string): Promise<boolean> {
      const result = await pool.query<{ user_message: string }>(
        `SELECT user_message FROM remote_agent_workflow_runs
         WHERE status IN ('pending', 'running')
           AND user_message LIKE $1
         LIMIT 50`,
        [`%WO_ID=${woId}%`]
      );
      const boundary = new RegExp(
        `WO_ID=${woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9-])`
      );
      return result.rows.some(row => boundary.test(row.user_message));
    },
    async fire(request): Promise<{ status: number; body: unknown }> {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    },
    escalate(input): Promise<unknown> {
      return escalateRework(rework, {
        owner: input.body.owner,
        repo: input.body.repo,
        prNumber: input.body.prNumber,
        headSha: input.body.headSha,
        branch: input.body.branch,
        woId: input.body.woId,
        reason: input.reason,
        findings: input.findings,
        correlationId: input.correlationId,
      });
    },
  };
}

function acceptedRunId(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  for (const key of ['runId', 'conversationId', 'id']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  const run = record.run;
  if (run && typeof run === 'object' && typeof (run as { id?: unknown }).id === 'string') {
    return (run as { id: string }).id;
  }
  return '';
}

export async function tickReworkWorkerClock(
  deps: ReworkWorkerDeps = createRealReworkWorkerDeps()
): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const env = deps.env ?? process.env;
    const workflow = resolveWorkflow(env);
    const modelOverride = resolveModelOverride(env);
    if (!workflow || !modelOverride) return;

    await deps.registerWorker({
      worker_id: REWORK_WORKER_ID,
      host: process.env.HOSTNAME ?? 'in-process',
      capabilities: { task_types: [REWORK_TASK_TYPE], principal: REWORK_RECIPIENT },
      max_concurrency: 1,
    });
    await deps.heartbeatWorker({ worker_id: REWORK_WORKER_ID, status: 'available' });

    const messages = (
      await deps.listMessages({ recipient: REWORK_RECIPIENT, status: 'queued' })
    ).filter(message => message.task_type === REWORK_TASK_TYPE);

    for (const message of messages) {
      const handled = await handleReworkItem(message, deps, workflow, modelOverride);
      if (handled) break;
    }
  } catch (error) {
    log.error({ err: error }, 'overseer_rework_worker_tick_failed');
  } finally {
    inFlight = false;
  }
}

async function handleReworkItem(
  message: DispatchMessage,
  deps: ReworkWorkerDeps,
  workflow: string,
  modelOverride: typeof DEFAULT_MODEL_OVERRIDE
): Promise<boolean> {
  const claimed = await deps.claimMessage({ id: message.id, worker_id: REWORK_WORKER_ID });
  if (!claimed) return false;
  const body = parseReworkBody(claimed.body);
  if (!body) {
    await deps.postResult({
      id: claimed.id,
      worker_id: REWORK_WORKER_ID,
      fencing_token: claimed.fencing_token,
      status: 'failed',
      task_outcome: 'failed',
      result_body: JSON.stringify({ reason: 'invalid_rework_body' }),
    });
    return true;
  }

  try {
    const pr = await deps.getPullRequest({
      owner: body.owner,
      repo: body.repo,
      prNumber: body.prNumber,
    });
    if (pr.state !== 'open' || pr.headSha !== body.headSha) {
      await deps.postResult({
        id: claimed.id,
        worker_id: REWORK_WORKER_ID,
        fencing_token: claimed.fencing_token,
        status: 'done',
        task_outcome: 'succeeded',
        result_body: JSON.stringify({ reason: 'superseded_head' }),
      });
      return true;
    }

    if (await deps.hasActiveRun(body.woId)) {
      await deps.deferMessage({
        id: claimed.id,
        worker_id: REWORK_WORKER_ID,
        fencing_token: claimed.fencing_token,
        defer_until: new Date(Date.now() + ACTIVE_RUN_DEFER_MS).toISOString(),
      });
      return true;
    }

    const directive = Buffer.from(
      JSON.stringify({
        prNumber: body.prNumber,
        branch: body.branch,
        headSha: body.headSha,
        reviewMessageId: body.reviewMessageId,
      })
    ).toString('base64url');
    const env = deps.env ?? process.env;
    const apiBase = env.ARCHON_API_BASE_URL?.replace(/\/$/, '') || DEFAULT_API_BASE;
    const request: ReworkFireRequest = {
      url: `${apiBase}/api/workflows/${workflow}/run`,
      headers: {
        'content-type': 'application/json',
        'x-archon-operator-token': env.ARCHON_OPERATOR_TOKEN ?? '',
      },
      body: {
        conversationId: `rework-${body.repo}-${body.prNumber}-${body.headSha.slice(0, 8)}`,
        message: `WO_ID=${body.woId} --project ${body.project} --rework=${directive}`,
        modelOverride,
      },
    };
    const response = await deps.fire(request);
    if (response.status < 200 || response.status >= 300) {
      await failOrBackoff(claimed, body, deps, `http_${response.status}`);
      return true;
    }
    const runId = acceptedRunId(response.body);
    await deps.postResult({
      id: claimed.id,
      worker_id: REWORK_WORKER_ID,
      fencing_token: claimed.fencing_token,
      status: 'done',
      task_outcome: 'succeeded',
      result_body: JSON.stringify({ reason: 'fired', runId }),
    });
    return true;
  } catch (error) {
    log.error({ err: error, messageId: claimed.id }, 'overseer_rework_fire_failed');
    await failOrBackoff(claimed, body, deps, 'transport_error');
    return true;
  }
}

async function failOrBackoff(
  claimed: DispatchMessage,
  body: ReworkEnqueueBody,
  deps: ReworkWorkerDeps,
  detail: string
): Promise<void> {
  // claimMessage increments fencing_token by 1 on each successful claim.
  // releaseMessage does not change it, so the value is this item's fire
  // attempt count (packages/core/src/db/dispatch.ts). The 3-attempt cap
  // depends on that increment staying claim-only.
  if (claimed.fencing_token >= FIRE_ATTEMPT_LIMIT) {
    await deps.postResult({
      id: claimed.id,
      worker_id: REWORK_WORKER_ID,
      fencing_token: claimed.fencing_token,
      status: 'failed',
      task_outcome: 'failed',
      result_body: JSON.stringify({ reason: 'rework_fire_failed', detail }),
    });
    await deps.escalate({
      body,
      reason: 'rework_fire_failed',
      findings: detail,
      correlationId: claimed.correlation_id,
    });
    return;
  }
  await deps.releaseMessage({
    id: claimed.id,
    worker_id: REWORK_WORKER_ID,
    fencing_token: claimed.fencing_token,
    not_before: new Date(Date.now() + FIRE_BACKOFF_MS).toISOString(),
  });
}

export function startReworkWorkerClock(
  deps: ReworkWorkerDeps = createRealReworkWorkerDeps()
): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  void tickReworkWorkerClock(deps);
  const interval = Math.max(
    1_000,
    Number(process.env.OVERSEER_REWORK_WORKER_INTERVAL_MS) || 60_000
  );
  timer = setInterval(() => void tickReworkWorkerClock(deps), interval);
  timer.unref?.();
}

export function stopReworkWorkerClock(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
