/**
 * WO-HARNESS-SEAT-GATE-HONORS-FIRED-LANE-TIER-01: the conductor skips a rung
 * whose own seat is measured at or over the run-start seat cutoff, during
 * entry and during a climb. An UNKNOWN seat is never skipped on that basis,
 * and a run-start seat refusal climbs instead of counting as a quality fail.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCascade, type CascadeDeps } from '../cascade.js';
import type { SeatUsageSnapshot } from '../headroom.js';
import type { ConductorRuleset, GateVerdict, PollResult } from '../types.js';

const THRESHOLD_ENV = 'SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT';

function seat(used: number, name = 'primary') {
  return { limit_source: 'measured' as const, windows: [{ name, used_percent: used }] };
}

const HOT_CURSOR_HOT_CODEX_COOL_CLAUDE: SeatUsageSnapshot = {
  cursor: seat(98, 'monthly'),
  codex: seat(96),
  claude: seat(30, 'seven_day'),
};

function claimStubs(): Pick<CascadeDeps, 'findWoClaim' | 'acquireWoLock' | 'releaseWoLock'> {
  return {
    findWoClaim: async () => null,
    acquireWoLock: async (woId, project, cascadeId) => ({
      acquired: true,
      path: 'in-memory-test-lock',
      record: {
        woId,
        project,
        cascadeId,
        status: 'running',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    }),
    releaseWoLock: async () => {},
  };
}

function poll(runId: string, metadata: Record<string, unknown> = {}): PollResult {
  return {
    runId,
    terminalStatus: Object.keys(metadata).length > 0 ? 'failed' : 'completed',
    validatorVerdict: 'satisfied',
    prUrl: 'https://github.com/org/repo/pull/1',
    prMergeable: true,
    servedModelId: null,
    rawMetadata: metadata,
  };
}

function verdict(pass: boolean): GateVerdict {
  return {
    pass,
    reason: pass ? 'passed' : 'needs revision',
    cancelled: false,
    validatorVerdict: pass ? 'satisfied' : 'needs_revision',
    prOpened: pass,
    prMergeable: pass,
    terminalStatus: pass ? 'completed' : 'failed',
  };
}

function ruleset(entry: string): ConductorRuleset {
  return { defaultEntry: entry, rules: [] } as ConductorRuleset;
}

let previousThreshold: string | undefined;
let outDir = '';
let logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  previousThreshold = process.env[THRESHOLD_ENV];
  delete process.env[THRESHOLD_ENV];
  outDir = await mkdtemp(join(tmpdir(), 'cascade-seat-rung-'));
  logs = [];
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  logSpy?.mockRestore();
  if (previousThreshold === undefined) delete process.env[THRESHOLD_ENV];
  else process.env[THRESHOLD_ENV] = previousThreshold;
  await rm(outDir, { recursive: true, force: true });
});

describe('conductor seat-cutoff rung skip', () => {
  test('conductor_skips_rung_whose_seat_is_over_cutoff_and_fires_claude (entry)', async () => {
    // Headroom threshold 99 keeps chooseHeadroomEntry on cursor (98 < 99), so
    // only the new seat-cutoff skip can move the entry.
    process.env[THRESHOLD_ENV] = '99';
    const fired: string[] = [];
    const record = await runCascade({
      woId: 'WO-SEAT-RUNG-ENTRY',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('cursor'),
        seatUsage: async () => HOT_CURSOR_HOT_CODEX_COOL_CLAUDE,
        seatCutoff: async () => 95,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          return { ok: true, runId: `run-${fired.length}`, conversationId: 'c', infraError: null };
        },
        poll: async () => poll('run'),
        judge: () => verdict(true),
      },
    });
    expect(fired).toEqual(['bdc-feature-development']);
    expect(record.winningTier).toBe('claude');
    expect(record.attempts.map(attempt => attempt.tier)).toEqual(['claude']);
    expect(record.entrySelection?.picked).toBe('cursor');
    expect(record.entrySelection?.entry).toBe('claude');
    expect(record.entrySelection?.reason).toBe('seat_over_cutoff:cursor:98:95');
    expect(
      logs.some(line =>
        line.includes('Skipping tier "cursor" during entry: seat_over_cutoff:cursor:98:95')
      )
    ).toBe(true);
    expect(
      logs.some(line =>
        line.includes('Skipping tier "codex" during entry: seat_over_cutoff:codex:96:95')
      )
    ).toBe(true);
  });

  test('conductor_skips_rung_whose_seat_is_over_cutoff_and_fires_claude (climb)', async () => {
    const fired: string[] = [];
    let judged = 0;
    const record = await runCascade({
      woId: 'WO-SEAT-RUNG-CLIMB',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('zero'),
        seatUsage: async () => HOT_CURSOR_HOT_CODEX_COOL_CLAUDE,
        seatCutoff: async () => 95,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          return { ok: true, runId: `run-${fired.length}`, conversationId: 'c', infraError: null };
        },
        poll: async () => poll('run'),
        judge: () => {
          judged++;
          return verdict(judged === 2);
        },
      },
    });
    expect(fired).toEqual(['bdc-feature-development-zero-open', 'bdc-feature-development']);
    expect(record.winningTier).toBe('claude');
    expect(record.attempts.map(attempt => attempt.tier)).toEqual(['zero', 'claude']);
    expect(
      logs.some(line =>
        line.includes('Skipping tier "cursor" during climb: seat_over_cutoff:cursor:98:95')
      )
    ).toBe(true);
    expect(
      logs.some(line =>
        line.includes('Skipping tier "codex" during climb: seat_over_cutoff:codex:96:95')
      )
    ).toBe(true);
  });

  test('conductor_does_not_skip_a_rung_with_unknown_seat', async () => {
    const fired: string[] = [];
    const record = await runCascade({
      woId: 'WO-SEAT-RUNG-UNKNOWN',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('codex'),
        seatUsage: async () => ({
          codex: { limit_source: 'UNKNOWN', windows: [] },
          claude: seat(30, 'seven_day'),
        }),
        seatCutoff: async () => 95,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          return { ok: true, runId: 'run-1', conversationId: 'c', infraError: null };
        },
        poll: async () => poll('run-1'),
        judge: () => verdict(true),
      },
    });
    expect(fired).toEqual(['bdc-feature-development-codex']);
    expect(record.attempts.map(attempt => attempt.tier)).toEqual(['codex']);
    expect(logs.some(line => line.includes('Skipping tier "codex"'))).toBe(false);
  });

  test('codex rung on purchased credits is not skipped (codex:on_credits)', async () => {
    process.env[THRESHOLD_ENV] = '99';
    const fired: string[] = [];
    await runCascade({
      woId: 'WO-SEAT-RUNG-CREDITS',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('codex'),
        // Threshold 99 keeps headroom routing on codex; only the cutoff rule applies.
        seatUsage: async () => ({
          codex: { ...seat(96), credits: { has_credits: true, overage_limit_reached: false } },
          claude: seat(30, 'seven_day'),
        }),
        seatCutoff: async () => 95,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          return { ok: true, runId: 'run-1', conversationId: 'c', infraError: null };
        },
        poll: async () => poll('run-1'),
        judge: () => verdict(true),
      },
    });
    expect(fired).toEqual(['bdc-feature-development-codex']);
    expect(logs.some(line => line.includes('Skipping tier "codex"'))).toBe(false);
  });

  test('unknown cutoff never skips a measured hot rung', async () => {
    process.env[THRESHOLD_ENV] = '99';
    const fired: string[] = [];
    await runCascade({
      woId: 'WO-SEAT-RUNG-NO-CUTOFF',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('cursor'),
        seatUsage: async () => HOT_CURSOR_HOT_CODEX_COOL_CLAUDE,
        seatCutoff: async () => null,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          return { ok: true, runId: 'run-1', conversationId: 'c', infraError: null };
        },
        poll: async () => poll('run-1'),
        judge: () => verdict(true),
      },
    });
    expect(fired).toEqual(['bdc-feature-development-cursor']);
  });

  test('run-start seat refusal climbs to the next rung without a quality context', async () => {
    const fired: string[] = [];
    const messages: string[] = [];
    let judged = 0;
    const record = await runCascade({
      woId: 'WO-SEAT-RUNG-REFUSAL',
      project: 'fixture',
      outDir,
      token: 'test-token',
      deps: {
        ...claimStubs(),
        ruleset: ruleset('codex'),
        // Codex measured under the cutoff at conductor read time; the run-start
        // gate still refuses it (seat moved between reads).
        seatUsage: async () => ({ codex: seat(50), claude: seat(30, 'seven_day') }),
        seatCutoff: async () => 95,
        fetchNodeTimeouts: async () => ({}),
        fire: async opts => {
          fired.push(opts.workflowName);
          messages.push(opts.message);
          return { ok: true, runId: `run-${fired.length}`, conversationId: 'c', infraError: null };
        },
        poll: async () =>
          fired.length === 1
            ? poll('run-1', {
                error:
                  'seat_usage_refused:codex:primary:96:95:lane=bdc-feature-development-codex:role=lane',
              })
            : poll('run-2'),
        judge: () => {
          judged++;
          return verdict(judged === 2);
        },
      },
    });
    expect(fired).toEqual(['bdc-feature-development-codex', 'bdc-feature-development']);
    expect(record.winningTier).toBe('claude');
    expect(record.attempts[0]?.gateFailReason).toBe(
      'seat_refusal: seat_usage_refused:codex:primary:96:95:lane=bdc-feature-development-codex:role=lane'
    );
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    // No informed-climb (quality) packet is built from a seat refusal.
    expect(messages[1]).toBe(messages[0]);
    expect(logs.some(line => line.includes('Seat refusal on tier=codex'))).toBe(true);
  });
});
