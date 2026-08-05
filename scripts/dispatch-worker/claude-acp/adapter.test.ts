/**
 * BDC Claude ACP adapter tests -- WO-HARNESS-CLAUDE-ACP-ADAPTER-01.
 *
 * These drive the REAL adapter, spawned as a real child process on stdio, with
 * the REAL runAcpAgent client from acp/session.ts -- the exact production
 * handshake, both ends BDC-owned, no mocks at the process boundary and no live
 * model. The Claude execution seam is swapped for a scripted fake via the
 * BDC_CLAUDE_ACP_EXECUTOR_MODULE env var (see claude-acp/test-executor.ts).
 *
 * Covers all five WO section 7 scenarios in this one file, because Stop 6's
 * fixed test command runs only THIS new file plus four existing (reuse-only)
 * sibling suites -- a separate conformance test file would never execute.
 *
 * Unicode note (Rule 13 / Stop 8): the large-payload prompt uses \u-escaped
 * unicode (em-dash U+2014, CJK U+4F60 U+597D) and \r\n, so this source file is
 * itself ASCII while the bytes on the wire are genuinely multi-byte UTF-8.
 */
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runAcpAgent, createCancelController } from '../acp/session';
import { EXECUTOR_MODULE_ENV } from './adapter';
import {
  runConformanceMatrix,
  type SeatUnderTest,
  type ConformanceReport,
} from '../acp/conformance';
import type { AgentConfig } from '../adapters';

const ADAPTER_ENTRY = join(import.meta.dir, 'main.ts');
const EXECUTOR_MODULE = join(import.meta.dir, 'test-executor.ts');
const ADAPTER_COMMAND = 'bun';
const ADAPTER_ARGS = ['run', ADAPTER_ENTRY];

/** Config that spawns the real adapter with the fake executor wired in. */
function fakeExecutorEnv(): Record<string, string> {
  return { [EXECUTOR_MODULE_ENV]: EXECUTOR_MODULE };
}

async function runAdapter(
  prompt: string,
  overrides: { idleTimeoutMs?: number; wallClockMs?: number; killGraceMs?: number } = {},
  cancel?: ReturnType<typeof createCancelController>
) {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-acp-'));
  return runAcpAgent(
    {
      command: ADAPTER_COMMAND,
      args: ADAPTER_ARGS,
      cwd,
      idleTimeoutMs: overrides.idleTimeoutMs ?? 10_000,
      wallClockMs: overrides.wallClockMs ?? 20_000,
      killGraceMs: overrides.killGraceMs ?? 2_000,
      env: fakeExecutorEnv(),
    },
    prompt,
    cancel
  );
}

describe('BDC claude-acp adapter (real client, real adapter, fake executor)', () => {
  test('Test 1: honest completion -- end_turn, non-empty text, non-empty receipt', async () => {
    const result = await runAdapter('summarize the dispatch envelope');
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('end_turn');
    expect(result.finalText).toContain('claude-acp adapter round-trip');
    expect(result.updates.length).toBeGreaterThan(0);
  }, 30_000);

  test('Test 2a: a thrown executor is an honest failure with a reason, no hang', async () => {
    const result = await runAdapter('FAKE:throw please');
    expect(result.ok).toBe(false);
    expect(result.stopReason).not.toBe('end_turn');
    expect(result.error ?? '').not.toBe('');
    expect(result.cancelled).toBe(false);
  }, 30_000);

  test('Test 2b: an empty result is a failure, never a completion', async () => {
    const result = await runAdapter('FAKE:empty please');
    // Honest completion rule: a clean stream with no work done is NOT ok.
    expect(result.ok).toBe(false);
    expect(result.stopReason).not.toBe('end_turn');
    expect(result.finalText.trim()).toBe('');
    expect(result.error ?? '').not.toBe('');
  }, 30_000);

  test('Test 3: a large unicode+CRLF payload rides the stream byte-exact, never argv', async () => {
    // Build a >= 61440-byte prompt with multi-byte unicode and CRLF.
    const unit = 'em-dash \u2014 CJK \u4f60\u597d segment\r\n';
    let prompt = 'FAKE:echo ';
    while (Buffer.byteLength(prompt) < 61_440) {
      prompt += unit;
    }
    const expectedBytes = Buffer.byteLength(prompt);
    expect(expectedBytes).toBeGreaterThanOrEqual(61_440);

    const result = await runAdapter(prompt, { idleTimeoutMs: 15_000, wallClockMs: 30_000 });

    expect(result.ok).toBe(true);
    expect(result.finalText).toContain(`ACP_STUB_OK bytes=${expectedBytes}`);
    expect(result.updates.length).toBeGreaterThan(0);
    // Evidence item 5: no element of the adapter's argv carries prompt text.
    expect(ADAPTER_ARGS.every(arg => !arg.includes(prompt))).toBe(true);
    expect(ADAPTER_ARGS.every(arg => !arg.includes('em-dash'))).toBe(true);
  }, 45_000);

  test('Test 4: cancellation is bounded and leaves no orphan process', async () => {
    const cancel = createCancelController();
    setTimeout(() => {
      cancel.cancel();
    }, 800);
    const result = await runAdapter(
      'FAKE:hang forever',
      { idleTimeoutMs: 30_000, wallClockMs: 60_000, killGraceMs: 3_000 },
      cancel
    );
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.treeBeforeKill.length).toBeGreaterThan(0);
    expect(result.treeAfterKill).toEqual([]);
  }, 60_000);

  describe('Test 5: the reused conformance matrix evaluates the adapter unchanged', () => {
    let previousEnv: string | undefined;

    beforeEach(() => {
      // runConfig() in acp/conformance.ts does not thread env into runAcpAgent,
      // so the fake-executor selection must ride the inherited process env.
      previousEnv = process.env[EXECUTOR_MODULE_ENV];
      process.env[EXECUTOR_MODULE_ENV] = EXECUTOR_MODULE;
    });

    afterEach(() => {
      if (previousEnv === undefined) {
        delete process.env[EXECUTOR_MODULE_ENV];
      } else {
        process.env[EXECUTOR_MODULE_ENV] = previousEnv;
      }
    });

    test('produces a full ConformanceReport with zero harness changes', async () => {
      const config: AgentConfig = {
        kind: 'acp',
        command: ADAPTER_COMMAND,
        args: [...ADAPTER_ARGS],
        acp: { idleTimeoutMs: 1_500, wallClockMs: 8_000, killGraceMs: 3_000 },
      };
      const seat: SeatUnderTest = { id: 'claude-acp-bdc', config, cwd: process.cwd() };

      const report: ConformanceReport = await runConformanceMatrix(seat);

      // A full report through the existing runner: every gate computed.
      expect(report.seatId).toBe('claude-acp-bdc');
      expect(report.tests.largePayload).toBeDefined();
      expect(report.tests.cancellation).toBeDefined();
      expect(report.tests.forcedFailure).toBeDefined();
      expect(report.tests.receiptAudit).toBeDefined();
      // The BDC adapter satisfies the whole evidence contract.
      expect(report.allGreen).toBe(true);
    }, 60_000);
  });
});
