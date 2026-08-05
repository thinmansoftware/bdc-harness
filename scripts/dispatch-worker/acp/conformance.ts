import {
  ACP_DEFAULT_IDLE_TIMEOUT_MS,
  ACP_DEFAULT_KILL_GRACE_MS,
  ACP_DEFAULT_WALL_CLOCK_MS,
  type AgentConfig,
} from '../adapters';
import {
  createCancelController,
  runAcpAgent,
  type AcpRunConfig,
  type AcpRunResult,
} from './session';

const MINIMUM_LARGE_PROMPT_BYTES = 61_440;

export interface SeatUnderTest {
  id: string;
  config: AgentConfig;
  cwd?: string;
}

export interface ConformanceOptions {
  largePayloadBytes?: number;
  cancelAfterMs?: number;
  cancellationSeat?: SeatUnderTest;
  forcedFailureSeat?: SeatUnderTest;
  timeoutSeat?: SeatUnderTest;
}

export interface DurableReceipt {
  seatId: string;
  outcome: 'completed' | 'cancelled' | 'failed';
  updates: unknown[];
  stopReason: string | null;
  error?: string;
}

export interface TestVerdict<Evidence> {
  pass: boolean;
  evidence: Evidence;
  error?: string;
}

export interface ConformanceReport {
  seatId: string;
  tests: {
    largePayload: TestVerdict<{
      promptBytes: number;
      receivedPromptBytes: number | null;
      result: AcpRunResult;
      receipt: DurableReceipt;
    }>;
    cancellation: TestVerdict<{
      result: AcpRunResult;
      receipt: DurableReceipt;
      treeBeforeKill: number[];
      treeAfterKill: number[];
    }>;
    forcedFailure: TestVerdict<{
      result: AcpRunResult;
      receipt: DurableReceipt;
      insideTimeout: boolean;
    }>;
    receiptAudit: TestVerdict<{
      receipts: DurableReceipt[];
      timeoutResult: AcpRunResult;
    }>;
  };
  allGreen: boolean;
}

function runConfig(seat: SeatUnderTest): AcpRunConfig {
  const acp = seat.config.acp ?? {};
  return {
    command: seat.config.command,
    args: [...seat.config.args],
    cwd: seat.cwd ?? process.cwd(),
    ...(acp.authMethodId ? { authMethodId: acp.authMethodId } : {}),
    idleTimeoutMs: acp.idleTimeoutMs ?? ACP_DEFAULT_IDLE_TIMEOUT_MS,
    wallClockMs: acp.wallClockMs ?? ACP_DEFAULT_WALL_CLOCK_MS,
    killGraceMs: acp.killGraceMs ?? ACP_DEFAULT_KILL_GRACE_MS,
  };
}

function receipt(seat: SeatUnderTest, result: AcpRunResult): DurableReceipt {
  const outcome = result.ok ? 'completed' : result.cancelled ? 'cancelled' : 'failed';
  return {
    seatId: seat.id,
    outcome,
    updates: result.updates,
    stopReason: result.stopReason,
    ...(result.error ? { error: result.error } : {}),
  };
}

function failure(message: string): AcpRunResult {
  return {
    ok: false,
    stopReason: null,
    finalText: '',
    updates: [],
    timedOut: null,
    cancelled: false,
    exitCode: null,
    agentPid: null,
    treeBeforeKill: [],
    treeAfterKill: [],
    durationMs: 0,
    error: message,
  };
}

