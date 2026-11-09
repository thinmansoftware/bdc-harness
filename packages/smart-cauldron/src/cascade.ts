/**
 * cascade.ts -- Smart Cauldron v1.0 per-run escalation cascade orchestrator.
 *
 * Algorithm:
 *   1. Load ladder + ruleset from config (never hardcoded).
 *   2. Conductor picks entry tier (ruleset table, no model call).
 *   3. Fire WO on entry lane; wait for terminal state; judge via 4-condition gate.
 *   4. PASS -> record win, stop.
 *      FAIL -> build informed-climb context; escalate to next tier.
 *   5. Repeat until frontier (BLOCKED + alert) or a tier wins.
 *   6. Write cascade-runs/ JSON record with per-tier outcome + cost + telemetry.
 *
 * v1.0 is a WRAPPER around existing fire mechanics. It does NOT touch the DAG
 * node executor (@archon/workflows) -- that is explicitly deferred to v1.2.
 *
 * Secret boundary: apiBaseUrl comes from env (ARCHON_API_BASE_URL) or caller.
 * No hardcoded model names or workflow names in this file -- all in config.
 */

import { randomUUID } from 'crypto';
import type { ExpectedSpecIdentity } from '@archon/core/workflows/work-order-source';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadLadder, loadRefusedTiers, loadPremiumTiers, loadMaxClimbsByEntry } from './ladder.js';
import { loadRuleset, pickEntryTier } from './conductor.js';
import { resolveWoSignals } from './wo-signals.js';
import {
  admitClaudeTier,
  chooseHeadroomEntry,
  formatRungSeatSkip,
  resolveEntryThreshold,
  rungSeatSkip,
} from './headroom.js';
import type { EntrySelection, SeatUsageSnapshot } from './headroom.js';
import { fireTier, buildFireMessage } from './fire.js';
import { pollForTerminal, TimeoutError, DEFAULT_OPEN_NODE_BUDGET_MS } from './poll.js';
import { fetchNodeTimeoutsMs } from './node-timeouts.js';
import { judgeGate, classifyAttemptOutcome } from './judge.js';
import { classifyGateMisfire } from './gate-misfire.js';
import { createRecord, writeRecord } from './recorder.js';
export { readCascadeRecord } from './recorder.js';
import type { CreateCascadeRecordResult } from './recorder.js';
import { cancelRun } from './cancel.js';
import {
  findWoClaim,
  listOpenWoPullRequests,
  resolveGithubRepo,
  type OpenWoPullRequest,
  type WoClaim,
} from './already-satisfied.js';
import { acquireWoLock, releaseWoLock } from './wo-lock.js';
import { classifyError, type ErrorClass } from '@archon/overseer/classify';
import { runAuthorizedEscalation } from '@archon/overseer/authorized-escalation';
import { runEscalation } from '@archon/overseer';
import type { M31ActionPermit } from '@archon/overseer/m31-substrate';
import type {
  CascadeRunRecord,
  CascadeAttempt,
  CascadeStatus,
  ConductorRuleset,
  TierName,
  LadderTier,
  GateVerdict,
  FireResult,
  PollResult,
} from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dependency injection interface (for testability)
// ---------------------------------------------------------------------------

export interface CascadeDeps {
  /** Verify that the selected workflow lane is available before any provider fire. */
  preflight?: (tier: LadderTier) => Promise<void>;
  fire?: typeof fireTier;
  poll?: typeof pollForTerminal;
  /**
   * Resolves the fired workflow's per-node configured timeouts for poll's
   * `nodeTimeoutsMs`. Best-effort: returns {} on any failure, which restores
   * the generic open-node default. Injectable so tests do not need the API.
   */
  fetchNodeTimeouts?: typeof fetchNodeTimeoutsMs;
  judge?: typeof judgeGate;
  escalate?: (context: EscalationCallContext) => Promise<void>;
  writeRecord?: typeof writeRecord;
  /** Exclusive admission writer used to make dispatch idempotent across processes. */
  createRecord?: typeof createRecord;
  /** Best-effort cancel of a hung run on progress-timeout. Failure never blocks the climb. */
  cancel?: typeof cancelRun;
  /**
   * SPEC-REPAIR escalation for a frontier (fable) tier gate-fail. Posts the
   * failure evidence + "what must change in the spec" to the WO's GitHub issue
   * (comment + status:blocked label). Injectable for tests. Failure to resolve
   * an issue is surfaced via `posted: false` (caller falls back to escalate).
   */
  specRepair?: (context: SpecRepairCallContext) => Promise<SpecRepairResult>;
  /** Optional dual-supervisor control plane. Absent by default; never starts a live worker. */
  superviseFailure?: (context: SupervisorFailureContext) => Promise<SupervisorFailureResult>;
  /**
   * Already-satisfied / claim check (bdc-xo#1546, M-123 Q5). Returns an open or
   * merged PR that already owns this WO, or null when none / unknown.
   */
  findWoClaim?: (woId: string, project: string) => Promise<WoClaim | null>;
  /**
   * OPEN non-fork PRs that claim this WO. Used to declare a repair target on a
   * climb fire. Defaults to listOpenWoPullRequests (fails open to []).
   */
  listOpenWoPullRequests?: (
    woId: string,
    project: string,
    options?: OpenWoPullRequestLookupOptions
  ) => Promise<OpenWoPullRequest[]>;
  /** Exclusive active-cascade lock per woId+project. */
  acquireWoLock?: typeof acquireWoLock;
  releaseWoLock?: typeof releaseWoLock;
  /**
   * WO spec reader for routing signals (risk tags, Rung classification, entry
   * pin). Defaults to a `gh api` read of docs/work-orders/<WO-ID>.md on bdc-xo
   * main; returns null when unreadable (the ruleset pick then stands).
   */
  readWoSpec?: (woId: string) => Promise<string | null>;
  /**
   * Conductor ruleset override (skips loadRuleset() config read). Used to
   * exercise entry-tier selection deterministically -- e.g. a ruleset that
   * resolves directly onto a premium tier so the frontier-approval gate is
   * reached with zero prior attempts (no entryOverride). Ignored when
   * entryOverride is set (that already skips the conductor).
   */
  ruleset?: ConductorRuleset;
  /**
   * Live subscription-seat snapshot. When absent, the conductor reads its own
   * Fuelglass seats route. A rejection or timeout becomes an UNKNOWN snapshot.
   */
  seatUsage?: () => Promise<SeatUsageSnapshot>;
  /**
   * Run-start seat cutoff percent (the Fuelglass seats route `cutoff.percent`).
   * When absent, the conductor uses the cutoff from its own seats read. A
   * rejection, timeout or null means UNKNOWN: no rung is skipped on seat
   * grounds (WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01).
   */
  seatCutoff?: () => Promise<number | null>;
  /**
   * Read a run's detail for the prior-teardown wait (WO-HARNESS-REPAIR-HOLDER-
   * TEARDOWN-01). Each read is bounded by the overall wait deadline.
   */
  readRunDetail?: (runId: string) => Promise<PriorRunDetail | null>;
  /** Overall prior-teardown wait (default SMART_CAULDRON_TEARDOWN_WAIT_MS or 180000). */
  teardownWaitMs?: number;
  /** Poll interval for the prior-teardown wait (default 5000). */
  teardownPollMs?: number;
}

