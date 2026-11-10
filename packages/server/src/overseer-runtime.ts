import { createLogger } from '@archon/paths';
import { runOverseerService } from '@archon/overseer/service';
import type { OverseerServiceOptions, OverseerWiredAdapterKind } from '@archon/overseer/service';
import { createMergeManager, PRODUCTION_EFFECT_HOLD_REASON } from '@archon/overseer/merge-manager';
import type { MergeManagerDeps } from '@archon/overseer/merge-manager';
import type { OverseerRunStoreDeps } from '@archon/overseer';
import { getOverseerWatchRunById } from '@archon/core/db/overseer';
import { DEFAULT_WATCH_INTERVAL_MS } from '@archon/overseer/watch';
import {
  logDiscoveryConfigurationAtStartup,
  startMergeSweepLivenessMonitor,
  type MergeSweepLivenessMonitor,
} from '@archon/overseer';

const log = createLogger('server/overseer-runtime');

/** Bind the merge gate to the real run/event store, including missing-row detection. */
export function createRuntimeMergeManager(
  deps: MergeManagerDeps & Pick<OverseerRunStoreDeps, 'listRunEvents'>,
  findRun: (runId: string) => Promise<{ id: string } | null> = getOverseerWatchRunById
): ReturnType<typeof createMergeManager> {
  return createMergeManager({
    ...deps,
    readRunEvents: async runId => {
      const run = await findRun(runId);
      if (run?.id !== runId) throw new Error(`originating run ${runId} not found`);
      return deps.listRunEvents(runId);
    },
  });
}

type OverseerAdapterKind = OverseerWiredAdapterKind;
type OverseerWatcherState = 'stopped' | 'running' | 'degraded';

interface OverseerRuntimeStatus {
  readonly status: 'ok' | 'degraded' | 'unknown';
  readonly watcher: OverseerWatcherState;
  readonly adapter: OverseerAdapterKind;
  readonly emergency_stop: boolean;
  readonly capability_flags: Readonly<Record<string, boolean>>;
  readonly circuit_states: Readonly<Record<string, string>>;
  readonly last_action_at: string | null;
  readonly last_verdict_at: string | null;
  readonly blocking_reasons: readonly string[];
}

interface OverseerCapabilityRow {
  readonly capability: string;
  readonly action_enabled: boolean;
  readonly circuit_state: string;
}

interface OverseerRuntimeStatusDeps {
  readonly listCapabilityStates: () => Promise<OverseerCapabilityRow[]>;
  readonly getLastActionAt: () => Promise<string | null>;
  readonly getLastVerdictAt: () => Promise<string | null>;
  readonly countPendingJudgments: () => Promise<number>;
  readonly now?: () => Date;
}

interface RuntimeLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Restart backoff for the watcher supervisor. Defaults: 5 s doubling to a 60 s cap. */
interface OverseerSupervisorOptions {
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** A run this long without failing resets the attempt counter (default 5 minutes). */
  readonly healthyResetMs?: number;
  readonly now?: () => number;
  /** Tests inject a deterministic scheduler; defaults to setTimeout/clearTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface OverseerRuntimeDeps {
  readonly runService?: typeof runOverseerService;
  readonly serviceOptions?: Pick<
    OverseerServiceOptions,
    'deps' | 'mergeCoordinator' | 'mergeBridgeEnabled'
  >;
  readonly logger?: RuntimeLogger;
  readonly supervisor?: OverseerSupervisorOptions;
  /** Tests: replace the liveness monitor starter (default arms the real one). */
  readonly startLivenessMonitor?: () => MergeSweepLivenessMonitor;
}

const DEFAULT_RESTART_BASE_MS = 5_000;
const DEFAULT_RESTART_MAX_MS = 60_000;
const DEFAULT_HEALTHY_RESET_MS = 5 * 60_000;

let watcherTask: Promise<void> | null = null;
let watcherAbort: AbortController | null = null;
let watcherState: OverseerWatcherState = 'stopped';
let adapterKind: OverseerAdapterKind = 'none';
let runtimeLog: RuntimeLogger = log;
let restartTimer: unknown = null;
let restartClear: (handle: unknown) => void = handle => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};
let restartAttempt = 0;
/** True once stopOverseerRuntime ran: a late rejection must not restart anything. */
let intentionalStop = false;
let livenessMonitor: MergeSweepLivenessMonitor | null = null;

function readCapabilityFlag(name: string): boolean {
  const v = process.env[`OVERSEER_${name}_ACTIONS_ENABLED`];
  return v === '1' || v === 'true' || v === 'yes';
}

function readEmergencyStop(): boolean {
  const v = process.env.OVERSEER_EMERGENCY_STOP;
  return v !== '0' && v !== 'false' && v !== 'no';
}