async function safelyRun(
  seat: SeatUnderTest,
  prompt: string,
  cancelAfterMs?: number
): Promise<AcpRunResult> {
  try {
    if (cancelAfterMs === undefined) return await runAcpAgent(runConfig(seat), prompt);
    const controller = createCancelController();
    const timer = setTimeout(() => {
      controller.cancel();
    }, cancelAfterMs);
    try {
      return await runAcpAgent(runConfig(seat), prompt, controller);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

export async function runConformanceMatrix(
  seat: SeatUnderTest,
  opts: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const promptBytes = Math.max(
    opts.largePayloadBytes ?? MINIMUM_LARGE_PROMPT_BYTES,
    MINIMUM_LARGE_PROMPT_BYTES
  );
  const largePrompt = `BDC_ACP_CONFORMANCE:${'x'.repeat(promptBytes - 20)}`;
  const cancellationSeat = opts.cancellationSeat ?? seat;
  const forcedFailureSeat = opts.forcedFailureSeat ?? seat;
  const timeoutSeat = opts.timeoutSeat ?? forcedFailureSeat;

  const largeResult = await safelyRun(seat, largePrompt);
  const cancelResult = await safelyRun(
    cancellationSeat,
    'cancel mid-generation',
    opts.cancelAfterMs ?? 500
  );
  const failureStarted = Date.now();
  const forcedResult = await safelyRun(forcedFailureSeat, 'forced failure');
  const failureElapsed = Date.now() - failureStarted;
  const timeoutResult = await safelyRun(timeoutSeat, 'timeout honestly');

  const largeReceipt = receipt(seat, largeResult);
  const cancelReceipt = receipt(cancellationSeat, cancelResult);
  const forcedReceipt = receipt(forcedFailureSeat, forcedResult);
  const timeoutReceipt = receipt(timeoutSeat, timeoutResult);
  const receipts = [largeReceipt, cancelReceipt, forcedReceipt, timeoutReceipt];
  const largePromptBytes = Buffer.byteLength(largePrompt);
  const receivedPromptBytesMatch = /\bACP_STUB_OK bytes=(\d+)\b/.exec(largeResult.finalText);
  const receivedPromptBytes = receivedPromptBytesMatch ? Number(receivedPromptBytesMatch[1]) : null;

  const largePass =
    largePromptBytes >= MINIMUM_LARGE_PROMPT_BYTES &&
    largeResult.ok &&
    largeResult.updates.length > 0 &&
    receivedPromptBytes === largePromptBytes;
  const cancelPass =
    cancelResult.cancelled &&
    !cancelResult.ok &&
    cancelResult.treeBeforeKill.length > 0 &&
    cancelResult.treeAfterKill.length === 0;
  const forcedReason = forcedResult.error ?? '';
  const forcedLimit =
    runConfig(forcedFailureSeat).wallClockMs + runConfig(forcedFailureSeat).killGraceMs + 1_000;
  const forcedPass = !forcedResult.ok && forcedReason.length > 0 && failureElapsed <= forcedLimit;
  const timeoutPass =
    !timeoutResult.ok && timeoutResult.cancelled && timeoutResult.timedOut !== null;
  const receiptsMatch =
    largeReceipt.outcome === 'completed' &&
    largeReceipt.updates.length > 0 &&
    cancelReceipt.outcome === 'cancelled' &&
    forcedReceipt.outcome === 'failed' &&
    timeoutReceipt.outcome === 'cancelled';

  const tests: ConformanceReport['tests'] = {
    largePayload: {
      pass: largePass,
      evidence: {
        promptBytes: largePromptBytes,
        receivedPromptBytes,
        result: largeResult,
        receipt: largeReceipt,
      },
      ...(!largePass
        ? { error: 'large payload did not round-trip with a matching non-empty receipt' }
        : {}),
    },
    cancellation: {
      pass: cancelPass,
      evidence: {
        result: cancelResult,
        receipt: cancelReceipt,
        treeBeforeKill: cancelResult.treeBeforeKill,
        treeAfterKill: cancelResult.treeAfterKill,
      },
      ...(!cancelPass ? { error: 'cancellation did not prove bounded process-tree cleanup' } : {}),
    },
    forcedFailure: {
      pass: forcedPass,
      evidence: {
        result: forcedResult,
        receipt: forcedReceipt,
        insideTimeout: failureElapsed <= forcedLimit,
      },
      ...(!forcedPass ? { error: 'forced failure was not honest and bounded' } : {}),
    },
    receiptAudit: {
      pass: receiptsMatch && timeoutPass,
      evidence: { receipts, timeoutResult },
      ...(!(receiptsMatch && timeoutPass)
        ? { error: 'receipt audit did not match every observed outcome' }
        : {}),
    },
  };

  return { seatId: seat.id, tests, allGreen: Object.values(tests).every(test => test.pass) };
}