export interface PriorRunDetail {
  readonly status?: string | null;
  readonly completed_at?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

const PRE_DEPLOY_CONFIRM_AGE_MS = 600_000;

/**
 * True when a run's error or terminal cause says the repair checkout failed
 * (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01 item 8): climbing cannot free a held branch.
 */
export function isCheckoutFailedNoClimb(poll: PollResult): boolean {
  const md = poll.rawMetadata ?? {};
  if (md.terminal_cause === 'repair_checkout_failed') return true;
  const error = typeof md.error === 'string' ? md.error : '';
  return (
    error.includes('repair_gate_closed: checkout_failed') ||
    error.includes('repair_target_branch_held')
  );
}

export type PriorTeardownVerdict = 'confirmed' | 'survivors' | 'timeout';

function parseUtcMs(value: string): number {
  const hasTz = /[zZ]$|[+-][0-9]{2}:?[0-9]{2}$/.test(value);
  return new Date(hasTz ? value : `${value.replace(' ', 'T')}Z`).getTime();
}

/**
 * Wait for the prior run's metadata.teardown_confirmed_at before firing the next
 * tier. Every read is raced against the deadline, so a read whose body never
 * completes still ends by the deadline. A prior row with neither teardown key
 * that completed more than 600 s ago counts as confirmed (pre-deploy runs).
 */
export async function waitForPriorTeardown(
  runId: string,
  opts: {
    readonly read: (runId: string) => Promise<PriorRunDetail | null>;
    /** The prior attempt's terminal poll snapshot, checked before any read. */
    readonly initial?: PriorRunDetail | null;
    readonly waitMs: number;
    readonly pollMs: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  }
): Promise<PriorTeardownVerdict> {
  const now = opts.now ?? ((): number => Date.now());
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)));
  const deadline = now() + opts.waitMs;
  if (opts.initial?.metadata) {
    const md = opts.initial.metadata;
    const survivors = md.teardown_survivors;
    if (Array.isArray(survivors) && survivors.length > 0) return 'survivors';
    if (typeof md.teardown_confirmed_at === 'string') return 'confirmed';
  }
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detail = await Promise.race([
      opts.read(runId).catch(() => null),
      new Promise<'deadline'>(r => {
        timer = setTimeout(() => {
          r('deadline');
        }, remaining);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (detail === 'deadline') return 'timeout';
    if (detail) {
      const md = detail.metadata ?? {};
      const survivors = md.teardown_survivors;
      if (Array.isArray(survivors) && survivors.length > 0) return 'survivors';
      if (typeof md.teardown_confirmed_at === 'string') return 'confirmed';
      if (
        !('teardown_survivors' in md) &&
        typeof detail.completed_at === 'string' &&
        now() - parseUtcMs(detail.completed_at) > PRE_DEPLOY_CONFIRM_AGE_MS
      ) {
        return 'confirmed';
      }
    }
    const left = deadline - now();
    if (left <= 0) return 'timeout';
    await sleep(Math.min(opts.pollMs, left));
  }
}

async function defaultReadRunDetail(
  runId: string,
  apiBaseUrl: string,
  token: string,
  doFetch: typeof fetch = fetch
): Promise<PriorRunDetail | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 15_000);
  try {
    const res = await doFetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}`, {
      headers: { 'x-archon-operator-token': token },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { run?: PriorRunDetail };
    return body.run ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SEAT_USAGE_READ_TIMEOUT_MS = 5000;
const DEFAULT_FUELGLASS_TIMEOUT_MS = 12_000;

const UNKNOWN_SEAT_USAGE: SeatUsageSnapshot = {
  claude: { limit_source: 'UNKNOWN', windows: [] },
  codex: { limit_source: 'UNKNOWN', windows: [] },
  cursor: { limit_source: 'UNKNOWN', windows: [] },
};

function parseFuelglassSeatUsage(value: unknown): SeatUsageSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const seats = (value as { seats?: unknown }).seats;
  if (typeof seats !== 'object' || seats === null) return null;
  const snapshot: SeatUsageSnapshot = {};
  for (const seat of ['claude', 'codex', 'cursor'] as const) {
    const raw = (seats as Record<string, unknown>)[seat];
    if (typeof raw !== 'object' || raw === null) return null;
    const reading = raw as Record<string, unknown>;
    if (reading.limit_source !== 'measured' && reading.limit_source !== 'UNKNOWN') return null;
    if (!Array.isArray(reading.windows)) return null;
    const windows = reading.windows.map(window => {
      if (typeof window !== 'object' || window === null) return null;
      const candidate = window as Record<string, unknown>;
      if (
        typeof candidate.name !== 'string' ||
        typeof candidate.used_percent !== 'number' ||
        !Number.isFinite(candidate.used_percent)
      ) {
        return null;
      }
      return { name: candidate.name, used_percent: candidate.used_percent };
    });
    if (windows.some(window => window === null)) return null;
    if (reading.limit_reached !== undefined && typeof reading.limit_reached !== 'boolean') {
      return null;
    }
    const credits = reading.credits as Record<string, unknown> | undefined;
    snapshot[seat] = {
      limit_source: reading.limit_source,
      windows: windows.filter(window => window !== null),
      ...(typeof reading.limit_reached === 'boolean'
        ? { limit_reached: reading.limit_reached }
        : {}),
      ...(typeof credits === 'object' &&
      credits !== null &&
      typeof credits.has_credits === 'boolean'
        ? {
            credits: {
              has_credits: credits.has_credits,
              overage_limit_reached: credits.overage_limit_reached === true,
            },
          }
        : {}),
    };
  }
  return snapshot;
}

/** The run-start cutoff from a Fuelglass seats response, or null when absent/invalid. */
export function parseFuelglassSeatCutoff(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const cutoff = (value as { cutoff?: unknown }).cutoff;
  if (typeof cutoff !== 'object' || cutoff === null) return null;
  const percent = (cutoff as { percent?: unknown }).percent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  if (percent < 1 || percent > 95) return null;
  return percent;
}

function defaultFuelglassSeatReader(
  apiBaseUrl: string,
  token: string,
  onCutoff: (percent: number | null) => void = () => undefined,
  doFetch: typeof fetch = fetch
): () => Promise<SeatUsageSnapshot> {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, DEFAULT_FUELGLASS_TIMEOUT_MS);
    try {
      const response = await doFetch(`${apiBaseUrl.replace(/\/$/, '')}/api/fuelglass/seats`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) return UNKNOWN_SEAT_USAGE;
      const body: unknown = await response.json();
      const parsed = parseFuelglassSeatUsage(body);
      if (parsed) onCutoff(parseFuelglassSeatCutoff(body));
      return parsed ?? UNKNOWN_SEAT_USAGE;
    } catch {
      return UNKNOWN_SEAT_USAGE;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Read seat usage with a fixed timeout. A rejection or timeout becomes UNKNOWN
 * and logs exactly one failure line. A late reader result after timeout is ignored.
 */
async function readSeatUsageOrUnknown(
  read: () => Promise<SeatUsageSnapshot>
): Promise<SeatUsageSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  try {
    return await new Promise<SeatUsageSnapshot>(resolve => {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.log('[smart-cauldron] seat usage unavailable: timeout');
        resolve(UNKNOWN_SEAT_USAGE);
      }, SEAT_USAGE_READ_TIMEOUT_MS);
      Promise.resolve()
        .then(() => read())
        .then(
          value => {
            if (settled) return;
            settled = true;
            resolve(value);
          },
          () => {
            if (settled) return;
            settled = true;
            console.log('[smart-cauldron] seat usage unavailable: rejected');
            resolve(UNKNOWN_SEAT_USAGE);
          }
        );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SupervisorFailureContext {
  woId: string;
  cascadeId: string;
  tierName: TierName;
  runId: string | null;
  reason: string;
  failureKind: 'frontier-gate' | 'infrastructure';
}

export interface SupervisorFailureResult {
  handled: boolean;
  ownerId: string | null;
  fencingToken: number | null;
  evidenceRefs: string[];
}

export interface EscalationCallContext {
  errorClass: ErrorClass;
  woId: string;
  reason: string;
  remediation?: string[];
  runId?: string | null;
  overseerPermit?: M31ActionPermit;
  sourceEventId: string;
  sourceEventCreatedAt: string;
  repository: string;
}

export interface SpecRepairCallContext {
  woId: string;
  tierName: TierName;
  failReason: string;
  runId: string | null;
  /** Full, human-readable failure evidence (gate reasons, verdict, run id). */
  evidence: string;
  /** Concrete "what must change in the spec" statement -- the fix-loop handoff. */
  whatMustChange: string;
}

export interface SpecRepairResult {
  /** true when the WO's GitHub issue received the comment + status:blocked label. */
  posted: boolean;
  issueRepo: string | null;
  issueNumber: number | null;
}

// ---------------------------------------------------------------------------
// Main cascade options
// ---------------------------------------------------------------------------

export interface RunCascadeOptions {
  woId: string;
  /** Constrain each lane's canonical spec to the identity checked before dispatch. */
  expectedSpec?: ExpectedSpecIdentity;
  /** Stable caller-supplied dispatch identity. Replays return the existing durable record. */
  dispatchId?: string;
  /** Resolves only after the initial record is durable; used by async API dispatch. */
  onAdmission?: (record: CascadeRunRecord, created: boolean) => void;
  /**
   * Called the moment a tier's dispatch is proven and its run id discovered,
   * BEFORE any terminal-state polling. Lets a caller persist run custody while
   * the run is still running or paused. A throwing callback never affects the
   * cascade.
   */
  onRunDiscovered?: (runId: string, cascadeId: string, tierName: string) => void;
  /**
   * Passed through to the poller: a normally-terminal status that is a
   * transitional hand-off for this run (see pollForTerminal). Absent by default,
   * so every existing caller behaves exactly as before.
   */
  isTransitionalStatus?: (detail: import('./poll.js').PollRunDetail) => boolean;
  /** Await durable automatic-fire permission after preflight, before admission/effects. */
  beforeAdmission?: () => Promise<import('@archon/core/db/taskmaster').AutomaticFireProvenance>;
  woClass?: string;
  tags?: string[];
  /**
   * GitHub issue labels for this WO. Labels that name money/billing, auth/
   * security/RLS/roles or migrations add the matching risk tag to the conductor
   * ruleset input (WO-HARNESS-CONDUCTOR-RISK-ROUTING-01), keeping the WO off
   * the zero tier.
   */
  labels?: string[];
  /** Override the entry tier (skips conductor ruleset). */
  entryOverride?: TierName;
  /**
   * Seed the informed-climb context of the FIRST attempt. Used only when
   * resuming an approved frontier-approval pause (WO-HARNESS-FRONTIER-CLIMB-
   * APPROVAL-GATE-01): the preserved packet's priorContext is replayed in so the
   * resumed premium fire still carries the informed-climb text it would have had.
   * Default null (normal fires build priorContext as they climb).
   */
  initialPriorContext?: string | null;
  /** Archon API base URL. Defaults to ARCHON_API_BASE_URL env or http://localhost:3090. */
  apiBaseUrl?: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env in callees. */
  token?: string;
  /**
   * Transport for Archon API reads/writes. Defaults to global fetch. The
   * in-process T3 command consumer passes the server's own in-process API
   * dispatcher here so no network self-call is made.
   */
  fetchImpl?: typeof fetch;
  /** Codebase shortname for explicit workflow binding. Required for live fires. */
  project?: string;
  /** Output directory for cascade-runs/ records. Default: ./cascade-runs. */
  outDir?: string;
  /** Dry-run: print which tier would be picked, do not fire. */
  dryRun?: boolean;
  /** M-31 permit required before default escalation side effects can run. */
  overseerPermit?: M31ActionPermit;
  /** Dependency injection (for testing). */
  deps?: CascadeDeps;
  /**
   * Hard ceiling per attempt in ms. Default: 14400000 (4 hours). Runaway backstop
   * only -- the normal stop condition is `pollStallTimeoutMs`.
   */
  pollTimeoutMs?: number;
  /**
   * Stall budget per attempt in ms -- how long a run may emit NOTHING before it
   * is judged stuck and the cascade climbs. Default: 1200000 (20 minutes).
   */
  pollStallTimeoutMs?: number;
  /** Poll interval per attempt in ms. Default: 30000 (30 seconds). */
  pollIntervalMs?: number;
  /**
   * Bypass the already-satisfied guard for this run. Defaults to the
   * SMART_CAULDRON_ALLOW_CLAIMED env var when omitted (bdc-xo#2140: the
   * CLI --allow-satisfied flag wires here explicitly).
   */
  allowClaimed?: boolean;
}

// ---------------------------------------------------------------------------
// Cascade orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the Smart Cauldron per-run escalation cascade.
 *
 * Fires the WO on the cheapest appropriate tier first; climbs on gate-fail.
 * Writes a cascade-runs/ JSON record and returns the complete CascadeRunRecord.
 */
export async function runCascade(opts: RunCascadeOptions): Promise<CascadeRunRecord> {
  const {
    woId,
    dispatchId,
    onAdmission,
    woClass,
    tags,
    entryOverride: callerEntryOverride,
    dryRun = false,
    outDir = './cascade-runs',
    pollTimeoutMs = 14_400_000,
    pollStallTimeoutMs = 1_200_000,
    pollIntervalMs = 30_000,
    token,
    project,
  } = opts;

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.ARCHON_API_BASE_URL ?? 'http://localhost:3090';
  const operatorToken = token ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
  const fetchImpl = opts.fetchImpl;

  // Inject real implementations unless overridden (for testing)
  const fireImpl = opts.deps?.fire ?? fireTier;
  const preflightImpl = opts.deps?.preflight;
  const pollImpl = opts.deps?.poll ?? pollForTerminal;
  const fetchNodeTimeoutsImpl = opts.deps?.fetchNodeTimeouts ?? fetchNodeTimeoutsMs;
  const judgeImpl = opts.deps?.judge ?? judgeGate;
  const escalateImpl = opts.deps?.escalate ?? defaultEscalate;
  const writeRecordImpl = opts.deps?.writeRecord ?? writeRecord;
  const createRecordImpl =
    opts.deps?.createRecord ??
    (opts.deps?.writeRecord
      ? async (
          record: CascadeRunRecord,
          recordOutDir: string
        ): Promise<CreateCascadeRecordResult> => ({
          created: true,
          path: await writeRecordImpl(record, recordOutDir),
          record,
        })
      : createRecord);
  const cancelImpl = opts.deps?.cancel ?? cancelRun;
  const specRepairImpl = opts.deps?.specRepair ?? defaultSpecRepair;
  const superviseFailureImpl = opts.deps?.superviseFailure;
  const findWoClaimImpl =
    opts.deps?.findWoClaim ??
    ((id: string, proj: string): Promise<WoClaim | null> =>
      findWoClaim({ woId: id, project: proj }));
  const listOpenWoPullRequestsImpl =
    opts.deps?.listOpenWoPullRequests ??
    ((
      id: string,
      proj: string,
      lookupOptions?: OpenWoPullRequestLookupOptions
    ): Promise<OpenWoPullRequest[]> =>
      listOpenWoPullRequests({ woId: id, project: proj, ...lookupOptions }));
  const acquireWoLockImpl = opts.deps?.acquireWoLock ?? acquireWoLock;
  const releaseWoLockImpl = opts.deps?.releaseWoLock ?? releaseWoLock;
  const readRunDetailImpl =
    opts.deps?.readRunDetail ??
    ((id: string): Promise<PriorRunDetail | null> =>
      defaultReadRunDetail(id, apiBaseUrl, operatorToken, fetchImpl));
  const configuredTeardownWait = Number.parseInt(
    process.env.SMART_CAULDRON_TEARDOWN_WAIT_MS ?? '',
    10
  );
  const teardownWaitMs =
    opts.deps?.teardownWaitMs ??
    (Number.isInteger(configuredTeardownWait) && configuredTeardownWait > 0
      ? configuredTeardownWait
      : 180_000);
  const teardownPollMs = opts.deps?.teardownPollMs ?? 5000;
  const allowClaimed =
    opts.allowClaimed ??
    (process.env.SMART_CAULDRON_ALLOW_CLAIMED === '1' ||
      process.env.SMART_CAULDRON_ALLOW_CLAIMED === 'true');

  // Load config from files (never from inline constants)
  const tiers = loadLadder();
  const ruleset = opts.deps?.ruleset ?? loadRuleset();
  const refusedTiers = loadRefusedTiers();
  const premiumTiers = loadPremiumTiers();
  // Fence 3 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01): per-entry climb cap.
  // Keyed by the cascade's resolved entry tier; a tier absent here has no limit.
  const maxClimbsByEntry = loadMaxClimbsByEntry();

  // Routing signals the WO declares about itself (WO-HARNESS-CONDUCTOR-RISK-
  // ROUTING-01): risk tags from labels + spec text, and an optional entry-tier
  // pin in the spec frontmatter. An explicit --entry skips this read entirely.
  const woSignals = callerEntryOverride
    ? null
    : await resolveWoSignals({
        woId,
        labels: opts.labels,
        readSpec: opts.deps?.readWoSpec,
      });
  if (woSignals && woSignals.reasons.length > 0) {
    console.log(`[smart-cauldron] WO routing signals for ${woId}: ${woSignals.reasons.join('; ')}`);
  } else if (woSignals && !woSignals.specRead) {
    console.log(
      `[smart-cauldron] WO routing signals for ${woId}: spec unreadable, using caller class/tags only`
    );
  }
  // A spec pin is a human-authored entry choice and behaves like --entry (the
  // refused-tier check and the seat gate treat it as pinned). Unknown tier names
  // are ignored with a log rather than silently routing somewhere unintended.
  let specPin: TierName | undefined;
  const riskRoutingTags = [...new Set([...(tags ?? []), ...(woSignals?.riskTags ?? [])])];
  if (woSignals?.entryPin) {
    if (premiumTiers.includes(woSignals.entryPin)) {
      // A pin onto a premium tier would skip the frontier-approval gate, which
      // only an explicit operator --entry may do. A spec cannot approve itself.
      console.log(
        `[smart-cauldron] Ignoring spec entry pin "${woSignals.entryPin}": premium tiers need ` +
          'operator approval or an explicit --entry'
      );
    } else if (tiers.some(t => t.name === woSignals.entryPin)) {
      // A pin may raise the entry tier but never lower it below what the ruleset
      // gives the WO: its class, the caller's tags AND the risk detected in the
      // spec. A billing/auth/migration spec, a caller-tagged auth WO or an INFRA WO
      // pinning zero would otherwise defeat the routing this exists for.
      const riskFloor = pickEntryTier({ woClass, tags: riskRoutingTags }, ruleset);
      const pinIndex = tiers.findIndex(t => t.name === woSignals.entryPin);
      const floorIndex = tiers.findIndex(t => t.name === riskFloor);
      if (floorIndex !== -1 && pinIndex < floorIndex) {
        console.log(
          `[smart-cauldron] Ignoring spec entry pin "${woSignals.entryPin}": below the risk ` +
            `floor "${riskFloor}" for this WO's class, tags and detected risk`
        );
      } else {
        specPin = woSignals.entryPin;
      }
    } else {
      console.log(
        `[smart-cauldron] Ignoring spec entry pin "${woSignals.entryPin}": not a ladder tier ` +
          `(${tiers.map(t => t.name).join(', ')})`
      );
    }
  }
  const entryOverride: TierName | undefined = callerEntryOverride ?? specPin;
  const routingTags = riskRoutingTags;

  // Conductor: pick entry tier (ruleset), or honor explicit --entry override
  let entryTierName = entryOverride ?? pickEntryTier({ woClass, tags: routingTags }, ruleset);

  // Dark/retired lanes are never live entry points. An explicit --entry onto a
  // refused tier is an operator error and throws; a RULESET pick that lands on a
  // refused tier promotes up the ladder to the first non-refused tier (the entry
  // floor -- John 2026-08-25: OpenRouter rungs defunded, codex is the floor).
  if (refusedTiers.includes(entryTierName)) {
    if (entryOverride) {
      throw new Error(
        `[smart-cauldron/cascade] Refused dark/retired entry tier "${entryTierName}". ` +
          'This lane is listed in refusedTiers and cannot be selected as a live entry point. ' +
          `Canonical ladder: ${tiers.map(t => t.name).join(' -> ')}. ` +
          `Refused: ${refusedTiers.join(', ')}`
      );
    }
    const pickedIndex = tiers.findIndex(t => t.name === entryTierName);
    const promoted = tiers
      .slice(pickedIndex === -1 ? 0 : pickedIndex)
      .find(t => !refusedTiers.includes(t.name));
    if (!promoted) {
      throw new Error(
        `[smart-cauldron/cascade] Ruleset picked refused tier "${entryTierName}" and no ` +
          `non-refused tier exists above it. Refused: ${refusedTiers.join(', ')}`
      );
    }
    console.log(
      `[smart-cauldron] Entry tier "${entryTierName}" is refused; promoting entry to ` +
        `"${promoted.name}" (entry floor)`
    );
    entryTierName = promoted.name;
  }

  const thresholdPercent = resolveEntryThreshold(process.env);
  let seatCutoffPercent: number | null = null;
  const seatUsage = opts.deps?.seatUsage
    ? await readSeatUsageOrUnknown(opts.deps.seatUsage)
    : await defaultFuelglassSeatReader(
        apiBaseUrl,
        operatorToken,
        percent => {
          seatCutoffPercent = percent;
        },
        fetchImpl
      )();
  if (opts.deps?.seatCutoff) {
    try {
      seatCutoffPercent = await opts.deps.seatCutoff();
    } catch {
      seatCutoffPercent = null;
    }
  }
  let entrySelection: EntrySelection = chooseHeadroomEntry({
    picked: entryTierName,
    tiers,
    refusedTiers,
    premiumTiers,
    usage: seatUsage,
    thresholdPercent,
    pinned: entryOverride !== undefined,
  });
  entryTierName = entrySelection.entry;

  if (entryTierName === 'claude') {
    const admission = admitClaudeTier({ usage: seatUsage, thresholdPercent });
    if (!admission.admitted && entryOverride === 'claude') {
      throw new Error(
        `[smart-cauldron/cascade] Refused Claude entry tier "claude": ${admission.reason}. ` +
          'The Claude seat must be measured below the entry headroom threshold.'
      );
    }
    if (!admission.admitted) {
      const claudeIndex = tiers.findIndex(tier => tier.name === 'claude');
      const promoted = tiers.slice(claudeIndex + 1).find(tier => !refusedTiers.includes(tier.name));
      if (!promoted) {
        throw new Error(
          `[smart-cauldron/cascade] Claude entry denied (${admission.reason}) and no ` +
            'admissible tier exists above it.'
        );
      }
      console.log(
        `[smart-cauldron] Skipping tier "claude" during entry: ${admission.reason}; ` +
          `promoting to "${promoted.name}"`
      );
      entryTierName = promoted.name;
      entrySelection = {
        ...entrySelection,
        entry: promoted.name,
        changed: promoted.name !== entrySelection.picked,
        reason: admission.reason,
      };
    } else {
      entrySelection = { ...entrySelection, reason: admission.reason };
    }
  }
  // Seat-cutoff rung skip at entry (WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01):
  // a rung whose own seat is measured at or over the run-start cutoff would be
  // refused by the gate. A pinned entry is honored (the gate decides it).
  if (entryOverride === undefined) {
    const skipped: string[] = [];
    let idx = tiers.findIndex(tier => tier.name === entryTierName);
    while (idx !== -1 && idx < tiers.length) {
      const tier = tiers[idx];
      if (!tier) break;
      if (refusedTiers.includes(tier.name)) {
        idx++;
        continue;
      }
      const seatSkip = rungSeatSkip(tier.name, seatUsage, seatCutoffPercent);
      if (seatSkip) {
        console.log(
          `[smart-cauldron] Skipping tier "${tier.name}" during entry: ${formatRungSeatSkip(seatSkip)}`
        );
        skipped.push(formatRungSeatSkip(seatSkip));
        idx++;
        continue;
      }
      if (skipped.length > 0 && tier.name === 'claude') {
        const claudeAdmission = admitClaudeTier({ usage: seatUsage, thresholdPercent });
        if (!claudeAdmission.admitted) {
          console.log(
            `[smart-cauldron] Skipping tier "claude" during entry: ${claudeAdmission.reason}`
          );
          skipped.push(claudeAdmission.reason);
          idx++;
          continue;
        }
      }
      break;
    }
    if (skipped.length > 0) {
      const landed = idx === -1 ? undefined : tiers[idx];
      if (!landed) {
        throw new Error(
          `[smart-cauldron/cascade] Every rung from "${entryTierName}" up is over the seat ` +
            `cutoff or denied (${skipped.join(', ')}); no rung can pass the run-start seat gate.`
        );
      }
      entryTierName = landed.name;
      entrySelection = {
        ...entrySelection,
        entry: landed.name,
        changed: landed.name !== entrySelection.picked,
        reason: skipped[0] ?? entrySelection.reason,
      };
    }
  }
  console.log(
    `[smart-cauldron] entry selection: ${entrySelection.reason} ` +
      `picked=${entrySelection.picked} entry=${entrySelection.entry}`
  );

  let currentIndex = tiers.findIndex(t => t.name === entryTierName);
  if (currentIndex === -1) {
    throw new Error(
      `[smart-cauldron/cascade] Entry tier "${entryTierName}" not found in ladder. ` +
        `Available tiers: ${tiers.map(t => t.name).join(', ')}`
    );
  }

  const cascadeId = dispatchId ?? randomUUID();
  const createdAt = new Date().toISOString();

  // Dry-run: just log and return a stub record
  if (dryRun) {
    const selectedTier = tiers[currentIndex];
    if (selectedTier) {
      console.log(
        `[smart-cauldron] DRY RUN: woId=${woId} entry=${selectedTier.name} ` +
          `workflow=${selectedTier.workflowName}`
      );
    }
    const record: CascadeRunRecord = {
      cascadeId,
      woId,
      project: project ?? null,
      request: {
        woClass: woClass ?? null,
        tags: [...(tags ?? [])].sort(),
        entryOverride: entryOverride ?? null,
        dryRun: true,
      },
      createdAt,
      status: 'planned',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: entryTierName,
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
      entrySelection,
    };
    const admission = await createRecordImpl(record, outDir);
    onAdmission?.(admission.record, admission.created);
    return admission.record;
  }

  if (!project) {
    throw new Error(
      '[smart-cauldron/cascade] --project is required for cascade fires (explicit codebase binding; no silent fallback allowed).'
    );
  }

  // WO-level exclusive lock (bdc-xo#1546): cascadeId admission alone does not
  // stop two different cascades from racing the same WO.
  const woLock = await acquireWoLockImpl(woId, project, cascadeId, outDir);
  if (!woLock.acquired) {
    console.log(
      `[smart-cauldron] REFUSING duplicate cascade for woId=${woId} project=${project}: ` +
        `active cascadeId=${woLock.record.cascadeId}`
    );
    const blocked: CascadeRunRecord = {
      cascadeId,
      woId,
      project,
      request: {
        woClass: woClass ?? null,
        tags: [...(tags ?? [])].sort(),
        entryOverride: entryOverride ?? null,
        dryRun: false,
      },
      createdAt,
      status: 'blocked',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: entryTierName,
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
      entrySelection,
    };
    onAdmission?.(blocked, false);
    return blocked;
  }

  // Already-satisfied / claim check before any provider spend (M-123 Q5 / #1546).
  if (!allowClaimed) {
    const existingClaim = await findWoClaimImpl(woId, project);
    if (existingClaim) {
      console.log(
        `[smart-cauldron] ALREADY SATISFIED woId=${woId}: PR #${existingClaim.number} ` +
          `[${existingClaim.state}] ${existingClaim.url} -- skipping cascade`
      );
      const refused: CascadeRunRecord = {
        cascadeId,
        woId,
        project,
        request: {
          woClass: woClass ?? null,
          tags: [...(tags ?? [])].sort(),
          entryOverride: entryOverride ?? null,
          dryRun: false,
        },
        createdAt,
        status: 'refused',
        winningTier: null,
        attempts: [],
        totalCostUsd: null,
        telemetry: {
          entryTier: entryTierName,
          climbed: false,
          climbCount: 0,
          wonCheap: false,
        },
        entrySelection,
        refusalReason: {
          reason: 'already-satisfied',
          prNumber: existingClaim.number,
          prState: existingClaim.state,
          prUrl: existingClaim.url,
          checkedAtTier: null,
        },
      };
      const admissionEarly = await createRecordImpl(refused, outDir);
      onAdmission?.(admissionEarly.record, admissionEarly.created);
      await releaseWoLockImpl(woId, project, cascadeId, outDir);
      return admissionEarly.record;
    }
  }

  // Cascade loop
  const attempts: CascadeAttempt[] = [];
  try {
    const emitEscalation = async (
      context: Omit<EscalationCallContext, 'sourceEventId' | 'sourceEventCreatedAt' | 'repository'>
    ): Promise<void> => {
      // The last recorded attempt is the natural source event for an escalation.
      // The frontier-approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01)
      // can pause with zero prior attempts when the conductor resolves entry
      // directly onto a premium tier; synthesize a stable source event from the
      // cascade identity rather than dropping the operator notice.
      const sourceAttempt = attempts.at(-1);
      await escalateImpl({
        ...context,
        sourceEventId: sourceAttempt?.sourceEventId ?? `${cascadeId}:frontier-gate`,
        sourceEventCreatedAt: sourceAttempt?.sourceEventAt ?? createdAt,
        repository: project ?? 'thinmansoftware/bdc-harness',
      });
    };
    // Normally null; seeded on an approved frontier-approval resume so the
    // premium fire carries the informed-climb text preserved in the packet.
    let priorContext: string | null = opts.initialPriorContext ?? null;
    let climbCount = 0;
    let status: CascadeStatus = 'running';
    let winningTier: TierName | null = null;
    let specRepairRecord: CascadeRunRecord['specRepair'];
    let supervisorRecoveryRecord: CascadeRunRecord['supervisorRecovery'];
    let frontierApprovalRecord: CascadeRunRecord['frontierApproval'];
    let refusalReason: CascadeRunRecord['refusalReason'];
    let gateMisfireRecord: CascadeRunRecord['gateMisfire'];
    let blockedReason: CascadeRunRecord['blockedReason'];
    let repairTargetAlternates: CascadeRunRecord['repairTargetAlternates'];
    let priorPollSnapshot: PriorRunDetail | null = null;
    let currentPollSnapshot: PriorRunDetail | null = null;
    let automaticPreflightTier: string | null = null;

    function buildCurrentRecord(): CascadeRunRecord {
      const entryTier: TierName = attempts[0]?.tier ?? entryTierName;
      const climbed = climbCount > 0;
      return {
        cascadeId,
        ...(automaticFireAdmission ? { automaticFireAdmission } : {}),
        woId,
        project: project ?? null,
        request: {
          woClass: woClass ?? null,
          tags: [...(tags ?? [])].sort(),
          entryOverride: entryOverride ?? null,
          dryRun: false,
        },
        createdAt,
        status,
        winningTier,
        attempts,
        totalCostUsd: computeTotalCost(attempts),
        telemetry: {
          entryTier,
          climbed,
          climbCount,
          wonCheap: status === 'won' && !climbed,
        },
        ...(specRepairRecord ? { specRepair: specRepairRecord } : {}),
        ...(supervisorRecoveryRecord ? { supervisorRecovery: supervisorRecoveryRecord } : {}),
        ...(frontierApprovalRecord ? { frontierApproval: frontierApprovalRecord } : {}),
        ...(refusalReason ? { refusalReason } : {}),
        ...(gateMisfireRecord ? { gateMisfire: gateMisfireRecord } : {}),
        ...(blockedReason ? { blockedReason } : {}),
        ...(entrySelection ? { entrySelection } : {}),
        ...(repairTargetAlternates ? { repairTargetAlternates } : {}),
      };
    }

    async function checkpoint(): Promise<string> {
      return writeRecordImpl(buildCurrentRecord(), outDir);
    }

    function nextAdmittedTierIndex(fromIndex: number, context: 'climb' | 'peek'): number {
      let idx = fromIndex + 1;
      while (idx < tiers.length) {
        const candidate = tiers[idx];
        if (!candidate) return tiers.length;
        if (refusedTiers.includes(candidate.name)) {
          console.log(
            `[smart-cauldron] Skipping refused tier "${candidate.name}" during ${context}`
          );
          idx++;
          continue;
        }
        const seatSkip = rungSeatSkip(candidate.name, seatUsage, seatCutoffPercent);
        if (seatSkip) {
          console.log(
            `[smart-cauldron] Skipping tier "${candidate.name}" during ${context}: ` +
              formatRungSeatSkip(seatSkip)
          );
          idx++;
          continue;
        }
        if (candidate.name === 'claude') {
          const admission = admitClaudeTier({ usage: seatUsage, thresholdPercent });
          console.log(
            `[smart-cauldron] Claude tier decision during ${context}: ${admission.reason}`
          );
          if (!admission.admitted) {
            idx++;
            continue;
          }
        }
        return idx;
      }
      return tiers.length;
    }

    // Persist admission before any provider lane can be fired. A duplicate dispatch
    // returns the existing record and cannot create a second provider attempt.
    if (opts.beforeAdmission && preflightImpl) {
      const firstTier = tiers[currentIndex];
      if (!firstTier) throw new Error('automatic_fire_entry_tier_missing');
      await preflightImpl(firstTier);
      automaticPreflightTier = firstTier.name;
    }
    const automaticFireAdmission = await opts.beforeAdmission?.();
    const admission = await createRecordImpl(buildCurrentRecord(), outDir);
    onAdmission?.(admission.record, admission.created);
    if (!admission.created) return admission.record;

    /**
     * Shared climb/frontier logic for both the gate-fail path and the
     * progress-timeout path (see the poll try/catch below). Escalates + marks
     * BLOCKED if the failing tier is the frontier or tiers are exhausted;
     * otherwise advances currentIndex/climbCount to the next tier.
     *
     * @param currentTier The tier that just failed (gate-fail or progress-timeout).
     * @param failReason  Human-readable reason (verdict.reason, or the fixed
     *                    progress-timeout message -- there is no GateVerdict for
     *                    a run that never reached a terminal state).
     * @param runId       runId for the escalation context (may be null).
     * @returns true if the cascade loop should stop (caller must break), false
     *          to keep climbing.
     */
    async function climbOrStop(
      currentTier: LadderTier,
      failReason: string,
      runId: string | null
    ): Promise<boolean> {
      if (currentTier.isFrontier) {
        if (superviseFailureImpl) {
          const recovery = await superviseFailureImpl({
            woId,
            cascadeId,
            tierName: currentTier.name,
            runId,
            reason: failReason,
            failureKind: 'frontier-gate',
          });
          if (recovery.handled && recovery.ownerId !== null && recovery.fencingToken !== null) {
            supervisorRecoveryRecord = {
              ownerId: recovery.ownerId,
              fencingToken: recovery.fencingToken,
              evidenceRefs: recovery.evidenceRefs,
            };
            status = 'recovery-delegated';
            return true;
          }
        }
        // Top rung (fable) failed the gate. Per John's 2026-07-02 doctrine ruling
        // ("Fable is the last escalation before failure -- a WO should never fail,
        // it should be able to be fixed"), this is NOT a terminal BLOCKED dead end.
        // Emit a SPEC-REPAIR escalation: post the failure evidence + a concrete
        // "what must change in the spec" statement to the WO's GitHub issue (comment
        // + status:blocked label) so the WO re-enters at the authoring layer.
        const evidence = buildSpecRepairEvidence(currentTier, failReason, runId, attempts);
        const whatMustChange = buildWhatMustChange(currentTier, failReason);

        let result: SpecRepairResult;
        try {
          result = await specRepairImpl({
            woId,
            tierName: currentTier.name,
            failReason,
            runId,
            evidence,
            whatMustChange,
          });
        } catch (specErr) {
          // A thrown spec-repair impl (e.g. gh totally unavailable) must not swallow
          // the escalation -- treat as "not posted" and fall through to the alert.
          console.log(
            `[smart-cauldron] SPEC-REPAIR impl threw for woId=${woId}: ` +
              `${(specErr as Error).message} (falling back to escalate/alert)`
          );
          result = { posted: false, issueRepo: null, issueNumber: null };
        }

        if (!result.posted) {
          // Mode Behavior Matrix row 4: no GitHub issue resolvable -> fall back to the
          // existing escalate/alert path with the spec-repair text in the payload.
          // The escalation must NEVER be silently dropped.
          await emitEscalation({
            errorClass: 'validator_rejected',
            woId,
            reason:
              `SPEC-REPAIR (no GitHub issue resolved) -- frontier tier ${currentTier.name} ` +
              `gate-failed: ${failReason}`,
            remediation: [whatMustChange, evidence],
            runId,
            overseerPermit: opts.overseerPermit,
          });
        }

        specRepairRecord = {
          issueRepo: result.issueRepo,
          issueNumber: result.issueNumber,
          posted: result.posted,
          whatMustChange,
          evidence,
        };
        status = 'spec-repair';
        console.log(
          `[smart-cauldron] SPEC-REPAIR: frontier tier gate-failed for woId=${woId} ` +
            `(issue posted=${result.posted})`
        );
        return true;
      }

      // Fence 3 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01): one climb, then stop.
      // If this cascade's ENTRY tier has a maxClimbsByEntry limit and firing the
      // next rung would push climbCount past it, stop BLOCKED with reason
      // climb_limit_reached and escalate once -- do NOT fire another rung. A
      // failing cheap-lane run must not climb into expensive seats (Grok fence 3:
      // "One climb, then stop... a Codex 429 must not fall through onto Claude.").
      const entryClimbLimit = maxClimbsByEntry[entryTierName];
      if (typeof entryClimbLimit === 'number' && climbCount >= entryClimbLimit) {
        status = 'blocked';
        blockedReason = 'climb_limit_reached';
        console.log(
          `[smart-cauldron] BLOCKED climb_limit_reached: entry tier "${entryTierName}" allows ` +
            `${entryClimbLimit} climb(s); tier=${currentTier.name} gate-failed and no further ` +
            `rung will be fired for woId=${woId}`
        );
        await emitEscalation({
          errorClass: 'validator_rejected',
          woId,
          reason:
            `CLIMB LIMIT REACHED -- entry tier "${entryTierName}" allows ${entryClimbLimit} ` +
            `climb(s). Tier ${currentTier.name} gate-failed: ${failReason}. The cascade stops ` +
            'instead of firing a more expensive rung (fence 3).',
          remediation: [
            `Entry tier "${entryTierName}" is a fenced cheap lane; its one-climb budget is spent.`,
            'Re-author or re-route the WO; do not re-fire the same lane expecting a different result.',
          ],
          runId,
          overseerPermit: opts.overseerPermit,
        });
        return true;
      }

      // Climb to the next admitted tier, skipping dark or headroom-denied rungs.
      currentIndex = nextAdmittedTierIndex(currentIndex, 'climb');
      climbCount++;

      if (currentIndex >= tiers.length) {
        // Exhausted all tiers without a win -- should not happen if frontier is marked
        status = 'blocked';
        console.log(`[smart-cauldron] BLOCKED: all tiers exhausted for woId=${woId}`);
        return true;
      }

      const nextTier = tiers[currentIndex];
      console.log(
        `[smart-cauldron] Climbing to tier=${nextTier?.name ?? 'unknown'} (climb #${climbCount})`
      );
      return false;
    }

    /**
     * Pause the cascade at a premium-tier boundary instead of firing that tier.
     *
     * Shared by the loop-top approval gate and the progress-timeout pre-cancel
     * check. An AUTOMATIC climb into a premium tier (default ['frontier']) must
     * NEVER auto-fire ("then dont waste my usage if it will fail" -- John,
     * 2026-08-18), and must NEVER cancel the current run only to wait on a tier
     * that is not approved (WO-HARNESS-CONDUCTOR-STALL-DETECTOR-FIX-01 Scope IN
     * item 3, anchor: run 1388511a). Records the full escalation packet, emits
     * ONE operator notice, sets status = 'pending-frontier-approval', and
     * checkpoints. The pause persists even if the notice delivery fails.
     */
    async function pauseForFrontierApproval(
      premiumTier: LadderTier,
      runId: string | null
    ): Promise<void> {
      const pausedAt = new Date().toISOString();
      let notifiedAt: string | null = null;
      try {
        await emitEscalation({
          errorClass: 'validator_rejected',
          woId,
          reason:
            'PENDING FRONTIER APPROVAL -- auto-climb reached premium tier ' +
            `"${premiumTier.name}" (workflow ${premiumTier.workflowName}) for ${woId}. Not fired. ` +
            'Approve to resume, or reject to send to needs-human. ' +
            `Approve: POST /api/cascades/${cascadeId}/approve-frontier ; ` +
            `Reject: POST /api/cascades/${cascadeId}/reject-frontier`,
          remediation: buildFrontierApprovalRemediation(cascadeId, premiumTier, attempts),
          runId: runId ?? attempts.at(-1)?.runId ?? null,
          overseerPermit: opts.overseerPermit,
        });
        notifiedAt = new Date().toISOString();
      } catch (notifyErr) {
        console.log(
          `[smart-cauldron] Frontier-approval notice failed for woId=${woId}: ` +
            `${(notifyErr as Error).message} (pause persisted regardless)`
        );
      }

      frontierApprovalRecord = {
        ...(opts.expectedSpec ? { expectedSpec: opts.expectedSpec } : {}),
        tierName: premiumTier.name,
        workflowName: premiumTier.workflowName,
        priorContext,
        project: project ?? null,
        woId,
        woClass: woClass ?? null,
        tags: [...(tags ?? [])].sort(),
        apiBaseUrl,
        pausedAt,
        notifiedAt,
        resolution: null,
        resolvedAt: null,
        resumeCascadeId: null,
        rejectReason: null,
      };
      status = 'pending-frontier-approval';
      console.log(
        '[smart-cauldron] PENDING FRONTIER APPROVAL: auto-climb reached premium ' +
          `tier=${premiumTier.name} for woId=${woId} -- NOT firing (cascadeId=${cascadeId})`
      );
      await checkpoint();
    }

    /**
     * The next tier an AUTOMATIC climb from `fromIndex` would fire, skipping
     * refused (dark/retired) rungs -- mirrors the currentIndex++/refused-skip
     * logic in climbOrStop, but as a pure peek that does not mutate state.
     * Returns null when the ladder is exhausted above `fromIndex`.
     */
    function peekNextClimbTier(fromIndex: number): LadderTier | null {
      const idx = nextAdmittedTierIndex(fromIndex, 'peek');
      return idx < tiers.length ? (tiers[idx] ?? null) : null;
    }

    while (currentIndex < tiers.length) {
      const tier = tiers[currentIndex];
      if (!tier) break;

      // ==== Premium-tier approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01) ====
      // An AUTOMATIC climb into a premium tier (default ['frontier']) must NEVER
      // auto-fire. An explicit --entry override onto this tier is human-typed and
      // bypasses the gate (the operator already chose to spend on it).
      if (premiumTiers.includes(tier.name) && tier.name !== entryOverride) {
        await pauseForFrontierApproval(tier, attempts.at(-1)?.runId ?? null);
        break;
      }

      const attemptStartedAt = new Date().toISOString();
      const attempt: CascadeAttempt = {
        sourceEventId: `${cascadeId}:attempt:${attempts.length + 1}`,
        sourceEventAt: attemptStartedAt,
        tier: tier.name,
        workflowName: tier.workflowName,
        runId: null,
        outcome: 'running',
        gateFailReason: null,
        infraErrorReason: null,
        servedModelId: null,
        costUsd: null,
        startedAt: attemptStartedAt,
        completedAt: null,
      };
      attempts.push(attempt);
      priorPollSnapshot = currentPollSnapshot;
      currentPollSnapshot = null;
      await checkpoint();

      if (preflightImpl && !(attempts.length === 1 && automaticPreflightTier === tier.name)) {
        try {
          await preflightImpl(tier);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          attempt.outcome = 'infra-error';
          attempt.infraErrorReason = `lane preflight failed: ${reason}`;
          attempt.completedAt = new Date().toISOString();
          status = 'infra-alert';
          await emitEscalation({
            errorClass: 'invalid_request',
            woId,
            reason: `Lane preflight failed on tier ${tier.name}: ${reason}`,
            overseerPermit: opts.overseerPermit,
            runId: null,
          });
          await checkpoint();
          break;
        }
      }

      console.log(
        `[smart-cauldron] Firing woId=${woId} on tier=${tier.name} ` +
          `workflow=${tier.workflowName} (attempt ${attempts.length})`
      );

      // Re-check claim before each provider fire (another cascade or human may
      // have landed a PR while we were climbing). The first attempt still
      // refuses OPEN and MERGED. A climb refuses only MERGED: an OPEN PR is
      // the repair target, not a reason to stop.
      if (!allowClaimed) {
        const claimBeforeFire = await findWoClaimImpl(woId, project);
        const climbing = attempts.length > 1;
        const refuseClaim =
          claimBeforeFire !== null && (!climbing || claimBeforeFire.state === 'MERGED');
        if (claimBeforeFire && refuseClaim) {
          console.log(
            `[smart-cauldron] ALREADY SATISFIED before tier=${tier.name}: PR #${claimBeforeFire.number} ` +
              `[${claimBeforeFire.state}] ${claimBeforeFire.url} -- stopping cascade (refused, not won)`
          );
          status = 'refused';
          winningTier = null;
          attempt.outcome = 'refused';
          attempt.gateFailReason = null;
          attempt.completedAt = new Date().toISOString();
          refusalReason = {
            reason: 'already-satisfied',
            prNumber: claimBeforeFire.number,
            prState: claimBeforeFire.state,
            prUrl: claimBeforeFire.url,
            checkedAtTier: tier.name,
          };
          await checkpoint();
          break;
        }
      }

      // Before any retry fire, the prior run's processes must be proven gone
      // (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01 item 8).
      const priorRunId = attempts.length > 1 ? (attempts.at(-2)?.runId ?? null) : null;
      if (priorRunId) {
        const verdictTeardown = await waitForPriorTeardown(priorRunId, {
          read: readRunDetailImpl,
          initial: priorPollSnapshot,
          waitMs: teardownWaitMs,
          pollMs: teardownPollMs,
        });
        if (verdictTeardown !== 'confirmed') {
          attempt.outcome = 'infra-error';
          attempt.infraErrorReason = `teardown_unconfirmed: prior run ${priorRunId} (${verdictTeardown})`;
          attempt.completedAt = new Date().toISOString();
          status = 'blocked';
          blockedReason = 'teardown_unconfirmed';
          console.log(
            `[smart-cauldron] BLOCKED teardown_unconfirmed before tier=${tier.name}: ` +
              `prior run ${priorRunId} ${verdictTeardown}`
          );
          await emitEscalation({
            errorClass: 'worktree_collision',
            woId,
            reason:
              `teardown_unconfirmed: prior run ${priorRunId} teardown ${verdictTeardown}; ` +
              `tier ${tier.name} not fired`,
            runId: priorRunId,
            overseerPermit: opts.overseerPermit,
          });
          await checkpoint();
          break;
        }
      }

      // Fire the WO on this tier. A climb (attempts already include this one)
      // appends a repair-target line when exactly one declaration is selected.
      let message = buildFireMessage(woId, project, priorContext ?? undefined, opts.expectedSpec);
      if (attempts.length > 1) {
        const decision = await resolveClimbRepairTarget(
          woId,
          project,
          listOpenWoPullRequestsImpl,
          attempts.slice(0, -1),
          readRunDetailImpl
        );
        if (decision.held) {
          // Fail closed: firing without the lookup could open a second PR for this
          // WO. One operator message, no fire (bdc-xo #4638).
          attempt.outcome = 'infra-error';
          attempt.infraErrorReason = `${CLIMB_HELD_REASON_PREFIX} ${woId}: ${decision.held}`;
          attempt.completedAt = new Date().toISOString();
          status = 'infra-alert';
          await emitEscalation({
            errorClass: 'service_unavailable',
            woId,
            reason:
              `${CLIMB_HELD_REASON_PREFIX} ${woId} on tier ${tier.name}: ${decision.held}. ` +
              'Not fired, so no second PR was opened. Re-run the cascade once the lookup works.',
            overseerPermit: opts.overseerPermit,
            runId: attempts.at(-2)?.runId ?? null,
          });
          await checkpoint();
          break;
        }
        repairTargetAlternates = decision.alternates;
        if (decision.declaration) message = `${message}\n${decision.declaration}`;
      }
      const fireResult: FireResult = await fireImpl({
        workflowName: tier.workflowName,
        woId,
        project,
        message,
        apiBaseUrl,
        token,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      attempt.runId = fireResult.runId;
      if (fireResult.ok && fireResult.runId && opts.onRunDiscovered) {
        try {
          opts.onRunDiscovered(fireResult.runId, cascadeId, tier.name);
        } catch {
          // Observation hook only; never alters the climb.
        }
      }

      // Infra error: alert + stop (do NOT count as "too hard")
      if (!fireResult.ok) {
        const errorClass = classifyError({
          message: fireResult.infraError ?? '',
          statusCode: extractStatusCode(fireResult.infraError ?? ''),
        });

        attempt.outcome = 'infra-error';
        attempt.infraErrorReason = fireResult.infraError;
        attempt.completedAt = new Date().toISOString();

        if (superviseFailureImpl) {
          const recovery = await superviseFailureImpl({
            woId,
            cascadeId,
            tierName: tier.name,
            runId: fireResult.runId,
            reason: fireResult.infraError ?? 'unknown infrastructure failure',
            failureKind: 'infrastructure',
          });
          if (recovery.handled && recovery.ownerId !== null && recovery.fencingToken !== null) {
            supervisorRecoveryRecord = {
              ownerId: recovery.ownerId,
              fencingToken: recovery.fencingToken,
              evidenceRefs: recovery.evidenceRefs,
            };
            status = 'recovery-delegated';
            await checkpoint();
            break;
          }
        }

        await emitEscalation({
          errorClass,
          woId,
          reason: `Infra error on tier ${tier.name}: ${fireResult.infraError ?? 'unknown'}`,
          overseerPermit: opts.overseerPermit,
          runId: null,
        });

        status = 'infra-alert';
        await checkpoint();
        break;
      }

      // The workflow run identity is durable before polling begins.
      await checkpoint();

      // Poll for terminal state (runId is guaranteed non-null since fireResult.ok is true)
      const resolvedRunId = fireResult.runId ?? '';

      // Per-node configured timeouts for the watchdog. The run event feed carries
      // no per-node `timeout`, so the workflow definition is the only source and
      // this is the only production path that supplies it -- without this call
      // poll's `nodeTimeoutsMs` is inert and a node configured ABOVE the 60-minute
      // open-node default is still cut at 60 (WO-HARNESS-CONDUCTOR-STALL-DETECTOR-
      // FIX-01 Scope IN item 2). Resolved per attempt because each tier binds its
      // own workflow. Best-effort: never throws, {} restores the prior default.
      //
      // Guarded: the run is ALREADY FIRED and live by this point. The real
      // resolver never throws, but letting any future/injected resolver throw
      // here would abandon a live run over a watchdog-tuning lookup. Degrade to
      // the generic default instead.
      let nodeTimeoutsMs: Record<string, number> = {};
      try {
        nodeTimeoutsMs = await fetchNodeTimeoutsImpl({
          workflowName: tier.workflowName,
          apiBaseUrl,
          token,
          ...(fetchImpl ? { fetchImpl } : {}),
          floorMs: DEFAULT_OPEN_NODE_BUDGET_MS,
        });
      } catch (err) {
        console.log(
          `[smart-cauldron] node-timeout resolution failed for workflow ${tier.workflowName} ` +
            `(${(err as Error).message}); open nodes use the ` +
            `${String(DEFAULT_OPEN_NODE_BUDGET_MS)}ms default`
        );
      }

      let pollResult: PollResult;
      try {
        pollResult = await pollImpl({
          runId: resolvedRunId,
          apiBaseUrl,
          token,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(opts.isTransitionalStatus ? { isTransitionalStatus: opts.isTransitionalStatus } : {}),
          timeoutMs: pollTimeoutMs,
          stallTimeoutMs: pollStallTimeoutMs,
          intervalMs: pollIntervalMs,
          nodeTimeoutsMs,
          repo: resolveGithubRepo(project),
          woId,
        });
      } catch (pollErr) {
        if (pollErr instanceof TimeoutError) {
          // Carry the poll's own message through: it distinguishes a STALL (run went
          // silent) from the hard-ceiling backstop (run was still emitting but ran
          // past the runaway limit). Those are different diagnoses and the operator
          // reading this line needs to know which one fired.
          const timeoutReason =
            pollErr instanceof TimeoutError
              ? pollErr.message
              : `progress-timeout: no terminal state within ${pollTimeoutMs}ms`;

          // No cancel-to-nowhere (WO-HARNESS-CONDUCTOR-STALL-DETECTOR-FIX-01 Scope
          // IN item 3): if the automatic climb from this tier would land on a
          // premium tier that requires operator approval, do NOT cancel the
          // current run. Cancelling here kills live work only to wait on a tier we
          // are not allowed to fire (anchor: run 1388511a was cancelled with an
          // empty reason and then immediately paused for frontier approval).
          // Pause for approval and leave the run RUNNING.
          if (!tier.isFrontier) {
            const nextTier = peekNextClimbTier(currentIndex);
            if (
              nextTier &&
              premiumTiers.includes(nextTier.name) &&
              nextTier.name !== entryOverride
            ) {
              attempt.outcome = 'progress-timeout';
              attempt.gateFailReason = timeoutReason;
              attempt.completedAt = new Date().toISOString();
              priorContext = buildTimeoutPriorContext(tier.name, pollStallTimeoutMs);
              console.log(
                `[smart-cauldron] Progress-timeout on tier=${tier.name}: ${timeoutReason}`
              );
              console.log(
                `[smart-cauldron] NOT cancelling run ${resolvedRunId}: next tier=` +
                  `${nextTier.name} requires approval -- pausing for frontier approval and ` +
                  'leaving the run running (no cancel-to-nowhere)'
              );
              await pauseForFrontierApproval(nextTier, fireResult.runId);
              break;
            }
          }

          // Progress-timeout: the model responded and burned tokens but never
          // reached a terminal state within budget. Per the three-failure-class
          // design (v1.1 amendment 2), this is a QUALITY failure, not an infra
          // failure -- cancel the hung run (best-effort; must not block the
          // climb) and climb via the same logic used for gate-fail. Every
          // conductor cancel carries a non-empty reason (Scope IN item 4) so
          // run_cancelled.data.reason is never "".
          const cancelResult = await cancelImpl({
            runId: resolvedRunId,
            apiBaseUrl,
            token,
            ...(fetchImpl ? { fetchImpl } : {}),
            reason: `smart-cauldron stall: ${timeoutReason}; cascade ${cascadeId}`,
          }).catch((cancelErr: unknown) => ({
            ok: false,
            error: `cancel threw: ${(cancelErr as Error).message}`,
          }));
          if (!cancelResult.ok) {
            console.log(
              `[smart-cauldron] Warning: cancel failed for run ${resolvedRunId} on tier ` +
                `${tier.name}: ${cancelResult.error ?? 'unknown'} (continuing climb -- ` +
                'cancellation is best-effort)'
            );
          }

          attempt.outcome = 'progress-timeout';
          attempt.gateFailReason = timeoutReason;
          attempt.completedAt = new Date().toISOString();

          console.log(`[smart-cauldron] Progress-timeout on tier=${tier.name}: ${timeoutReason}`);
          priorContext = buildTimeoutPriorContext(tier.name, pollStallTimeoutMs);

          const shouldStop = await climbOrStop(tier, timeoutReason, fireResult.runId);
          await checkpoint();
          if (shouldStop) break;
          continue;
        }

        // Non-timeout poll errors (network, API unreachable/5xx) keep the exact
        // existing infra-error handling -- unchanged.
        const errMsg = (pollErr as Error).message;
        attempt.outcome = 'infra-error';
        attempt.infraErrorReason = `poll error: ${errMsg}`;
        attempt.completedAt = new Date().toISOString();

        await emitEscalation({
          errorClass: 'service_unavailable',
          woId,
          reason: `Poll timeout/error on tier ${tier.name}: ${errMsg}`,
          overseerPermit: opts.overseerPermit,
          runId: fireResult.runId,
        });

        status = 'infra-alert';
        await checkpoint();
        break;
      }

      currentPollSnapshot = {
        status: pollResult.terminalStatus,
        metadata: pollResult.rawMetadata ?? {},
      };

      // Judge the gate
      const verdict: GateVerdict = judgeImpl(pollResult);
      const outcome = classifyAttemptOutcome(fireResult, verdict);

      attempt.outcome = outcome;
      attempt.gateFailReason = verdict.pass ? null : verdict.reason;
      attempt.servedModelId = pollResult.servedModelId;
      attempt.nodeModels = pollResult.nodeModels;
      attempt.completedAt = new Date().toISOString();

      if (verdict.pass) {
        // Gate passed -- cascade stops
        status = 'won';
        winningTier = tier.name;
        await checkpoint();
        console.log(
          `[smart-cauldron] WON on tier=${tier.name} after ${attempts.length} attempt(s)`
        );
        break;
      }

      if (outcome === 'cancelled') {
        // Externally cancelled (Motion M-86): a human deliberately stopped this
        // run. STOP the cascade -- do NOT call climbOrStop. Record the truth:
        // status/outcome are 'cancelled', never a false win, never spec-repair.
        status = 'cancelled';
        console.log(`[smart-cauldron] CANCELLED on tier=${tier.name}: ${verdict.reason}`);
        await checkpoint();
        break;
      }

      // Run-start seat refusal (WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01):
      // the run never dispatched a node, so this is neither a quality failure
      // nor a gate misfire. Climb to the next rung with headroom without
      // building informed-climb context and without SPEC-REPAIR.
      const seatRefusal = seatRefusalDetail(pollResult);
      if (seatRefusal) {
        attempt.gateFailReason = `seat_refusal: ${seatRefusal}`;
        // Fence 3 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01): the one-climb cap
        // also applies to a seat-refusal climb. If this cascade's ENTRY tier has
        // a maxClimbsByEntry limit and a further climb would exceed it, stop
        // BLOCKED (climb_limit_reached) with one escalation rather than firing
        // another rung.
        const entryClimbLimitSeat = maxClimbsByEntry[entryTierName];
        if (typeof entryClimbLimitSeat === 'number' && climbCount >= entryClimbLimitSeat) {
          status = 'blocked';
          blockedReason = 'climb_limit_reached';
          console.log(
            '[smart-cauldron] BLOCKED climb_limit_reached (seat refusal): entry tier ' +
              `"${entryTierName}" allows ${entryClimbLimitSeat} climb(s); tier=${tier.name} was ` +
              `seat-refused and no further rung will be fired for woId=${woId}`
          );
          await emitEscalation({
            errorClass: 'validator_rejected',
            woId,
            reason:
              `CLIMB LIMIT REACHED -- entry tier "${entryTierName}" allows ` +
              `${entryClimbLimitSeat} climb(s). Tier ${tier.name} was seat-refused ` +
              `(${seatRefusal}). The cascade stops instead of firing a more expensive rung ` +
              '(fence 3).',
            remediation: [
              `Entry tier "${entryTierName}" is a fenced cheap lane; its one-climb budget is spent.`,
              'Resolve the seat pressure or re-route the WO; do not auto-climb into a paid seat.',
            ],
            runId: fireResult.runId,
            overseerPermit: opts.overseerPermit,
          });
          await checkpoint();
          break;
        }
        console.log(
          `[smart-cauldron] Seat refusal on tier=${tier.name}: ${seatRefusal} -- ` +
            'climbing to the next rung with headroom (not a quality failure)'
        );
        currentIndex = tier.isFrontier
          ? tiers.length
          : nextAdmittedTierIndex(currentIndex, 'climb');
        climbCount++;
        if (currentIndex >= tiers.length) {
          status = 'blocked';
          console.log(
            `[smart-cauldron] BLOCKED: no rung above tier=${tier.name} has seat headroom ` +
              `for woId=${woId}`
          );
          await checkpoint();
          break;
        }
        await checkpoint();
        continue;
      }

      // Harness gate misfire: the gate failed for a harness-side reason, not
      // because the implement tier produced bad work. Stop on this tier with
      // one Dispatch notice. Do not climb and do not post SPEC-REPAIR.
      if (outcome === 'gate-failed') {
        const misfire = classifyGateMisfire(pollResult);
        if (misfire) {
          attempt.outcome = 'gate-misfire';
          attempt.gateFailReason = `${misfire.kind}: ${misfire.reason}`;
          status = 'gate-misfire';
          winningTier = null;
          gateMisfireRecord = {
            kind: misfire.kind,
            gateNode: misfire.gateNode,
            failedNodes: misfire.failedNodes,
            reason: misfire.reason,
            runId: fireResult.runId,
            tier: tier.name,
          };
          await emitEscalation({
            errorClass: 'harness_gate_misfire',
            woId,
            reason:
              `GATE MISFIRE (no climb): ${misfire.kind} at ${misfire.gateNode} ` +
              `on tier ${tier.name} -- ${misfire.reason}`,
            remediation: [
              'Fix owner: harness gate (sibling gate WOs, bdc-xo#3743, or bdc-xo#3737). Do not treat this as an implement failure.',
              'Re-fire the same tier after the harness fix lands; do not escalate',
            ],
            runId: fireResult.runId,
            overseerPermit: opts.overseerPermit,
          });
          await checkpoint();
          break;
        }
      }

      // A failed repair checkout (held branch, gate closed on checkout) is not a
      // quality failure: a bigger model cannot free the branch. Stop blocked with
      // one escalation (WO-HARNESS-REPAIR-HOLDER-TEARDOWN-01 item 8).
      if (isCheckoutFailedNoClimb(pollResult)) {
        attempt.gateFailReason = `checkout_failed_no_climb: ${verdict.reason}`;
        status = 'blocked';
        blockedReason = 'checkout_failed_no_climb';
        console.log(
          `[smart-cauldron] BLOCKED checkout_failed_no_climb on tier=${tier.name} for woId=${woId}`
        );
        await emitEscalation({
          errorClass: 'worktree_collision',
          woId,
          reason:
            `checkout_failed_no_climb: repair checkout failed on tier ${tier.name}; ` +
            'not climbing (a held branch is not a model-quality failure)',
          runId: fireResult.runId,
          overseerPermit: opts.overseerPermit,
        });
        await checkpoint();
        break;
      }

      // Gate failed
      console.log(`[smart-cauldron] Gate failed on tier=${tier.name}: ${verdict.reason}`);

      // Before climbing, re-check whether the work already landed under another
      // branch/PR the per-run event feed missed (the classic 5-tier burn).
      // MERGED still stops the climb. OPEN does not: the climb repairs that PR.
      if (!allowClaimed) {
        const claimBeforeClimb = await findWoClaimImpl(woId, project);
        if (claimBeforeClimb?.state === 'MERGED') {
          console.log(
            `[smart-cauldron] ALREADY SATISFIED after gate-fail on tier=${tier.name}: ` +
              `PR #${claimBeforeClimb.number} [${claimBeforeClimb.state}] ${claimBeforeClimb.url} ` +
              '-- NOT climbing (refused, not won)'
          );
          status = 'refused';
          winningTier = null;
          refusalReason = {
            reason: 'already-satisfied',
            prNumber: claimBeforeClimb.number,
            prState: claimBeforeClimb.state,
            prUrl: claimBeforeClimb.url,
            checkedAtTier: tier.name,
          };
          await checkpoint();
          break;
        }
      }

      // Build informed-climb context for the next tier
      priorContext = buildPriorContext(tier.name, verdict, pollResult);

      const shouldStop = await climbOrStop(tier, verdict.reason, fireResult.runId);
      await checkpoint();
      if (shouldStop) break;
    }

    const record = buildCurrentRecord();

    // Write local telemetry record
    const recordPath = await writeRecordImpl(record, outDir);
    console.log(`[smart-cauldron] Cascade record written: ${recordPath}`);

    return record;
  } finally {
    await releaseWoLockImpl(woId, project, cascadeId, outDir);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats `Repair target: PR #<number> (branch <branch>)`.
 * Caller validates the number and branch before calling.
 */
export const REPAIR_TARGET_DECLARATION = (prNumber: number, branch: string): string =>
  `Repair target: PR #${String(prNumber)} (branch ${branch})`;

/** Options a climb passes to the open-PR reader (bdc-xo #4638). */
export interface OpenWoPullRequestLookupOptions {
  /** Head branches of earlier attempts' runs; a PR on one claims the WO. */
  readonly headBranches?: readonly string[];
  /** Throw on a lookup error instead of failing open to []. */
  readonly failOnError?: boolean;
}

/**
 * Start of the single operator message when a climb cannot finish its repair-target
 * lookup. The climb is held (not fired) so it can never open a second PR for a WO
 * whose earlier rung already opened one (acting XO 2026-11-04, bdc-xo #4638).
 */
export const CLIMB_HELD_REASON_PREFIX = 'climb held: repair-target lookup failed for';

interface ClimbRepairDecision {
  readonly declaration: string | null;
  readonly alternates: CascadeRunRecord['repairTargetAlternates'];
  /** Set when the lookup could not complete; the climb must not fire. */
  readonly held?: string;
}

function isValidRepairCandidate(pr: OpenWoPullRequest): boolean {
  return (
    Number.isInteger(pr.number) &&
    pr.number > 0 &&
    pr.headRefName.length > 0 &&
    !/\s/.test(pr.headRefName)
  );
}

/** Newest createdAt first, then higher PR number. */
function compareOpenPrNewest(a: OpenWoPullRequest, b: OpenWoPullRequest): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.number - a.number;
}

function logClimbRepairTarget(woId: string, pr: number | 'none', reason: string): void {
  console.log(
    `[smart-cauldron] climb repair-target woId=${woId} pr=${String(pr)} reason=${reason}`
  );
}

/**
 * Select the repair target for a climb fire. Never throws: a reader error,
 * an empty list, or an invalid selected candidate yields no declaration.
 */
async function resolveClimbRepairTarget(
  woId: string,
  project: string,
  read: (
    woId: string,
    project: string,
    options?: OpenWoPullRequestLookupOptions
  ) => Promise<OpenWoPullRequest[]>,
  priorAttempts: readonly { readonly runId: string | null }[] = [],
  readRunDetail?: (runId: string) => Promise<PriorRunDetail | null>
): Promise<ClimbRepairDecision> {
  const none: ClimbRepairDecision = { declaration: null, alternates: undefined };
  // Earlier runs' head branches find a PR that carries no WO marker (#1476).
  const headBranches: string[] = [];
  for (const prior of priorAttempts) {
    if (!prior.runId || !readRunDetail) continue;
    let detail: PriorRunDetail | null;
    try {
      detail = await readRunDetail(prior.runId);
    } catch {
      detail = null;
    }
    if (!detail) {
      logClimbRepairTarget(woId, 'none', `run_detail_unavailable:${prior.runId}`);
      return { ...none, held: `run detail unavailable for prior run ${prior.runId}` };
    }
    const head = detail.metadata?.head_branch;
    if (typeof head === 'string' && head.length > 0) headBranches.push(head);
  }
  let opens: OpenWoPullRequest[];
  try {
    opens = await read(woId, project, { headBranches, failOnError: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logClimbRepairTarget(woId, 'none', 'reader_error');
    return { ...none, held: `open-PR lookup failed (${detail.slice(0, 200)})` };
  }
  if (!Array.isArray(opens)) {
    logClimbRepairTarget(woId, 'none', 'reader_error');
    return { ...none, held: 'open-PR lookup returned no list' };
  }
  if (opens.length === 0) {
    logClimbRepairTarget(woId, 'none', 'none');
    return none;
  }
  const sorted = [...opens].sort(compareOpenPrNewest);
  const selected = sorted[0];
  if (!selected || !isValidRepairCandidate(selected)) {
    const label =
      selected && Number.isFinite(selected.number) ? `#${String(selected.number)}` : 'unreadable';
    logClimbRepairTarget(woId, 'none', `invalid_candidate:${label}`);
    return none;
  }
  const alternates =
    sorted.length > 1
      ? sorted.slice(1).map(pr => ({ number: pr.number, headRefName: pr.headRefName }))
      : undefined;
  const reason = sorted.length === 1 ? 'single_open' : 'newest_of_many';
  logClimbRepairTarget(woId, selected.number, reason);
  return {
    declaration: REPAIR_TARGET_DECLARATION(selected.number, selected.headRefName),
    alternates,
  };
}

/**
 * The run-start seat refusal detail (`seat_usage_refused:...`) when a fired
 * run was refused by the seat gate before any node ran, else null. The
 * executor stores the detail as the run's metadata.error.
 */
export function seatRefusalDetail(poll: PollResult): string | null {
  if (poll.terminalStatus !== 'failed') return null;
  const error = poll.rawMetadata.error;
  if (typeof error !== 'string' || !error.startsWith('seat_usage_refused:')) return null;
  return error;
}

/**
 * Build informed-climb context to pass to the next tier.
 * Summarizes what failed so the bigger model corrects a near-miss.
 */
function buildPriorContext(tierName: TierName, verdict: GateVerdict, poll: PollResult): string {
  const lines: string[] = [
    `Prior tier: ${tierName}`,
    'Gate verdict: FAILED',
    `Failing conditions: ${verdict.reason}`,
    `Terminal status: ${verdict.terminalStatus}`,
    `Validator verdict: ${verdict.validatorVerdict}`,
    `PR opened: ${verdict.prOpened}`,
    `PR mergeable: ${verdict.prMergeable === null ? 'unknown' : String(verdict.prMergeable)}`,
  ];

  if (poll.servedModelId) {
    lines.push(`Served model: ${poll.servedModelId}`);
  }

  lines.push(
    '',
    'The prior tier attempted the work but did not pass the gate.',
    'Correct the identified issues rather than starting from scratch.'
  );

  return lines.join('\n');
}

/**
 * Build informed-climb context for the next tier after a progress-timeout.
 * Distinct from buildPriorContext (gate-fail) since no GateVerdict/PollResult
 * exists for a run that never reached a terminal state.
 */
function buildTimeoutPriorContext(tierName: TierName, timeoutMs: number): string {
  return [
    `Prior tier: ${tierName}`,
    'Outcome: PROGRESS-TIMEOUT (poll watchdog kill)',
    `The run did not reach a terminal state within the ${timeoutMs}ms poll budget and was cancelled.`,
    '',
    'The prior tier likely stalled (repair loop, no-progress churn, or a hang) rather',
    'than failing a specific gate condition. Focus on completing the work within budget',
    'rather than repeating whatever caused the stall.',
  ].join('\n');
}

/**
 * Compute total cost from all attempts.
 * Returns null if no attempt has a known cost.
 */
function computeTotalCost(attempts: CascadeAttempt[]): number | null {
  const known = attempts.filter(a => a.costUsd !== null);
  if (known.length === 0) return null;
  return known.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
}

/**
 * Extract HTTP status code from an infraError string like "HTTP 401: ..."
 */
function extractStatusCode(infraError: string): number | undefined {
  const match = /HTTP\s+(\d{3})/.exec(infraError);
  if (match?.[1]) {
    const code = parseInt(match[1], 10);
    return isNaN(code) ? undefined : code;
  }
  return undefined;
}

/**
 * Default escalation implementation using the shared persistent M-42 boundary.
 */
async function defaultEscalate(ctx: EscalationCallContext): Promise<void> {
  const runId = ctx.runId ?? `cascade-${ctx.sourceEventId}`;
  const authorization = await runAuthorizedEscalation(runId, {
    permit: ctx.overseerPermit ?? null,
    actor: 'smart-cauldron',
  });
  if (!authorization.accepted) return;
  await runEscalation(
    runId,
    { decision: 'escalate', reason: ctx.reason },
    {
      errorClass: ctx.errorClass,
      woId: ctx.woId,
      repository: ctx.repository,
      remediation: ctx.remediation,
    },
    {
      sourceEventId: ctx.sourceEventId,
      eventType: 'cascade_escalation',
      stepName: 'smart-cauldron',
      eventCreatedAt: ctx.sourceEventCreatedAt,
    }
  );
}

/**
 * Build the operator-facing remediation lines for a premium-tier approval pause.
 * Lists the exact approve/reject commands and the tiers already burned so the
 * operator can decide whether the premium spend is warranted before it happens.
 */
function buildFrontierApprovalRemediation(
  cascadeId: string,
  tier: LadderTier,
  attempts: CascadeAttempt[]
): string[] {
  const lines: string[] = [
    `Premium tier "${tier.name}" (workflow ${tier.workflowName}) was reached by an ` +
      'automatic climb and was NOT fired -- awaiting operator approval.',
    `Approve (resume + fire the premium tier): POST /api/cascades/${cascadeId}/approve-frontier`,
    `Reject (terminate as needs-human, no fire): POST /api/cascades/${cascadeId}/reject-frontier`,
  ];
  if (attempts.length > 0) {
    lines.push('Tiers already attempted (cheapest first):');
    for (const a of attempts) {
      const detail = a.gateFailReason ?? a.infraErrorReason ?? '(no detail)';
      lines.push(`  - ${a.tier} [${a.outcome}]: ${detail}`);
    }
  } else {
    lines.push(
      'No prior tiers were attempted -- the conductor selected this premium tier directly.'
    );
  }
  return lines;
}

/**
 * Build the SPEC-REPAIR failure evidence block for the frontier (fable) gate-fail.
 * Summarizes what the apex rung tried and why it still failed the gate, so the
 * authoring layer has the concrete signal to repair the spec.
 */
function buildSpecRepairEvidence(
  tier: LadderTier,
  failReason: string,
  runId: string | null,
  attempts: CascadeAttempt[]
): string {
  const lines: string[] = [
    `Frontier tier: ${tier.name} (workflow: ${tier.workflowName})`,
    `Run id: ${runId ?? 'unknown'}`,
    `Gate-fail reason: ${failReason}`,
    '',
    'Cascade attempt history (cheapest tier first):',
  ];
  for (const a of attempts) {
    const detail = a.gateFailReason ?? a.infraErrorReason ?? '(no detail)';
    const served = a.servedModelId ? ` served=${a.servedModelId}` : '';
    lines.push(`  - ${a.tier} [${a.outcome}]${served}: ${detail}`);
  }
  return lines.join('\n');
}

/**
 * Build the concrete "what must change in the spec" statement. The fable apex
 * rung is the strongest available model; if it could not pass the gate, the
 * problem is upstream of execution -- the spec itself must be repaired.
 */
function buildWhatMustChange(tier: LadderTier, failReason: string): string {
  return [
    'WHAT MUST CHANGE IN THE SPEC:',
    `The apex (fable) tier "${tier.name}" is the strongest available model and it still`,
    `could not pass the completion gate (${failReason}).`,
    'This is not an execution capacity problem -- re-running will not help. The Work Order',
    'spec must be repaired before it can succeed. Concretely, revise the spec to resolve the',
    'gate-fail above: clarify ambiguous or contradictory requirements, correct any file/scope',
    'claims that did not match the codebase, tighten the stop conditions into concrete',
    'verifiable commands, or split the WO if it is too large for a single surgical change.',
    'Re-file the repaired WO to re-enter at the authoring layer.',
  ].join('\n');
}

/**
 * Default SPEC-REPAIR implementation. Resolves the WO's GitHub issue in bdc-xo
 * (via title search on the WO ID), posts a comment with the failure evidence +
 * the "what must change" statement, and applies the status:blocked label.
 *
 * Never closes the issue (premature-close fence). Returns posted=false when no
 * issue can be resolved so the caller falls back to the escalate/alert path.
 *
 * Mirrors the gh CLI pattern used by the review-issue / blocked-issue bash nodes
 * in bdc-feature-development.yaml.
 */
async function defaultSpecRepair(ctx: SpecRepairCallContext): Promise<SpecRepairResult> {
  const issueRepo = process.env.ISSUE_REPO ?? 'thinmansoftware/bdc-xo';

  // Resolve the issue number by searching the WO ID in the issue title.
  let issueNumber: number | null = null;
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue',
      'list',
      '--repo',
      issueRepo,
      '--search',
      `${ctx.woId} in:title`,
      '--json',
      'number',
      '--jq',
      '.[0].number // empty',
    ]);
    const parsed = parseInt(stdout.trim(), 10);
    if (!isNaN(parsed)) issueNumber = parsed;
  } catch (err) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: gh issue lookup failed for ${ctx.woId}: ` +
        (err as Error).message
    );
    return { posted: false, issueRepo, issueNumber: null };
  }

  if (issueNumber === null) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: no GitHub issue resolved for ${ctx.woId} in ${issueRepo}.`
    );
    return { posted: false, issueRepo, issueNumber: null };
  }

  const body = [
    '## SPEC-REPAIR required (Smart Cauldron apex rung gate-fail)',
    '',
    `The escalation cascade reached the frontier (fable) tier for **${ctx.woId}** and the`,
    'apex rung still gate-failed. Per doctrine (John, 2026-07-02): Fable is the last',
    'escalation before failure -- a WO should never terminally fail, it should be fixed.',
    '',
    '### Failure evidence',
    '```',
    ctx.evidence,
    '```',
    '',
    '### What must change',
    ctx.whatMustChange,
  ].join('\n');

  try {
    // Ensure the label exists (best-effort; ignore "already exists").
    await execFileAsync('gh', [
      'label',
      'create',
      'status:blocked',
      '--repo',
      issueRepo,
      '--color',
      'B60205',
      '--description',
      'BDC Work Order blocked -- spec repair required',
    ]).catch(() => undefined);

    await execFileAsync('gh', [
      'issue',
      'comment',
      String(issueNumber),
      '--repo',
      issueRepo,
      '--body',
      body,
    ]);

    await execFileAsync('gh', [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      issueRepo,
      '--add-label',
      'status:blocked',
    ]);

    console.log(
      `[smart-cauldron] SPEC-REPAIR: posted comment + status:blocked on ${issueRepo}#${issueNumber}`
    );
    return { posted: true, issueRepo, issueNumber };
  } catch (err) {
    console.log(
      `[smart-cauldron] SPEC-REPAIR: gh comment/label failed for ${issueRepo}#${issueNumber}: ` +
        (err as Error).message
    );
    return { posted: false, issueRepo, issueNumber };
  }
}