function resolveAdapterKind(): OverseerAdapterKind {
  if (
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === '1' ||
    process.env.OVERSEER_USE_FAKE_GITHUB_ADAPTER === 'true'
  ) {
    return 'fake';
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
  return token.length > 0 ? 'real' : 'none';
}

/**
 * Start at most one AbortSignal-owned watcher task after reconciliation.
 * A second call while the watcher is running is a no-op; the existing task
 * continues. A watcher exception degrades Overseer status without terminating
 * the API process.
 */
export function startOverseerRuntime(deps: OverseerRuntimeDeps = {}): void {
  if (watcherTask !== null || restartTimer !== null) {
    log.info('overseer_runtime.start_skipped_already_running');
    return;
  }

  const enabled =
    process.env.OVERSEER_ENABLED === '1' ||
    process.env.OVERSEER_ENABLED === 'true' ||
    process.env.OVERSEER_ENABLED === 'yes';

  adapterKind = resolveAdapterKind();

  if (!enabled) {
    log.info({ adapterKind }, 'overseer_runtime.start_skipped_disabled');
    watcherState = 'stopped';
    return;
  }

  if (
    adapterKind === 'real' &&
    (!deps.serviceOptions?.deps || !deps.serviceOptions.mergeCoordinator)
  ) {
    watcherState = 'degraded';
    log.error({ adapterKind }, 'overseer_runtime.real_adapter_missing_qualified_coordinator');
    return;
  }
  if (adapterKind === 'none') {
    watcherState = 'degraded';
    log.error({ adapterKind }, 'overseer_runtime.adapter_missing');
    return;
  }

  intentionalStop = false;
  restartAttempt = 0;
  restartTimer = null;
  runtimeLog = deps.logger ?? log;
  watcherState = 'running';

  runtimeLog.info({ adapterKind }, 'overseer_runtime.watcher_starting');
  // Announce the PR-discovery repo list BEFORE the first tick. An unset
  // OVERSEER_MERGE_DISCOVERY_REPOS left the coordinator blind to every open PR
  // for two weeks (2026-09-08..22) with nothing at startup saying so.
  logDiscoveryConfigurationAtStartup();

  // Independent of the watcher: pages the operator when no sweep pass completes
  // for 10 minutes, including when the watcher is dead and between restarts.
  livenessMonitor?.stop();
  livenessMonitor = (deps.startLivenessMonitor ?? startMergeSweepLivenessMonitor)();

  launchService(deps);
}

/**
 * Run the service once and supervise it. When the service promise has SETTLED
 * (rejected, or resolved unexpectedly) and the runtime was not stopped on purpose,
 * restart it after a bounded backoff. Restart happens only after settlement.
 * Before this, a rejection left the watcher, merge bridge and reconcile loop
 * dead until a human restarted the container (2026-11-04: one hour).
 */
function launchService(deps: OverseerRuntimeDeps): void {
  const supervisor = deps.supervisor ?? {};
  const now = supervisor.now ?? ((): number => Date.now());
  const setTimer =
    supervisor.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  restartClear =
    supervisor.clearTimer ??
    ((handle: unknown): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const baseDelayMs = supervisor.baseDelayMs ?? DEFAULT_RESTART_BASE_MS;
  const maxDelayMs = supervisor.maxDelayMs ?? DEFAULT_RESTART_MAX_MS;
  const healthyResetMs = supervisor.healthyResetMs ?? DEFAULT_HEALTHY_RESET_MS;

  const controller = new AbortController();
  watcherAbort = controller;
  watcherState = 'running';
  const startedAt = now();

  // supervisor_settled_guard: the ONLY path that can start another service is the
  // `settled` handler below, which runs only after this promise has actually
  // settled (crashed or exited). Nothing else calls runService or aborts the running
  // service: no timer, watchdog or liveness callback. A HANG never settles, so it
  // reaches the 10-minute liveness alarm and nothing else.
  const settled = (outcome: { err: unknown } | null): void => {
    watcherTask = null;
    watcherAbort = null;
    if (outcome === null && intentionalStop) {
      runtimeLog.info({}, 'overseer_runtime.watcher_stopped');
      watcherState = 'stopped';
      return;
    }
    controller.abort();
    const err = outcome === null ? new Error('overseer_service_exited_unexpectedly') : outcome.err;
    runtimeLog.error({ err }, 'overseer_runtime.watcher_exception_degraded');
    watcherState = 'degraded';
    if (intentionalStop) return;

    if (now() - startedAt >= healthyResetMs) restartAttempt = 0;
    const delayMs = Math.min(baseDelayMs * 2 ** restartAttempt, maxDelayMs);
    restartAttempt += 1;
    runtimeLog.error({ attempt: restartAttempt, delayMs }, 'overseer_runtime.watcher_restarting');
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (intentionalStop) return;
      launchService(deps);
    }, delayMs);
  };

  const runService = deps.runService ?? runOverseerService;
  watcherTask = runService({
    ...deps.serviceOptions,
    signal: controller.signal,
    adapterKind,
    deliveryEnabled: true,
  }).then(
    () => {
      settled(null);
    },
    (err: unknown) => {
      settled({ err });
    }
  );
}

