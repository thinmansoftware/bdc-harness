/**
 * External taskmaster dead-man checker (WO-HARNESS-TASKMASTER-SLICE1-01,
 * binding condition 5 / Q4).
 *
 * Runs in the Overseer package, NOT inside the Taskmaster -- a health row
 * the Taskmaster observes about itself does not satisfy Q4. This module
 * polls GET /api/taskmaster/status and, when tick_health flips to
 * 'degraded', emits exactly ONE escalation for that degradation episode via
 * the existing Overseer escalation path (the dispatch channel used by
 * escalation-delivery.ts: createMessage with sender 'overseer'). A second
 * poll while still degraded emits nothing. Recovery re-arms the checker so
 * a later degradation escalates again.
 */
import { createMessage } from '@archon/core/db/dispatch';
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/taskmaster-deadman');

export type TaskmasterTickHealth = 'healthy' | 'degraded' | 'not_running';

export interface TaskmasterStatusView {
  tick_health: TaskmasterTickHealth;
  pause_state: string;
  epoch: number;
  last_tick_at: string | null;
  interval_ms: number;
}

export interface DeadmanCheckerDeps {
  fetch?: typeof fetch;
  createTask?: typeof createMessage;
  now?: () => Date;
  statusUrl?: string;
  operatorToken?: string;
}

export interface DeadmanCheckerState {
  /** True while an escalation has been emitted for the current episode. */
  escalated: boolean;
  /** Identifier of the degradation episode we escalated for. */
  episodeKey: string | null;
}

export interface DeadmanPollResult {
  tickHealth: TaskmasterTickHealth | 'unreachable';
  escalationSent: boolean;
}

export function createDeadmanCheckerState(): DeadmanCheckerState {
  return { escalated: false, episodeKey: null };
}

function defaultStatusUrl(): string {
  return (
    process.env.TASKMASTER_STATUS_URL ??
    `http://localhost:${process.env.PORT ?? '3090'}/api/taskmaster/status`
  );
}

/**
 * Poll the taskmaster status endpoint once and enforce the
 * exactly-one-escalation-per-episode contract. Mutates `state`.
 */
export async function pollTaskmasterDeadman(
  state: DeadmanCheckerState,
  deps: DeadmanCheckerDeps = {}
): Promise<DeadmanPollResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const createTask = deps.createTask ?? createMessage;
  const now = deps.now ?? ((): Date => new Date());
  const statusUrl = deps.statusUrl ?? defaultStatusUrl();
  const operatorToken = deps.operatorToken ?? process.env.ARCHON_OPERATOR_TOKEN;

  let status: TaskmasterStatusView;
  try {
    const response = await doFetch(statusUrl, {
      headers: operatorToken ? { 'x-archon-operator-token': operatorToken } : {},
    });
    if (!response.ok) {
      log.warn(
        { statusUrl, httpStatus: response.status },
        'overseer.taskmaster_status_read_failed'
      );
      return { tickHealth: 'unreachable', escalationSent: false };
    }
    status = (await response.json()) as TaskmasterStatusView;
  } catch (error) {
    log.warn({ err: error as Error, statusUrl }, 'overseer.taskmaster_status_unreachable');
    return { tickHealth: 'unreachable', escalationSent: false };
  }

  if (status.tick_health !== 'degraded') {
    // Recovery (or not-running) re-arms the checker.
    if (state.escalated) {
      log.info({ tickHealth: status.tick_health }, 'overseer.taskmaster_deadman_rearmed');
    }
    state.escalated = false;
    state.episodeKey = null;
    return { tickHealth: status.tick_health, escalationSent: false };
  }

  // Degraded. Exactly one escalation per episode.
  const episodeKey = `taskmaster-deadman:${status.last_tick_at ?? 'never'}:${status.epoch}`;
  if (state.escalated && state.episodeKey === episodeKey) {
    return { tickHealth: 'degraded', escalationSent: false };
  }

  const nowIso = now().toISOString();
  try {
    await createTask({
      correlation_id: episodeKey,
      idempotency_key: `overseer:${episodeKey}`,
      task_type: 'agent_message',
      sender: 'overseer',
      recipient: 'operator',
      body:
        `Taskmaster dead-man alarm (${nowIso}): tick_health=degraded -- the taskmaster ` +
        `loop has missed 3+ intervals (last_tick_at=${status.last_tick_at ?? 'never'}, ` +
        `interval_ms=${status.interval_ms}, pause_state=${status.pause_state}). ` +
        'A monitor that silently stops is worse than no monitor. Check the archon-app-1 ' +
        'container and GET /api/taskmaster/status.',
    });
    state.escalated = true;
    state.episodeKey = episodeKey;
    log.info({ episodeKey }, 'overseer.taskmaster_deadman_escalated');
    return { tickHealth: 'degraded', escalationSent: true };
  } catch (error) {
    // Escalation failed: stay un-armed so the next poll retries.
    log.error({ err: error as Error, episodeKey }, 'overseer.taskmaster_deadman_escalation_failed');
    return { tickHealth: 'degraded', escalationSent: false };
  }
}
