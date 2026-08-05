import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '../adapters';
import { runConformanceMatrix, type ConformanceOptions, type SeatUnderTest } from './conformance';
import { writeStub, type StubAgentMode } from './session.test';

async function stubSeat(mode: StubAgentMode, id = `stub-${mode}`): Promise<SeatUnderTest> {
  const { script, cwd } = await writeStub(mode);
  const config: AgentConfig = {
    kind: 'acp',
    command: process.execPath,
    args: [script],
    acp: {
      ...(mode === 'auth-reject' ? { authMethodId: 'cached_token' } : {}),
      idleTimeoutMs: mode === 'hang' ? 400 : 2_000,
      wallClockMs: 2_000,
      killGraceMs: 750,
    },
  };
  return { id, config, cwd };
}

async function conformingOptions(): Promise<ConformanceOptions> {
  return {
    cancellationSeat: await stubSeat('spawn-child'),
    forcedFailureSeat: await stubSeat('auth-reject'),
    timeoutSeat: await stubSeat('hang'),
    cancelAfterMs: 500,
  };
}

describe('ACP evidence-contract conformance matrix', () => {
  test('fails loud when raw cancellation cleanup evidence is absent', async () => {
    const report = await runConformanceMatrix(
      await stubSeat('ok', 'future-acp-seat'),
      await conformingOptions()
    );
    expect(report.allGreen).toBe(false);
    expect(Object.keys(report.tests)).toHaveLength(4);
    expect(report.tests.largePayload.pass).toBe(true);
    expect(report.tests.forcedFailure.pass).toBe(true);
    expect(report.tests.receiptAudit.pass).toBe(true);
    expect(report.tests.cancellation.pass).toBe(false);
    expect(report.tests.largePayload.evidence.promptBytes).toBeGreaterThanOrEqual(61_440);
    expect(report.tests.largePayload.evidence.receivedPromptBytes).toBe(
      report.tests.largePayload.evidence.promptBytes
    );
    expect(report.tests.cancellation.evidence.treeBeforeKill).toEqual([]);
    expect(report.tests.cancellation.evidence.treeBeforeKill).toEqual(
      report.tests.cancellation.evidence.result.treeBeforeKill
    );
    expect(report.tests.cancellation.evidence.treeAfterKill).toEqual([]);
  }, 30_000);

  test('a large-payload failure makes allGreen false without hiding other verdicts', async () => {
    const report = await runConformanceMatrix(await stubSeat('empty'), await conformingOptions());
    expect(report.tests.largePayload.pass).toBe(false);
    expect(report.allGreen).toBe(false);
    expect(Object.keys(report.tests)).toHaveLength(4);
  }, 30_000);

  test('a mismatched agent byte-count receipt fails the large-payload gate', async () => {
    const report = await runConformanceMatrix(
      await stubSeat('wrong-byte-count'),
      await conformingOptions()
    );
    expect(report.tests.largePayload.evidence.receivedPromptBytes).toBe(1);
    expect(report.tests.largePayload.pass).toBe(false);
    expect(report.allGreen).toBe(false);
  }, 30_000);

  test('a cancellation failure makes allGreen false', async () => {
    const opts = await conformingOptions();
    opts.cancellationSeat = await stubSeat('empty');
    const report = await runConformanceMatrix(await stubSeat('ok'), opts);
    expect(report.tests.cancellation.pass).toBe(false);
    expect(report.allGreen).toBe(false);
  }, 30_000);

  test('a forced-failure mismatch makes allGreen false', async () => {
    const opts = await conformingOptions();
    opts.forcedFailureSeat = await stubSeat('ok');
    const report = await runConformanceMatrix(await stubSeat('ok'), opts);
    expect(report.tests.forcedFailure.pass).toBe(false);
    expect(report.allGreen).toBe(false);
  }, 30_000);

  test('a receipt-audit timeout mismatch makes allGreen false', async () => {
    const opts = await conformingOptions();
    opts.timeoutSeat = await stubSeat('ok');
    const report = await runConformanceMatrix(await stubSeat('ok'), opts);
    expect(report.tests.receiptAudit.pass).toBe(false);
    expect(report.allGreen).toBe(false);
  }, 30_000);

  test('cached_token expiry fails loud with an auth reason inside timeout', async () => {
    const authSeat = await stubSeat('auth-reject', 'expired-token-seat');
    const report = await runConformanceMatrix(await stubSeat('ok'), {
      ...(await conformingOptions()),
      forcedFailureSeat: authSeat,
    });
    const evidence = report.tests.forcedFailure.evidence;
    expect(report.tests.forcedFailure.pass).toBe(true);
    expect(evidence.result.ok).toBe(false);
    expect(evidence.insideTimeout).toBe(true);
    expect(evidence.result.error ?? '').toMatch(/auth|token/i);
  }, 30_000);
});
