import { createLogger } from '@archon/paths';
import { runOverseerService } from '@archon/overseer/service';
import type { OverseerServiceOptions, OverseerWiredAdapterKind } from '@archon/overseer/service';
import { PRODUCTION_EFFECT_HOLD_REASON } from '@archon/overseer/merge-manager';

const log = createLogger('server/overseer-runtime');

type OverseerAdapterKind = OverseerWiredAdapterKind;
type OverseerWatcherState = 'stopped' | 'running' | 'degraded';

interface OverseerRuntimeStatus {
  readonly watcher: OverseerWatcherState;
  readonly adapter: OverseerAdapterKind;
  readonly emergency_stop: boolean;
  readonly capability_flags: Readonly<Record<string, boolean>>;
  readonly circuit_states: Readonly<Record<string, string>>;
  readonly blocking_reasons: readonly string[];
}

interface OverseerCapabilityRow {
  readonly capability: string;
  readonly action_enabled: boolean;
  readonly circuit_state: string;
}

interface OverseerRuntimeStatusDeps {
  readonly listCapabilityStates: () => Promise<OverseerCapabilityRow[]>;
}

interface OverseerRuntimeDeps {
  readonly runService?: typeof runOverseerService;
  readonly serviceOptions?: Pick<OverseerServiceOptions, 'deps' | 'mergeCoordinator'>;
}

let watcherTask: Promise<void> | null = null;
let watcherAbort: AbortController | null = null;
let watcherState: OverseerWatcherState = 'stopped';
let adapterKind: OverseerAdapterKind = 'none';

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
  if (watcherTask !== null) {
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

  const controller = new AbortController();
  watcherAbort = controller;
  watcherState = 'running';

  log.info({ adapterKind }, 'overseer_runtime.watcher_starting');

  const runService = deps.runService ?? runOverseerService;
  watcherTask = runService({
    ...deps.serviceOptions,
    signal: controller.signal,
    adapterKind,
    deliveryEnabled: true,
  }).then(
    () => {
      log.info('overseer_runtime.watcher_stopped');
      watcherState = 'stopped';
      watcherTask = null;
      watcherAbort = null;
    },
    (err: unknown) => {
      controller.abort();
      log.error({ err }, 'overseer_runtime.watcher_exception_degraded');
      watcherState = 'degraded';
      watcherTask = null;
      watcherAbort = null;
    }
  );
}

/**
 * Abort and await the owned watcher task. Safe to call when not started.
 */
export async function stopOverseerRuntime(): Promise<void> {
  if (watcherAbort === null && watcherTask === null) {
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
  }

  const emergencyStop = readEmergencyStop();
  const blockingReasons: string[] = [PRODUCTION_EFFECT_HOLD_REASON];
  for (const cap of capabilities) {
    if (!capabilityFlags[cap]) blockingReasons.push(`${cap}:capability_flag_disabled`);
    if (circuitStates[cap] === 'open') blockingReasons.push(`${cap}:circuit_open`);
  }
  if (emergencyStop) blockingReasons.push('emergency_stop');

  return {
    watcher: watcherState,
    adapter: adapterKind,
    emergency_stop: emergencyStop,
    capability_flags: capabilityFlags,
    circuit_states: circuitStates,
    blocking_reasons: blockingReasons,
  };
}
