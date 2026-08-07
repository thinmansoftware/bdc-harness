/**
 * Taskmaster Slice 1 usage ledger (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * The Taskmaster computes its OWN ledger reading and represents failure as
 * UNKNOWN. It deliberately does NOT consume:
 *  - the `windowTokens = 0` fallback in api.ts (sumWorkflowTokensInWindow):
 *    correct for an auxiliary UI line, fatal for a router -- a failed meter
 *    there is indistinguishable from an empty window;
 *  - the process-scoped `darkEngines` Map in engine-availability.ts:
 *    correct for cooldowns, wrong as durable truth.
 *
 * HARD CONTRACT: currentHeadroom() never returns numeric 0 as available
 * capacity on an error path. Failure is state='UNKNOWN', tokensRemaining
 * null, persisted with is_unknown=1.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createLogger, getArchonHome } from '@archon/paths';
import { recordUsageSample } from '@archon/core/db/taskmaster';

const log = createLogger('taskmaster/ledger');

export type HeadroomState = 'OK' | 'LOW' | 'UNKNOWN';

export interface HeadroomReading {
  state: HeadroomState;
  /** Tokens remaining in the observed window; null when UNKNOWN. */
  tokensRemaining: number | null;
  isUnknown: boolean;
  source: 'local_artifacts' | 'cli_anchor' | 'none';
  observedAt: string;
}

export interface LedgerDeps {
  readLocalArtifacts?: () => Promise<number | null>;
  sampleCliAnchor?: () => Promise<number | null>;
  persistSample?: typeof recordUsageSample;
  now?: () => Date;
  /** Tokens below which state is LOW rather than OK. */
  lowWatermark?: number;
  /** Anchor cadence state; defaults to the process-scoped singleton. */
  anchorCadence?: AnchorCadence;
}

/** Age beyond which a local artifact reading is stale and unusable. */
const ARTIFACT_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_LOW_WATERMARK = 50_000;

/**
 * CLI anchor sampling cadence (spec Section 8): "CLI anchors sampled at
 * startup, every 30min, and after a typed-limit transition." The 60s tick
 * must NOT spawn the anchor probe every pass -- between due samples the last
 * anchor observation is served from cache.
 */
export const ANCHOR_SAMPLE_INTERVAL_MS = 30 * 60_000;

export interface AnchorCadence {
  /** Epoch ms of the last anchor sample ATTEMPT; null = never (startup due). */
  lastAttemptAtMs: number | null;
  /** Last anchor observation (null when the probe failed or is unconfigured). */
  lastValue: number | null;
  /** Last computed headroom state, for typed-limit transition detection. */
  lastState: HeadroomState | null;
  /** Set when a typed-limit transition occurred; forces the next sample. */
  forceNext: boolean;
}

export function createAnchorCadence(): AnchorCadence {
  return { lastAttemptAtMs: null, lastValue: null, lastState: null, forceNext: false };
}

/** Process-scoped cadence used when the caller does not inject one. */
const processAnchorCadence = createAnchorCadence();

/**
 * Record the computed headroom state; a typed-limit transition (OK -> LOW,
 * LOW -> UNKNOWN, ...) arms the cadence so the NEXT reading re-samples the
 * anchor regardless of the 30-minute clock.
 */
function noteHeadroomState(cadence: AnchorCadence, state: HeadroomState): void {
  if (cadence.lastState !== null && cadence.lastState !== state) {
    cadence.forceNext = true;
  }
  cadence.lastState = state;
}

interface UsageArtifact {
  tokensRemaining: number;
  observedAt: string;
}

function parseUsageArtifact(raw: string, nowMs: number): number | null {
  const parsed = JSON.parse(raw) as Partial<UsageArtifact>;
  if (typeof parsed.tokensRemaining !== 'number' || !Number.isFinite(parsed.tokensRemaining)) {
    return null;
  }
  if (typeof parsed.observedAt !== 'string') return null;
  const observedMs = Date.parse(parsed.observedAt);
  if (Number.isNaN(observedMs) || nowMs - observedMs > ARTIFACT_MAX_AGE_MS) return null;
  return parsed.tokensRemaining;
}

/**
 * Read the local usage artifact (written by CLI anchor sampling or by the
 * operator). Returns null when absent, stale, or malformed; THROWS only on
 * unexpected I/O failure -- currentHeadroom() maps both to UNKNOWN.
 */
export async function readLocalArtifacts(nowMs: number = Date.now()): Promise<number | null> {
  const artifactPath =
    process.env.TASKMASTER_USAGE_ARTIFACT ??
    join(getArchonHome(), 'taskmaster', 'usage-anchor.json');
  let raw: string;
  try {
    raw = await readFile(artifactPath, 'utf8');
  } catch {
    return null; // absent artifact is an expected state, not an error
  }
  return parseUsageArtifact(raw, nowMs);
}

