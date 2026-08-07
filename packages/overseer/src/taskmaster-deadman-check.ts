/**
 * External Taskmaster dead-man checker (WO-HARNESS-TASKMASTER-SLICE1-01,
 * binding condition 5 / Q4).
 *
 * This checker is DELIBERATELY external to the Taskmaster: a health row the
 * Taskmaster observes about itself cannot prove the Taskmaster is alive. It runs
 * in the Overseer package, polls the Taskmaster's own status endpoint
 * (GET /api/taskmaster/status), and on `tick_health === 'degraded'` emits EXACTLY
 * ONE escalation via the injected escalation path, then re-arms only after the
 * Taskmaster recovers to `healthy`.
 *
 * The single-escalation + re-arm behavior is the whole point: a degraded tick
 * that stays degraded must not spray escalations every poll.
 */
import { createLogger } from '@archon/paths';

const log = createLogger('overseer/taskmaster-deadman');

export interface TaskmasterStatus {
  /** Health of the Taskmaster tick loop as reported by GET /api/taskmaster/status. */
  tick_health: 'healthy' | 'degraded';
  pause_state?: string;
  last_heartbeat_at?: number | null;
  [key: string]: unknown;
}

export interface TaskmasterDeadmanDeps {
  /** Fetch the Taskmaster status (typically GET /api/taskmaster/status). */
  fetchStatus: () => Promise<TaskmasterStatus>;
  /** Emit a single escalation for a degraded Taskmaster tick. */
  emitEscalation: (status: TaskmasterStatus) => Promise<void>;
  /** Injected clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

export interface PollResult {
  health: 'healthy' | 'degraded' | 'unknown';
  escalated: boolean;
}

/**
 * Stateful checker. `armed` starts true; a degraded reading while armed emits one
 * escalation and disarms; a subsequent healthy reading re-arms.
 */
export class TaskmasterDeadmanChecker {
  private armed = true;

  constructor(private readonly deps: TaskmasterDeadmanDeps) {}

  /** True when the next degraded reading would escalate. Exposed for tests. */
  get isArmed(): boolean {
    return this.armed;
  }

  async poll(): Promise<PollResult> {
    let status: TaskmasterStatus;
    try {
      status = await this.deps.fetchStatus();
    } catch (err) {
      // A failed poll is NOT a degraded verdict -- surface, do not escalate on it.
      log.warn({ err: err as Error }, 'taskmaster.deadman_status_unavailable');
      return { health: 'unknown', escalated: false };
    }

    if (status.tick_health === 'degraded') {
      if (this.armed) {
        await this.deps.emitEscalation(status);
        this.armed = false;
        log.error(
          { tickHealth: status.tick_health, at: this.deps.now?.() },
          'taskmaster.deadman_escalated'
        );
        return { health: 'degraded', escalated: true };
      }
      // Still degraded but already escalated -- stay quiet until recovery.
      return { health: 'degraded', escalated: false };
    }

    // Healthy: re-arm so the next degradation escalates again.
    if (!this.armed) {
      log.info({ tickHealth: status.tick_health }, 'taskmaster.deadman_rearmed');
    }
    this.armed = true;
    return { health: 'healthy', escalated: false };
  }
}

/**
 * Default production wiring. Polls the Taskmaster status endpoint over HTTP and
 * emits the escalation through the injected `emitEscalation` (the Overseer's
 * existing operator-notification path). Kept thin: the class above carries all
 * the state/decision logic that the SC8 test exercises.
 */
export function createTaskmasterDeadmanChecker(config: {
  statusUrl: string;
  operatorToken?: string;
  emitEscalation: (status: TaskmasterStatus) => Promise<void>;
  now?: () => number;
}): TaskmasterDeadmanChecker {
  return new TaskmasterDeadmanChecker({
    now: config.now,
    emitEscalation: config.emitEscalation,
    fetchStatus: async (): Promise<TaskmasterStatus> => {
      const headers: Record<string, string> = {};
      if (config.operatorToken) headers['x-archon-operator-token'] = config.operatorToken;
      const response = await fetch(config.statusUrl, { headers });
      if (!response.ok) {
        throw new Error(`taskmaster_status_http_${response.status}`);
      }
      return (await response.json()) as TaskmasterStatus;
    },
  });
}
