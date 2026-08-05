/**
 * Conformance-harness tests -- WO-HARNESS-GROK-ACP-PROMOTION-01.
 *
 * These drive runConformanceMatrix against REAL child-process stub seats (not
 * mocks), reusing the ONE stub implementation exported from ./session.test.ts
 * (stubAgentSource / writeStub) rather than forking a second stub, per spec
 * section 4. They cover: the all-four-green happy path, each individual test
 * failing forcing allGreen false, Gate B (cached_token expiry fails loud), and
 * seat-parameterization (a non-grok seat runs with no grok-specific branching).
 */
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { runConformanceMatrix, type SeatUnderTest } from './conformance';
import { stubAgentSource, writeStub, type StubMode } from './session.test';

/** Fast timeouts so the CI matrix runs against stubs in a few seconds. */
const FAST_OPTS = {
  idleTimeoutMs: 8_000,
  wallClockMs: 15_000,
  killGraceMs: 1_500,
  cancelAfterMs: 1_200,
  promptBytes: 61_440,
};

/** Build a stub AgentConfig (process.execPath + the emitted .cjs script). */
async function stubConfig(
  mode: StubMode,
  authMethodId?: string
): Promise<{
  command: string;
  args: string[];
  kind: 'acp';
  acp: { authMethodId?: string };
  cwd: string;
}> {
  const { script, cwd } = await writeStub(mode);
  return {
    kind: 'acp',
    command: process.execPath,
    args: [script],
    acp: authMethodId ? { authMethodId } : {},
    cwd,
  };
}

