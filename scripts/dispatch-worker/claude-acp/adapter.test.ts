import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { runConformanceMatrix, type SeatUnderTest } from '../acp/conformance';
import { createCancelController, runAcpAgent, type AcpRunConfig } from '../acp/session';

const entry = 'scripts/dispatch-worker/claude-acp/main.ts';

function config(mode: string, overrides: Partial<AcpRunConfig> = {}): AcpRunConfig {
  return {
    command: 'bun',
    args: [entry],
    cwd: process.cwd(),
    idleTimeoutMs: 5_000,
    wallClockMs: 10_000,
    killGraceMs: 1_000,
    env: { BDC_CLAUDE_ACP_TEST_EXECUTOR: mode },
    ...overrides,
  };
}

describe('BDC Claude ACP adapter', () => {
  test('real process and real client complete with a durable text receipt', async () => {
    const result = await runAcpAgent(config('ok'), 'hello adapter');
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toContain('ACP_STUB_OK');
    expect(result.updates.length).toBeGreaterThan(0);
  });

  test('executor errors are honest, bounded failures', async () => {
    const result = await runAcpAgent(config('throw'), 'fail honestly');
    expect(result.ok).toBe(false);
    expect(result.error?.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  test('empty executor output cannot pass honest completion', async () => {
    const result = await runAcpAgent(config('empty'), 'return no text');
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('end_turn');
    expect(result.error).toContain('empty_success_exit');
  });

  test('large unicode and CRLF payload is byte-identical and absent from argv', async () => {
    const unit = `line\r\n\u2014\u4e2d\u6587`;
    const prompt = unit.repeat(Math.ceil(61_440 / Buffer.byteLength(unit)) + 1);
    const expectedHash = createHash('sha256').update(prompt).digest('hex');
    expect(Buffer.byteLength(prompt)).toBeGreaterThanOrEqual(61_440);
    const result = await runAcpAgent(config('ok'), prompt);
    expect(result.ok).toBe(true);
    expect(result.finalText).toContain(`bytes=${Buffer.byteLength(prompt)}`);
    expect(result.finalText).toContain(`sha256=${expectedHash}`);
    expect(result.finalText).toContain('argv=[]');
    expect(result.finalText).not.toContain(prompt);
  });

  test('cancellation is bounded and leaves no adapter process alive', async () => {
    const cancel = createCancelController();
    setTimeout(() => cancel.cancel(), 500);
    const result = await runAcpAgent(
      config('hang', { killGraceMs: 2_000 }),
      'wait forever',
      cancel
    );
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe('cancelled');
    expect(result.treeAfterKill).toEqual([]);
  }, 15_000);

  test('existing conformance harness evaluates the adapter unchanged', async () => {
    const previous = process.env.BDC_CLAUDE_ACP_TEST_EXECUTOR;
    process.env.BDC_CLAUDE_ACP_TEST_EXECUTOR = 'matrix';
    const seat = (id: string, idleTimeoutMs: number, wallClockMs: number): SeatUnderTest => ({
      id,
      cwd: process.cwd(),
      config: {
        kind: 'acp',
        command: 'bun',
        args: [entry],
        acp: { idleTimeoutMs, wallClockMs, killGraceMs: 1_000 },
      },
    });
    try {
      const report = await runConformanceMatrix(seat('claude-acp-test', 3_000, 5_000), {
        cancelAfterMs: 500,
        cancellationSeat: seat('claude-acp-cancel', 3_000, 5_000),
        forcedFailureSeat: seat('claude-acp-failure', 3_000, 5_000),
        timeoutSeat: seat('claude-acp-timeout', 700, 5_000),
      });
      expect(Object.keys(report.tests)).toHaveLength(4);
      expect(report.allGreen).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BDC_CLAUDE_ACP_TEST_EXECUTOR;
      else process.env.BDC_CLAUDE_ACP_TEST_EXECUTOR = previous;
    }
  }, 30_000);
});