/**
 * Sample the CLI anchor: run the operator-configured probe command
 * (TASKMASTER_CLI_ANCHOR_CMD) whose stdout is a number of tokens remaining.
 * Returns null when unconfigured or when the probe fails.
 */
export async function sampleCliAnchor(): Promise<number | null> {
  const cmd = process.env.TASKMASTER_CLI_ANCHOR_CMD;
  if (!cmd || cmd.trim().length === 0) return null;
  try {
    const proc = Bun.spawn(['bash', '-lc', cmd], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch (error) {
    log.warn({ err: error as Error }, 'taskmaster.cli_anchor_sample_failed');
    return null;
  }
}

/**
 * Compute current headroom. Precedence: local artifacts, then CLI anchor.
 * The anchor probe runs ONLY when due (startup, every 30 minutes, or after a
 * typed-limit transition -- spec Section 8); between due samples the cached
 * anchor observation is served. When both readers fail (or throw), the
 * reading is UNKNOWN -- never 0-as-capacity -- and a FRESH failure is
 * persisted as a usage sample with is_unknown=1 (cache-served readings do
 * not persist duplicate observation rows).
 */
export async function currentHeadroom(deps: LedgerDeps = {}): Promise<HeadroomReading> {
  const now = deps.now ?? ((): Date => new Date());
  const persist = deps.persistSample ?? recordUsageSample;
  const lowWatermark = deps.lowWatermark ?? DEFAULT_LOW_WATERMARK;
  const cadence = deps.anchorCadence ?? processAnchorCadence;
  const nowMs = now().getTime();
  const observedAt = new Date(nowMs).toISOString();

  let tokens: number | null = null;
  let source: HeadroomReading['source'] = 'none';
  let freshObservation = false;

  try {
    const local = await (
      deps.readLocalArtifacts ?? ((): Promise<number | null> => readLocalArtifacts(nowMs))
    )();
    if (local !== null) {
      tokens = local;
      source = 'local_artifacts';
      freshObservation = true;
    }
  } catch (error) {
    log.warn({ err: error as Error }, 'taskmaster.ledger_local_artifacts_failed');
  }

  if (tokens === null) {
    const anchorDue =
      cadence.lastAttemptAtMs === null || // startup
      cadence.forceNext || // typed-limit transition
      nowMs - cadence.lastAttemptAtMs >= ANCHOR_SAMPLE_INTERVAL_MS; // 30min
    if (anchorDue) {
      cadence.lastAttemptAtMs = nowMs;
      cadence.forceNext = false;
      freshObservation = true;
      try {
        const anchor = await (deps.sampleCliAnchor ?? sampleCliAnchor)();
        cadence.lastValue = anchor;
        if (anchor !== null) {
          tokens = anchor;
          source = 'cli_anchor';
        }
      } catch (error) {
        cadence.lastValue = null;
        log.warn({ err: error as Error }, 'taskmaster.ledger_cli_anchor_failed');
      }
    } else if (cadence.lastValue !== null) {
      // Not due: serve the cached anchor observation.
      tokens = cadence.lastValue;
      source = 'cli_anchor';
    }
  }

  if (tokens === null) {
    // Failure is UNKNOWN, never zero-as-capacity.
    if (freshObservation) {
      try {
        await persist({
          provider: 'claude',
          window_kind: 'rolling',
          source: 'none',
          value_json: null,
          confidence: 'none',
          is_unknown: true,
        });
      } catch (error) {
        log.warn({ err: error as Error }, 'taskmaster.ledger_unknown_sample_persist_failed');
      }
    }
    noteHeadroomState(cadence, 'UNKNOWN');
    return { state: 'UNKNOWN', tokensRemaining: null, isUnknown: true, source: 'none', observedAt };
  }

  if (freshObservation) {
    try {
      await persist({
        provider: 'claude',
        window_kind: 'rolling',
        source,
        value_json: JSON.stringify({ tokensRemaining: tokens }),
        confidence: source === 'local_artifacts' ? 'high' : 'low',
        is_unknown: false,
      });
    } catch (error) {
      log.warn({ err: error as Error }, 'taskmaster.ledger_sample_persist_failed');
    }
  }

  const state: HeadroomState = tokens < lowWatermark ? 'LOW' : 'OK';
  noteHeadroomState(cadence, state);
  return {
    state,
    tokensRemaining: tokens,
    isUnknown: false,
    source,
    observedAt,
  };
}