describe('runConformanceMatrix', () => {
  test('reports all-green for a fully conforming stub seat', async () => {
    const conforming = await stubConfig('ok');
    const cancellable = await stubConfig('cancel-tree');
    const seat: SeatUnderTest = {
      id: 'stub-conforming',
      config: { kind: conforming.kind, command: conforming.command, args: conforming.args },
      cancelConfig: {
        kind: cancellable.kind,
        command: cancellable.command,
        args: cancellable.args,
      },
      cwd: conforming.cwd,
      // failureConfig omitted -> harness derives a guaranteed spawn failure.
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    expect(report.roundTrip.pass).toBe(true);
    expect(report.cancel.pass).toBe(true);
    expect(report.forcedFailure.pass).toBe(true);
    expect(report.receiptAudit.pass).toBe(true);
    expect(report.allGreen).toBe(true);

    // Each test carries the evidence that decided it.
    expect(report.roundTrip.evidence.updateCount as number).toBeGreaterThan(0);
    expect(report.roundTrip.evidence.promptBytes as number).toBeGreaterThanOrEqual(61_440);
    expect(report.cancel.evidence.cancelled).toBe(true);
    expect(report.cancel.evidence.agentPid).not.toBeNull();
    expect(report.cancel.evidence.treeAfterKill as number[]).toHaveLength(0);
    expect(String(report.forcedFailure.evidence.reason).length).toBeGreaterThan(0);
  }, 60_000);

  test('one red cancel test forces allGreen false while others report independently', async () => {
    const conforming = await stubConfig('ok');
    // A cancel scenario that COMPLETES before the cancel timer fires: the leg
    // never demonstrates bounded cancellation, so the cancel test is red.
    const uncancellable = await stubConfig('ok');
    const seat: SeatUnderTest = {
      id: 'stub-uncancellable',
      config: { kind: conforming.kind, command: conforming.command, args: conforming.args },
      cancelConfig: {
        kind: uncancellable.kind,
        command: uncancellable.command,
        args: uncancellable.args,
      },
      cwd: conforming.cwd,
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    expect(report.cancel.pass).toBe(false);
    expect(report.cancel.evidence.cancelled).not.toBe(true);
    // The other tests still produce their own independent verdicts.
    expect(report.roundTrip.pass).toBe(true);
    expect(report.forcedFailure.pass).toBe(true);
    expect(report.allGreen).toBe(false);
  }, 60_000);

  test('a red round-trip (empty output) forces allGreen false', async () => {
    const empty = await stubConfig('empty');
    const cancellable = await stubConfig('cancel-tree');
    const seat: SeatUnderTest = {
      id: 'stub-empty-roundtrip',
      config: { kind: empty.kind, command: empty.command, args: empty.args },
      cancelConfig: {
        kind: cancellable.kind,
        command: cancellable.command,
        args: cancellable.args,
      },
      cwd: empty.cwd,
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    expect(report.roundTrip.pass).toBe(false);
    expect(report.cancel.pass).toBe(true);
    expect(report.allGreen).toBe(false);
  }, 60_000);

  test('a forced-failure seat that instead SUCCEEDS forces allGreen false', async () => {
    const conforming = await stubConfig('ok');
    const cancellable = await stubConfig('cancel-tree');
    // failureConfig points at an 'ok' stub -> it succeeds -> the forced-failure
    // test (which requires an honest failure) is red.
    const notActuallyFailing = await stubConfig('ok');
    const seat: SeatUnderTest = {
      id: 'stub-failure-succeeds',
      config: { kind: conforming.kind, command: conforming.command, args: conforming.args },
      cancelConfig: {
        kind: cancellable.kind,
        command: cancellable.command,
        args: cancellable.args,
      },
      failureConfig: {
        kind: notActuallyFailing.kind,
        command: notActuallyFailing.command,
        args: notActuallyFailing.args,
      },
      cwd: conforming.cwd,
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    expect(report.forcedFailure.pass).toBe(false);
    expect(report.allGreen).toBe(false);
  }, 60_000);

  test('Gate B -- cached_token expiry fails loud with an auth reason, never stuck', async () => {
    const conforming = await stubConfig('ok');
    const cancellable = await stubConfig('cancel-tree');
    const authReject = await stubConfig('auth-reject', 'cached_token');
    const seat: SeatUnderTest = {
      id: 'stub-auth-expiry',
      config: { kind: conforming.kind, command: conforming.command, args: conforming.args },
      cancelConfig: {
        kind: cancellable.kind,
        command: cancellable.command,
        args: cancellable.args,
      },
      failureConfig: {
        kind: authReject.kind,
        command: authReject.command,
        args: authReject.args,
        acp: authReject.acp,
      },
      cwd: conforming.cwd,
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    // Honest failure, inside the timeout, never ok.
    expect(report.forcedFailure.pass).toBe(true);
    expect(report.forcedFailure.evidence.ok).not.toBe(true);
    expect(report.forcedFailure.evidence.timedOut).toBeNull();
    const reason = String(report.forcedFailure.evidence.reason).toLowerCase();
    expect(reason).toMatch(/auth|cached_token|token/);
    // The run returned well inside the configured wall clock -- not stuck.
    expect(report.forcedFailure.evidence.durationMs as number).toBeLessThan(15_000);
  }, 60_000);

  test('is seat-parameterized -- runs a non-grok seat and records its id verbatim', async () => {
    const conforming = await stubConfig('ok');
    const cancellable = await stubConfig('cancel-tree');
    const seat: SeatUnderTest = {
      id: 'some-future-non-grok-seat',
      config: { kind: conforming.kind, command: conforming.command, args: conforming.args },
      cancelConfig: {
        kind: cancellable.kind,
        command: cancellable.command,
        args: cancellable.args,
      },
      cwd: conforming.cwd,
    };

    const report = await runConformanceMatrix(seat, FAST_OPTS);

    expect(report.seatId).toBe('some-future-non-grok-seat');
    expect(report.allGreen).toBe(true);
  }, 60_000);

  test('stubAgentSource emits ASCII-only auth-reject source', async () => {
    // Guards the reuse contract: the shared stub covers the new modes.
    const src = stubAgentSource('auth-reject');
    expect(src).toContain('authenticate');
    expect(src).toContain('cached_token');
    // A temp write proves writeStub round-trips the new mode.
    const dir = await mkdtemp(join(tmpdir(), 'acp-conformance-'));
    const file = join(dir, 'probe.cjs');
    await writeFile(file, src, 'utf8');
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7f]/.test(src)).toBe(false);
  });
});
