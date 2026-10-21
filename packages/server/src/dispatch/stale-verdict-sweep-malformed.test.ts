/**
 * Real-SQLITE proof that a block of UNPARSEABLE review rows cannot starve the
 * stale-verdict walk (Overseer review finding, PR #786 @e80159e4).
 *
 * THE BUG THIS PINS. `listRealSweepCandidates` returned only the candidates
 * that PARSED, and exposed no position for the rows it discarded. So a page
 * whose rows all failed parse/validation was indistinguishable from the end of
 * the store: `runStaleVerdictSweep` saw an empty list, rewound the cursor to 0,
 * and did exactly the same thing on the next heartbeat. Valid candidates
 * sitting beyond the malformed block were unreachable forever.
 *
 * NOT HYPOTHETICAL. Live store, read 2026-09-08: 8 of 423 completed
 * `run_review` rows already carry unparseable or incomplete bodies, so the
 * discard path runs in production today.
 *
 * The seeded shape is the finding's own: 60 done run_review rows where rows
 * 1-50 have unparseable bodies and the only eligible candidate is row 55.
 *
 * REAL DATABASE ON PURPOSE. The bug lives in the seam between the DAL's raw
 * page and the wiring's parsed output; a mocked lister cannot show it.
 *
 * ISOLATION. SQLite runs in a child process with its own ARCHON_HOME. This
 * file does not mock `@archon/core/db/connection` and does not close a handle
 * shared with the rest of the dispatch suite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

interface PageProbe {
  kind: 'page';
  candidatesLength: number;
  rawCount: number;
  discarded: number;
  lastRawSeq: number;
  firstPrNumber: number | null;
}

interface WalkProbe {
  kind: 'walk';
  firstExamined: number;
  firstEnqueued: number;
  firstDiscarded: number;
  firstAfterSeq: number;
  cursorAfterFirst: number;
  cursorAfterSecond: number;
  totalEnqueued: number;
  enqueuedPrs: number[];
}

interface RewindProbe {
  kind: 'rewind';
  afterSeq: number;
  cursor: number;
}

type ProbePayload = PageProbe | WalkProbe | RewindProbe;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPageProbe(value: Record<string, unknown>): value is PageProbe {
  return (
    value.kind === 'page' &&
    typeof value.candidatesLength === 'number' &&
    typeof value.rawCount === 'number' &&
    typeof value.discarded === 'number' &&
    typeof value.lastRawSeq === 'number' &&
    (typeof value.firstPrNumber === 'number' || value.firstPrNumber === null)
  );
}

function isWalkProbe(value: Record<string, unknown>): value is WalkProbe {
  return (
    value.kind === 'walk' &&
    typeof value.firstExamined === 'number' &&
    typeof value.firstEnqueued === 'number' &&
    typeof value.firstDiscarded === 'number' &&
    typeof value.firstAfterSeq === 'number' &&
    typeof value.cursorAfterFirst === 'number' &&
    typeof value.cursorAfterSecond === 'number' &&
    typeof value.totalEnqueued === 'number' &&
    Array.isArray(value.enqueuedPrs) &&
    value.enqueuedPrs.every(item => typeof item === 'number')
  );
}

function isRewindProbe(value: Record<string, unknown>): value is RewindProbe {
  return (
    value.kind === 'rewind' &&
    typeof value.afterSeq === 'number' &&
    typeof value.cursor === 'number'
  );
}

function probeResultLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(item => item.trim())
    .filter(item => item.startsWith('PROBE='));
}

function parseProbe(stdout: string): ProbePayload {
  const lines = probeResultLines(stdout);
  if (lines.length !== 1) {
    throw new Error(`expected exactly one PROBE= line, found ${lines.length}: ${stdout}`);
  }
  const line = lines[0] ?? '';
  const parsed: unknown = JSON.parse(line.slice('PROBE='.length));
  if (!isRecord(parsed)) throw new Error(`unexpected probe payload: ${line}`);
  if (isPageProbe(parsed) || isWalkProbe(parsed) || isRewindProbe(parsed)) return parsed;
  throw new Error(`unexpected probe payload: ${line}`);
}

function runProbe(scenario: string): ProbePayload {
  const home = mkdtempSync(join(tmpdir(), 'sweep-malformed-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ARCHON_HOME: home };
    delete env.DATABASE_URL;
    const probe = join(import.meta.dir, 'stale-verdict-sweep-malformed.probe.ts');
    const proc = Bun.spawnSync([process.execPath, 'run', probe, scenario], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 45_000,
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `SQLite probe exited ${proc.exitCode}: ${proc.stderr.toString()} ${proc.stdout.toString()}`
      );
    }
    const stdout = proc.stdout.toString();
    try {
      return parseProbe(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; stderr: ${proc.stderr.toString()}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runPageProbe(scenario: string): PageProbe {
  const payload = runProbe(scenario);
  if (payload.kind !== 'page') throw new Error(`expected page probe, got ${payload.kind}`);
  return payload;
}

describe('probe result line protocol', () => {
  test('requires exactly one PROBE= line', () => {
    const payload = parseProbe('log line\nPROBE={"kind":"rewind","afterSeq":1,"cursor":2}\n');
    expect(payload).toEqual({ kind: 'rewind', afterSeq: 1, cursor: 2 });

    expect(() => parseProbe('no probe here\n')).toThrow(/exactly one PROBE= line, found 0/);
    expect(() =>
      parseProbe(
        'PROBE={"kind":"rewind","afterSeq":1,"cursor":2}\nPROBE={"kind":"rewind","afterSeq":3,"cursor":4}\n'
      )
    ).toThrow(/exactly one PROBE= line, found 2/);
  });
});

describe('listRealSweepCandidates over a block of unparseable rows', () => {
  test('a page of only-malformed rows reports its raw position, not an empty list', () => {
    const page = runPageProbe('page-malformed');

    expect(page.candidatesLength).toBe(0);
    expect(page.rawCount).toBe(50);
    expect(page.discarded).toBe(50);
    // THE REGRESSION GUARD: the raw position of the last row examined. Without
    // it the caller cannot tell this page from the end of the store.
    expect(page.lastRawSeq).toBe(50);
  }, 60_000);

  test('resuming past the malformed block returns the well-formed rows', () => {
    const page = runPageProbe('page-resume');

    expect(page.candidatesLength).toBeGreaterThan(0);
    expect(page.discarded).toBe(0);
    expect(page.firstPrNumber).toBe(51);
  }, 60_000);

  test('a genuinely exhausted cursor reports zero raw rows', () => {
    const page = runPageProbe('page-exhausted');

    expect(page.rawCount).toBe(0);
    expect(page.candidatesLength).toBe(0);
    expect(page.lastRawSeq).toBe(0);
  }, 60_000);
});

describe('the sweep walks past malformed rows across heartbeats', () => {
  test('row 55 is reached on the SECOND heartbeat, with no rewind after the first', () => {
    const payload = runProbe('walk-second-heartbeat');
    if (payload.kind !== 'walk') throw new Error(`expected walk probe, got ${payload.kind}`);

    // HEARTBEAT 1: the raw page is the 50-row malformed block. Nothing parses,
    // so nothing is examined -- but the walk must still move.
    expect(payload.firstExamined).toBe(0);
    expect(payload.firstEnqueued).toBe(0);
    expect(payload.firstDiscarded).toBe(50);
    // THE REGRESSION GUARD: before the fix this rewound to 0 every time.
    expect(payload.firstAfterSeq).toBe(50);
    expect(payload.cursorAfterFirst).toBe(50);

    // HEARTBEAT 2: resumes past the block and finds the eligible row.
    expect(payload.cursorAfterSecond).toBeGreaterThan(50);
    expect(payload.totalEnqueued).toBe(1);
    expect(payload.enqueuedPrs).toEqual([55]);
  }, 60_000);

  test('the walk still rewinds once the store is genuinely exhausted', () => {
    const payload = runProbe('walk-exhausted-rewind');
    if (payload.kind !== 'rewind') throw new Error(`expected rewind probe, got ${payload.kind}`);

    expect(payload.afterSeq).toBe(0);
    expect(payload.cursor).toBe(0);
  }, 60_000);
});
