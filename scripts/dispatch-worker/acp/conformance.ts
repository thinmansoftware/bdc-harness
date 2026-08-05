/**
 * Seat-parameterized ACP evidence-contract conformance harness.
 *
 * WO-HARNESS-GROK-ACP-PROMOTION-01 (M-126 disposition T3/T4/T5, RATIFIED 3-0
 * 2026-08-04). Implements the ratified four-test acceptance matrix plus the two
 * Grok promotion gates, but hardcodes NO seat: any ACP seat (a stub, grok-acp,
 * or a future codex/claude leg) is expressed as a `SeatUnderTest` and driven
 * through the SAME matrix. This module EXERCISES the existing Order-4
 * implementation in ./session (runAcpAgent) and ./kill-tree; it does not
 * reimplement it.
 *
 * The four matrix tests (T5 wording):
 *   1. Large payload round-trip -- a >= 60KB prompt reaches the agent IN FULL
 *      and the returned receipt proves it: a run-unique nonce placed at the
 *      very TAIL of the payload comes back in this run's receipt. Payload
 *      length alone is not accepted as proof of delivery.
 *   2. Cancel mid-generation -- cancellation stops work, the durable record says
 *      cancelled, a live process tree was actually observed (treeBeforeKill
 *      non-empty), and no tracked descendant survives the kill (treeAfterKill
 *      empty).
 *   3. Forced failure -- the seat's OWN declared failure leg (bad auth, or a
 *      leg that dies or hangs mid-run) produces an honest failed result with a
 *      reason, attributably classified, inside a budget derived from the
 *      configured timeouts: never ok, never a hang (Gate A honest-failure +
 *      Gate B cached_token-expiry-fails-loud).
 *   4. Receipt audit -- every run above produced a durable receipt whose
 *      contents match what actually happened.
 *
 * allGreen is true ONLY when all four tests explicitly reported pass; it is
 * never true when any test is absent or errored.
 */
import { randomBytes } from 'node:crypto';
import {
  runAcpAgent,
  createCancelController,
  type AcpRunConfig,
  type AcpRunResult,
} from './session';
import {
  type AgentConfig,
  ACP_DEFAULT_IDLE_TIMEOUT_MS,
  ACP_DEFAULT_WALL_CLOCK_MS,
  ACP_DEFAULT_KILL_GRACE_MS,
} from '../adapters';

/** The ratified T5 floor for the large-payload round-trip: 60 KiB. */
export const MIN_ROUND_TRIP_BYTES = 61_440;
const DEFAULT_CANCEL_AFTER_MS = 1_500;
/**
 * Slack added on top of the configured timeouts before the forced-failure test
 * calls a run "stuck". Covers process spawn and reporting overhead only.
 */
const FORCED_FAILURE_MARGIN_MS = 5_000;

/**
 * A seat to run the conformance matrix against. Seat-agnostic by construction:
 * the harness never inspects `id`, so grok-acp, a stub, and future legs are all
 * expressible.
 */
export interface SeatUnderTest {
  /** Human-readable seat id (for example a grok ACP seat); recorded, never branched on. */
  id: string;
  /** The conforming config, used for the round-trip and receipt-audit tests. */
  config: AgentConfig;
  /**
   * Config exercised by the cancel test (long-running, cancellable work).
   * Defaults to `config`; a real binary is driven with a generative prompt and
   * an external cancel timer, while stubs pass a variant that hangs and does
   * not cooperate with cancellation (forcing the bounded tree-kill).
   */
  cancelConfig?: AgentConfig;
  /**
   * REQUIRED. The seat's own failure leg, exercised by the forced-failure test.
   * It MUST fail the way a real seat fails: bad or expired auth (Gate B), or a
   * leg that dies or hangs mid-run.
   *
   * There is deliberately NO default. An earlier revision substituted a
   * guaranteed-missing binary when this was omitted, which only proved that the
   * runtime reports a spawn error -- it never exercised the CONFIGURED ACP leg
   * failing auth or dying mid-run, so a seat could go green on Gate A without
   * its real failure path ever running. Declaring this is the seat owner's job.
   */
  failureConfig: AgentConfig;
  /** Working directory for spawned agents; defaults to process.cwd(). */
  cwd?: string;
}

