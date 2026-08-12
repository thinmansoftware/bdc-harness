import { createMessage, type DispatchMessage } from '@archon/core/db/dispatch';
import { execFileAsync } from '@archon/git';

export type UsageHeadroomState = 'OK' | 'LOW' | 'UNKNOWN';

interface TaskmasterStatus {
  headroom_state: UsageHeadroomState | null;
}

export interface UsageCapRequeueInput {
  woId: string;
  runId: string;
  repository: string;
}

export interface UsageCapRequeueDeps {
  fetch?: typeof fetch;
  createTask?: typeof createMessage;
  checkAlreadySatisfied?: (repository: string, woId: string) => Promise<boolean>;
  now?: () => Date;
  statusUrl?: string;
  operatorToken?: string;
}

export interface UsageCapRequeueResult {
  outcome: 'ready-now' | 'deferred' | 'skipped-already-satisfied';
  headroomState: UsageHeadroomState;
  message: DispatchMessage;
}

function defaultStatusUrl(): string {
  return (
    process.env.TASKMASTER_STATUS_URL ??
    `http://localhost:${process.env.PORT ?? '3090'}/api/taskmaster/status`
  );
}

async function readHeadroom(deps: UsageCapRequeueDeps): Promise<UsageHeadroomState> {
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(deps.statusUrl ?? defaultStatusUrl(), {
      headers:
        (deps.operatorToken ?? process.env.ARCHON_OPERATOR_TOKEN)
          ? { 'x-archon-operator-token': deps.operatorToken ?? process.env.ARCHON_OPERATOR_TOKEN! }
          : {},
    });
    if (!response.ok) return 'UNKNOWN';
    const status = (await response.json()) as TaskmasterStatus;
    return status.headroom_state ?? 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

async function githubAlreadySatisfied(repository: string, woId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repository,
        '--search',
        woId,
        '--state',
        'all',
        '--json',
        'state,headRefName',
      ],
      { timeout: 15_000 }
    );
    const prs = JSON.parse(stdout) as Array<{ state?: string }>;
    return prs.some(pr => pr.state === 'OPEN' || pr.state === 'MERGED');
  } catch {
    // A failed guard is not proof of satisfaction. The inert record remains operator-gated.
    return false;
  }
}

/**
 * Persist an observable, idempotent usage-cap requeue record.
 * TODO(WO-HARNESS-OVERSEER-USAGE-AWARE-RETRY-01): no not_before poller or real
 * refire adapter is authorized yet; both ready and deferred rows are intentionally inert.
 */
export async function scheduleUsageCapRequeue(
  input: UsageCapRequeueInput,
  deps: UsageCapRequeueDeps = {}
): Promise<UsageCapRequeueResult> {
  const now = deps.now?.() ?? new Date();
  const headroomState = await readHeadroom(deps);
  const alreadySatisfied = await (deps.checkAlreadySatisfied ?? githubAlreadySatisfied)(
    input.repository,
    input.woId
  );
  const outcome = alreadySatisfied
    ? 'skipped-already-satisfied'
    : headroomState === 'OK'
      ? 'ready-now'
      : 'deferred';
  const notBefore =
    outcome === 'deferred' ? new Date(now.getTime() + 15 * 60_000).toISOString() : null;
  const body = JSON.stringify({
    kind: 'overseer_usage_cap_requeue',
    origin: 'overseer-auto',
    wo_id: input.woId,
    run_id: input.runId,
    repository: input.repository,
    headroom_state: headroomState,
    outcome,
    actionable: outcome === 'ready-now',
  });
  const message = await (deps.createTask ?? createMessage)({
    correlation_id: input.runId,
    idempotency_key: `overseer:usage-cap-requeue:${input.woId}`,
    task_type: 'agent_message',
    sender: 'overseer',
    recipient: 'operator',
    body,
    not_before: notBefore,
  });
  return { outcome, headroomState, message };
}