/**
 * Abort and await the owned watcher task. Safe to call when not started.
 */
export async function stopOverseerRuntime(): Promise<void> {
  intentionalStop = true;
  livenessMonitor?.stop();
  livenessMonitor = null;
  const pendingRestart = restartTimer !== null;
  if (restartTimer !== null) {
    restartClear(restartTimer);
    restartTimer = null;
  }
  if (watcherAbort === null && watcherTask === null) {
    if (pendingRestart) {
      watcherState = 'stopped';
      log.info('overseer_runtime.watcher_stopped_and_awaited');
      return;
    }
    log.info('overseer_runtime.stop_skipped_not_running');
    return;
  }

  log.info('overseer_runtime.watcher_stopping');
  watcherAbort?.abort();

  if (watcherTask !== null) {
    try {
      await watcherTask;
    } catch {
      // watcher promise already degraded -- error logged at task-level
    }
  }

  log.info('overseer_runtime.watcher_stopped_and_awaited');
}

/**
 * Return non-secret watcher, adapter, gate, and circuit status.
 * Reads persisted capability/circuit state from the database -- never hardcodes
 * circuits as closed. Falls back to 'unknown' per capability when the DB is
 * unavailable; never maps unknown to 'closed'.
 * Never exposes token values or raw credential material.
 */
export async function getOverseerRuntimeStatus(
  deps: OverseerRuntimeStatusDeps
): Promise<OverseerRuntimeStatus> {
  const capabilities = ['escalation', 'repair', 'branch', 'lifecycle', 'merge'] as const;
  const capabilityFlags: Record<string, boolean> = {};
  const circuitStates: Record<string, string> = {};
  let dependencyReadFailed = false;

  for (const cap of capabilities) {
    capabilityFlags[cap] = readCapabilityFlag(cap.toUpperCase());
    circuitStates[cap] = 'unknown';
  }

  try {
    const states = await deps.listCapabilityStates();
    for (const state of states) {
      circuitStates[state.capability] = state.circuit_state;
      capabilityFlags[state.capability] = state.action_enabled;
    }
  } catch {
    log.warn('overseer_runtime.capability_state_read_failed');
    dependencyReadFailed = true;
  }

  let lastActionAt: string | null = null;
  let lastVerdictAt: string | null = null;
  let pendingJudgments = 0;
  try {
    [lastActionAt, lastVerdictAt, pendingJudgments] = await Promise.all([
      deps.getLastActionAt(),
      deps.getLastVerdictAt(),
      deps.countPendingJudgments(),
    ]);
  } catch {
    log.warn('overseer_runtime.effect_status_read_failed');
    dependencyReadFailed = true;
  }

  const emergencyStop = readEmergencyStop();
  const blockingReasons: string[] = [PRODUCTION_EFFECT_HOLD_REASON];
  for (const cap of capabilities) {
    if (!capabilityFlags[cap]) blockingReasons.push(`${cap}:capability_flag_disabled`);
    if (circuitStates[cap] === 'open') blockingReasons.push(`${cap}:circuit_open`);
  }
  if (emergencyStop) blockingReasons.push('emergency_stop');

  // The watcher polls every minute. Three missed intervals with work waiting is
  // a stall, while an empty backlog is legitimate idle time and must not page.
  const staleThresholdMs = 3 * DEFAULT_WATCH_INTERVAL_MS;
  const effectTimes = [lastActionAt, lastVerdictAt]
    .filter((value): value is string => value !== null)
    .map(value => Date.parse(value))
    .filter(Number.isFinite);
  const lastEffectMs = effectTimes.length > 0 ? Math.max(...effectTimes) : null;
  const effectClockStale =
    pendingJudgments > 0 &&
    (lastEffectMs === null ||
      (deps.now?.().getTime() ?? Date.now()) - lastEffectMs > staleThresholdMs);
  if (effectClockStale) blockingReasons.push('effect_clock_stale_with_pending_judgments');

  const status = dependencyReadFailed
    ? 'unknown'
    : watcherState === 'degraded' || effectClockStale
      ? 'degraded'
      : 'ok';

  return {
    status,
    watcher: watcherState,
    adapter: adapterKind,
    emergency_stop: emergencyStop,
    capability_flags: capabilityFlags,
    circuit_states: circuitStates,
    last_action_at: lastActionAt,
    last_verdict_at: lastVerdictAt,
    blocking_reasons: blockingReasons,
  };
}
