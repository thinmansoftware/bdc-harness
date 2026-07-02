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
import { loadLadder } from './ladder.js';
import { loadRuleset, pickEntryTier } from './conductor.js';
import { fireTier, buildFireMessage } from './fire.js';
import { pollForTerminal, TimeoutError } from './poll.js';
import { judgeGate, classifyAttemptOutcome } from './judge.js';
import { writeRecord } from './recorder.js';
import { cancelRun } from './cancel.js';
import { classifyError } from '../../overseer/src/classify';
import type {
  CascadeRunRecord,
  CascadeAttempt,
  CascadeStatus,
  TierName,
  LadderTier,
  GateVerdict,
  FireResult,
  PollResult,
} from './types.js';
import type { ErrorClass } from '../../overseer/src/classify';
import type { DecisionResult } from '../../overseer/src/decide';

// ---------------------------------------------------------------------------
// Dependency injection interface (for testability)
// ---------------------------------------------------------------------------

export interface CascadeDeps {
  fire?: typeof fireTier;
  poll?: typeof pollForTerminal;
  judge?: typeof judgeGate;
  escalate?: (context: EscalationCallContext) => Promise<void>;
  writeRecord?: typeof writeRecord;
  /** Best-effort cancel of a hung run on progress-timeout. Failure never blocks the climb. */
  cancel?: typeof cancelRun;
}

export interface EscalationCallContext {
  errorClass: string;
  woId: string;
  reason: string;
  remediation?: string[];
  runId?: string | null;
}

// ---------------------------------------------------------------------------
// Main cascade options
// ---------------------------------------------------------------------------