/** Timeouts and payload sizing for a matrix run. All optional. */
export interface ConformanceOptions {
  /** Round-trip prompt size in bytes; clamped up to MIN_ROUND_TRIP_BYTES. */
  promptBytes?: number;
  idleTimeoutMs?: number;
  wallClockMs?: number;
  killGraceMs?: number;
  /** When to fire the external cancel in the cancel test. */
  cancelAfterMs?: number;
}

/** One matrix test's verdict plus the evidence that decided it. */
export interface ConformanceTestResult {
  name: string;
  pass: boolean;
  /** The concrete data that decided the verdict (receipt, tree pids, reason). */
  evidence: Record<string, unknown>;
  /** Populated when the test errored rather than producing a clean verdict. */
  detail?: string;
}

/** The full matrix result for one seat. */
export interface ConformanceReport {
  seatId: string;
  roundTrip: ConformanceTestResult;
  cancel: ConformanceTestResult;
  forcedFailure: ConformanceTestResult;
  receiptAudit: ConformanceTestResult;
  /** True ONLY when all four tests explicitly reported pass. */
  allGreen: boolean;
}

interface ScenarioRun {
  result: AcpRunResult | null;
  test: ConformanceTestResult;
}

function toRunConfig(config: AgentConfig, cwd: string, opts: ConformanceOptions): AcpRunConfig {
  return {
    command: config.command,
    args: [...config.args],
    cwd,
    ...(config.acp?.authMethodId ? { authMethodId: config.acp.authMethodId } : {}),
    idleTimeoutMs: opts.idleTimeoutMs ?? config.acp?.idleTimeoutMs ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
    wallClockMs: opts.wallClockMs ?? config.acp?.wallClockMs ?? ACP_DEFAULT_WALL_CLOCK_MS,
    killGraceMs: opts.killGraceMs ?? config.acp?.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * A run-unique token. Lowercase hex so it survives an agent that normalizes
 * case, and prefixed so a seat can locate it without knowing the payload shape.
 */
function createEchoNonce(): string {
  return `ACP_ECHO_${randomBytes(12).toString('hex')}`;
}

/**
 * Builds the >= 60KB round-trip payload. The nonce appears ONLY on the final
 * line, after the filler: an agent can echo it back only if the WHOLE payload
 * reached it, which is what makes the echo a delivery proof rather than a
 * liveness ping.
 */
function buildRoundTripPrompt(bytes: number, nonce: string): string {
  const head =
    'Reply with ONLY the token that appears at the very END of this message, ' +
    'on the line beginning END_OF_PAYLOAD. Reply with nothing else.\n';
  const tail = `\nEND_OF_PAYLOAD ${nonce}\n`;
  const target = Math.max(bytes, MIN_ROUND_TRIP_BYTES);
  const fillerLength = target - head.length - tail.length;
  if (fillerLength <= 0) return head + tail;
  return head + 'x'.repeat(fillerLength) + tail;
}

/**
 * The wall-clock budget a forced failure must return inside. Worst honest path:
 * the wall-clock timeout elapses, then killGraceMs before the tree kill, then
 * killGraceMs waiting for tree death, then the exit-code race (killGraceMs + 1s).
 * Anything past that plus a small margin is a stuck dispatch, not a failure.
 */
function forcedFailureBudgetMs(run: AcpRunConfig): number {
  return run.wallClockMs + run.killGraceMs * 3 + 1_000 + FORCED_FAILURE_MARGIN_MS;
}

async function runRoundTrip(
  seat: SeatUnderTest,
  opts: ConformanceOptions
): Promise<{ result: AcpRunResult; test: ConformanceTestResult }> {
  const cwd = seat.cwd ?? process.cwd();
  const nonce = createEchoNonce();
  const prompt = buildRoundTripPrompt(opts.promptBytes ?? MIN_ROUND_TRIP_BYTES, nonce);
  const result = await runAcpAgent(toRunConfig(seat.config, cwd, opts), prompt);
  // Delivery proof. The receipt is searched across BOTH the assembled text and
  // the raw update stream, so an agent that echoes inside a structured update
  // still counts. Because the nonce is unique per run AND lives only at the
  // payload tail, a hit proves two things at once: the agent received the
  // COMPLETE payload, and this receipt belongs to THIS run rather than a
  // cached or replayed transcript.
  const receiptText = `${result.finalText}\n${safeJson(result.updates)}`;
  const tailEchoed = receiptText.includes(nonce);
  const sentFullPayload = prompt.length >= MIN_ROUND_TRIP_BYTES;
  const pass = result.ok && result.updates.length > 0 && sentFullPayload && tailEchoed;
  return {
    result,
    test: {
      name: 'large-payload-round-trip',
      pass,
      evidence: {
        promptBytes: prompt.length,
        minRequiredBytes: MIN_ROUND_TRIP_BYTES,
        sentFullPayload,
        tailNonce: nonce,
        tailEchoed,
        ok: result.ok,
        stopReason: result.stopReason,
        updateCount: result.updates.length,
        finalTextLength: result.finalText.length,
        ...(result.error ? { error: result.error } : {}),
      },
    },
  };
}

async function runCancel(
  seat: SeatUnderTest,
  opts: ConformanceOptions
): Promise<{ result: AcpRunResult; test: ConformanceTestResult }> {
  const cwd = seat.cwd ?? process.cwd();
  const config = seat.cancelConfig ?? seat.config;
  const cancel = createCancelController();
  const cancelAfterMs = opts.cancelAfterMs ?? DEFAULT_CANCEL_AFTER_MS;
  const timer = setTimeout(() => {
    cancel.cancel();
  }, cancelAfterMs);
  timer.unref?.();
  let result: AcpRunResult;
  try {
    result = await runAcpAgent(
      toRunConfig(config, cwd, opts),
      'Generate a very long, detailed response and keep going.',
      cancel
    );
  } finally {
    clearTimeout(timer);
  }
  // Gate A: bounded cancellation with descendant cleanup. All four conditions
  // are load-bearing:
  //   - cancelled            the durable record says cancelled, so the turn did
  //                          not silently complete instead
  //   - agentPid !== null    a real agent process actually ran
  //   - treeBeforeKill > 0   a LIVE process tree was observed at kill time.
  //                          Without this the next condition is vacuous: an
  //                          empty-before / empty-after pair "proves" cleanup of
  //                          nothing. session.ts accumulates this snapshot
  //                          across its two kill passes precisely so this gate
  //                          cannot be satisfied by an already-dead sample.
  //   - treeAfterKill === 0  nothing from that tree survived the kill.
  const observedLiveTree = result.treeBeforeKill.length > 0;
  const pass =
    result.cancelled &&
    result.agentPid !== null &&
    observedLiveTree &&
    result.treeAfterKill.length === 0;
  return {
    result,
    test: {
      name: 'cancel-mid-generation',
      pass,
      evidence: {
        cancelled: result.cancelled,
        agentPid: result.agentPid,
        observedLiveTree,
        treeBeforeKill: result.treeBeforeKill,
        treeAfterKill: result.treeAfterKill,
        // Descendants beyond the agent process itself. A seat whose agent
        // spawns children must show these reaped; recorded either way.
        descendantCount: Math.max(result.treeBeforeKill.length - 1, 0),
        timedOut: result.timedOut,
      },
    },
  };
}

async function runForcedFailure(
  seat: SeatUnderTest,
  opts: ConformanceOptions
): Promise<{ result: AcpRunResult; test: ConformanceTestResult }> {
  const cwd = seat.cwd ?? process.cwd();
  const runConfig = toRunConfig(seat.failureConfig, cwd, opts);
  const result = await runAcpAgent(runConfig, 'anything');
  const reason = result.error ?? '';
  const budgetMs = forcedFailureBudgetMs(runConfig);
  const withinBudget = result.durationMs <= budgetMs;
  // Gate A honest-failure taxonomy. The failure must be ATTRIBUTABLE, not just
  // present. Exactly one of these must hold:
  //   - timeoutHonest: the leg hung and a bounded idle/wall timeout fired and
  //     classified it. This is the honest-timeout behavior Gate A requires.
  //   - fastFail: the leg reported a real error (bad auth, dead child) without
  //     needing a timeout at all.
  // A run that came back cancelled with NO timeout recorded was stopped by
  // something we cannot attribute, which is not an honest failure.
  const timeoutHonest = result.timedOut !== null;
  const fastFail = !result.cancelled && result.timedOut === null;
  const honestlyClassified = timeoutHonest || fastFail;
  const failureMode = timeoutHonest ? 'bounded-timeout' : fastFail ? 'fast-fail' : 'unattributable';
  const pass = !result.ok && reason.length > 0 && withinBudget && honestlyClassified;
  return {
    result,
    test: {
      name: 'forced-failure-fails-loud',
      pass,
      evidence: {
        ok: result.ok,
        reason,
        cancelled: result.cancelled,
        timedOut: result.timedOut,
        honestlyClassified,
        failureMode,
        durationMs: result.durationMs,
        budgetMs,
        withinBudget,
      },
    },
  };
}

function auditReceipts(
  roundTrip: AcpRunResult | null,
  roundTripTest: ConformanceTestResult,
  cancel: AcpRunResult | null,
  forced: AcpRunResult | null
): ConformanceTestResult {
  const cancelCleanupSupported =
    cancel !== null &&
    (!cancel.cancelled || (cancel.treeBeforeKill.length > 0 && cancel.treeAfterKill.length === 0));
  const checks: { name: string; ok: boolean }[] = [
    { name: 'round-trip-present', ok: roundTrip !== null },
    {
      name: 'round-trip-ok-implies-nonempty-receipt',
      ok: roundTrip !== null && (!roundTrip.ok || roundTrip.updates.length > 0),
    },
    {
      name: 'round-trip-not-falsely-ok-on-empty-receipt',
      ok: roundTrip !== null && !(roundTrip.ok && roundTrip.updates.length === 0),
    },
    {
      // The receipt must be traceable to THIS run's payload, not merely present.
      name: 'round-trip-receipt-matches-this-run',
      ok: roundTrip !== null && roundTripTest.evidence.tailEchoed === true,
    },
    { name: 'cancel-present', ok: cancel !== null },
    {
      name: 'cancel-record-consistent',
      ok: cancel !== null && (!cancel.cancelled || !cancel.ok),
    },
    {
      // A cancelled record must be backed by an observed live tree that is now
      // gone; otherwise the cleanup claim in the receipt is unsupported.
      name: 'cancel-tree-evidence-supports-cleanup-claim',
      ok: cancelCleanupSupported,
    },
    {
      name: 'forced-failure-honest-with-reason',
      ok: forced !== null && !forced.ok && (forced.error ?? '').length > 0,
    },
  ];
  const pass = checks.every(check => check.ok);
  return {
    name: 'receipt-audit',
    pass,
    evidence: { checks },
  };
}

async function safeScenario(
  name: string,
  fn: () => Promise<{ result: AcpRunResult; test: ConformanceTestResult }>
): Promise<ScenarioRun> {
  try {
    return await fn();
  } catch (error) {
    return {
      result: null,
      test: {
        name,
        pass: false,
        evidence: {},
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Runs ALL FOUR ratified acceptance tests against `seat` and returns a
 * structured verdict per test plus an overall allGreen boolean. A thrown test
 * is recorded as a non-passing result (never silently dropped), so allGreen is
 * never true when any test is absent or errored.
 */
export async function runConformanceMatrix(
  seat: SeatUnderTest,
  opts: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const roundTrip = await safeScenario('large-payload-round-trip', () => runRoundTrip(seat, opts));
  const cancel = await safeScenario('cancel-mid-generation', () => runCancel(seat, opts));
  const forcedFailure = await safeScenario('forced-failure-fails-loud', () =>
    runForcedFailure(seat, opts)
  );
  const receiptAudit = auditReceipts(
    roundTrip.result,
    roundTrip.test,
    cancel.result,
    forcedFailure.result
  );

  const allGreen =
    roundTrip.test.pass && cancel.test.pass && forcedFailure.test.pass && receiptAudit.pass;

  return {
    seatId: seat.id,
    roundTrip: roundTrip.test,
    cancel: cancel.test,
    forcedFailure: forcedFailure.test,
    receiptAudit,
    allGreen,
  };
}