export interface RunCascadeOptions {
  woId: string;
  woClass?: string;
  tags?: string[];
  /** Override the entry tier (skips conductor ruleset). */
  entryOverride?: TierName;
  /** Archon API base URL. Defaults to ARCHON_API_BASE_URL env or http://localhost:3090. */
  apiBaseUrl?: string;
  /** Output directory for cascade-runs/ records. Default: ./cascade-runs. */
  outDir?: string;
  /** Dry-run: print which tier would be picked, do not fire. */
  dryRun?: boolean;
  /** Dependency injection (for testing). */
  deps?: CascadeDeps;
  /** Poll timeout per attempt in ms. Default: 1800000 (30 minutes). */
  pollTimeoutMs?: number;
  /** Poll interval per attempt in ms. Default: 30000 (30 seconds). */
  pollIntervalMs?: number;
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
    woClass,
    tags,
    entryOverride,
    dryRun = false,
    outDir = './cascade-runs',
    pollTimeoutMs = 1_800_000,
    pollIntervalMs = 30_000,
  } = opts;

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.ARCHON_API_BASE_URL ?? 'http://localhost:3090';

  // Inject real implementations unless overridden (for testing)
  const fireImpl = opts.deps?.fire ?? fireTier;
  const pollImpl = opts.deps?.poll ?? pollForTerminal;
  const judgeImpl = opts.deps?.judge ?? judgeGate;
  const escalateImpl = opts.deps?.escalate ?? defaultEscalate;
  const writeRecordImpl = opts.deps?.writeRecord ?? writeRecord;
  const cancelImpl = opts.deps?.cancel ?? cancelRun;

  // Load config from files (never from inline constants)
  const tiers = loadLadder();
  const ruleset = loadRuleset();

  // Conductor: pick entry tier
  const entryTierName = entryOverride ?? pickEntryTier({ woClass, tags }, ruleset);
  let currentIndex = tiers.findIndex(t => t.name === entryTierName);
  if (currentIndex === -1) {
    throw new Error(
      `[smart-cauldron/cascade] Entry tier "${entryTierName}" not found in ladder. ` +
        `Available tiers: ${tiers.map(t => t.name).join(', ')}`
    );
  }

  const cascadeId = randomUUID();
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
      createdAt,
      status: 'won',
      winningTier: null,
      attempts: [],
      totalCostUsd: null,
      telemetry: {
        entryTier: entryTierName,
        climbed: false,
        climbCount: 0,
        wonCheap: false,
      },
    };
    return record;
  }

  // Cascade loop
  const attempts: CascadeAttempt[] = [];
  let priorContext: string | null = null;
  let climbCount = 0;
  let status: CascadeStatus = 'blocked';
  let winningTier: TierName | null = null;

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
      // Top rung failed -- BLOCKED
      await escalateImpl({
        errorClass: 'validator_rejected',
        woId,
        reason: `Frontier tier ${currentTier.name} failed gate: ${failReason}`,
        remediation: [failReason],
        runId,
      });

      status = 'blocked';
      console.log(`[smart-cauldron] BLOCKED: frontier tier gate-failed for woId=${woId}`);
      return true;
    }

    // Climb to next tier
    currentIndex++;
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

  while (currentIndex < tiers.length) {
    const tier = tiers[currentIndex];
    if (!tier) break;
    const attemptStartedAt = new Date().toISOString();

    console.log(
      `[smart-cauldron] Firing woId=${woId} on tier=${tier.name} ` +
        `workflow=${tier.workflowName} (attempt ${attempts.length + 1})`
    );

    // Fire the WO on this tier
    const fireResult: FireResult = await fireImpl({
      workflowName: tier.workflowName,
      woId,
      message: buildFireMessage(woId, priorContext ?? undefined),
      apiBaseUrl,
    });

    // Infra error: alert + stop (do NOT count as "too hard")
    if (!fireResult.ok) {
      const errorClass = classifyError({
        message: fireResult.infraError ?? '',
        statusCode: extractStatusCode(fireResult.infraError ?? ''),
      });

      const attempt: CascadeAttempt = {
        tier: tier.name,
        workflowName: tier.workflowName,
        runId: null,
        outcome: 'infra-error',
        gateFailReason: null,
        infraErrorReason: fireResult.infraError,
        servedModelId: null,
        costUsd: null,
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
      };
      attempts.push(attempt);

      await escalateImpl({
        errorClass,
        woId,
        reason: `Infra error on tier ${tier.name}: ${fireResult.infraError ?? 'unknown'}`,
        runId: null,
      });

      status = 'infra-alert';
      break;
    }

    // Poll for terminal state (runId is guaranteed non-null since fireResult.ok is true)
    const resolvedRunId = fireResult.runId ?? '';
    let pollResult: PollResult;
    try {
      pollResult = await pollImpl({
        runId: resolvedRunId,
        apiBaseUrl,
        timeoutMs: pollTimeoutMs,
        intervalMs: pollIntervalMs,
      });
    } catch (pollErr) {
      if (pollErr instanceof TimeoutError) {
        // Progress-timeout: the model responded and burned tokens but never
        // reached a terminal state within budget. Per the three-failure-class
        // design (v1.1 amendment 2), this is a QUALITY failure, not an infra
        // failure -- cancel the hung run (best-effort; must not block the
        // climb) and climb via the same logic used for gate-fail.
        const cancelResult = await cancelImpl({ runId: resolvedRunId, apiBaseUrl }).catch(
          (cancelErr: unknown) => ({
            ok: false,
            error: `cancel threw: ${(cancelErr as Error).message}`,
          })
        );
        if (!cancelResult.ok) {
          console.log(
            `[smart-cauldron] Warning: cancel failed for run ${resolvedRunId} on tier ` +
              `${tier.name}: ${cancelResult.error ?? 'unknown'} (continuing climb -- ` +
              'cancellation is best-effort)'
          );
        }

        const timeoutReason = `progress-timeout: no terminal state within ${pollTimeoutMs}ms poll budget`;
        const attempt: CascadeAttempt = {
          tier: tier.name,
          workflowName: tier.workflowName,
          runId: fireResult.runId,
          outcome: 'progress-timeout',
          gateFailReason: timeoutReason,
          infraErrorReason: null,
          servedModelId: null,
          costUsd: null,
          startedAt: attemptStartedAt,
          completedAt: new Date().toISOString(),
        };
        attempts.push(attempt);

        console.log(`[smart-cauldron] Progress-timeout on tier=${tier.name}: ${timeoutReason}`);
        priorContext = buildTimeoutPriorContext(tier.name, pollTimeoutMs);

        const shouldStop = await climbOrStop(tier, timeoutReason, fireResult.runId);
        if (shouldStop) break;
        continue;
      }

      // Non-timeout poll errors (network, API unreachable/5xx) keep the exact
      // existing infra-error handling -- unchanged.
      const errMsg = (pollErr as Error).message;
      const attempt: CascadeAttempt = {
        tier: tier.name,
        workflowName: tier.workflowName,
        runId: fireResult.runId,
        outcome: 'infra-error',
        gateFailReason: null,
        infraErrorReason: `poll error: ${errMsg}`,
        servedModelId: null,
        costUsd: null,
        startedAt: attemptStartedAt,
        completedAt: new Date().toISOString(),
      };
      attempts.push(attempt);

      await escalateImpl({
        errorClass: 'service_unavailable',
        woId,
        reason: `Poll timeout/error on tier ${tier.name}: ${errMsg}`,
        runId: fireResult.runId,
      });

      status = 'infra-alert';
      break;
    }

    // Judge the gate
    const verdict: GateVerdict = judgeImpl(pollResult);
    const outcome = classifyAttemptOutcome(fireResult, verdict);

    const attempt: CascadeAttempt = {
      tier: tier.name,
      workflowName: tier.workflowName,
      runId: fireResult.runId,
      outcome,
      gateFailReason: verdict.pass ? null : verdict.reason,
      infraErrorReason: null,
      servedModelId: pollResult.servedModelId,
      costUsd: null,
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
    };
    attempts.push(attempt);

    if (verdict.pass) {
      // Gate passed -- cascade stops
      status = 'won';
      winningTier = tier.name;
      console.log(`[smart-cauldron] WON on tier=${tier.name} after ${attempts.length} attempt(s)`);
      break;
    }

    // Gate failed
    console.log(`[smart-cauldron] Gate failed on tier=${tier.name}: ${verdict.reason}`);

    // Build informed-climb context for the next tier
    priorContext = buildPriorContext(tier.name, verdict, pollResult);

    const shouldStop = await climbOrStop(tier, verdict.reason, fireResult.runId);
    if (shouldStop) break;
  }

  // Compute total cost
  const totalCostUsd = computeTotalCost(attempts);

  const firstAttempt = attempts[0];
  const entryTier: TierName = firstAttempt?.tier ?? entryTierName;
  const climbed = climbCount > 0;
  const wonCheap = status === 'won' && !climbed;

  const record: CascadeRunRecord = {
    cascadeId,
    woId,
    createdAt,
    status,
    winningTier,
    attempts,
    totalCostUsd,
    telemetry: {
      entryTier,
      climbed,
      climbCount,
      wonCheap,
    },
  };

  // Write local telemetry record
  const recordPath = await writeRecordImpl(record, outDir);
  console.log(`[smart-cauldron] Cascade record written: ${recordPath}`);

  return record;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Default escalation implementation using @archon/overseer/escalate.
 */
async function defaultEscalate(ctx: EscalationCallContext): Promise<void> {
  const decision: DecisionResult = {
    decision: 'escalate',
    reason: ctx.reason,
    escalationContext: {
      errorClass: ctx.errorClass as ErrorClass,
      woId: ctx.woId,
      remediation: ctx.remediation,
    },
  };

  const { runEscalation } = await import('../../overseer/src/escalate');
  await runEscalation(ctx.runId ?? `cascade-${randomUUID()}`, decision, {
    errorClass: ctx.errorClass as ErrorClass,
    woId: ctx.woId,
    remediation: ctx.remediation,
  });
}
