/**
 * Polynomial-ReDoS guards for Overseer parsers (WO-HARNESS-OVERSEER-REDOS-01).
 * Each hostile case is timed around the call and must finish in under 100 ms.
 */
import { describe, expect, test } from 'bun:test';
import { classifyError } from '../classify';
import { extractBoardSeat } from '../owner-resolution';
import {
  blockingCheckNamesFromVerdict,
  completionIsRelevantToVerdict,
  stripMatrixSuffix,
  type StandingVerdict,
} from '../pr-review-check-ingest';
import { extractDeclaredWoStems, extractReconcileSkipStems } from '../reconcile';

const HOSTILE_LEN = 65536;
const LIMIT_MS = 100;

function changesRequestedVerdict(summary: string): StandingVerdict {
  return {
    headSha: '1191a7361191a7361191a7361191a7361191a736',
    disposition: 'changes_requested',
    summary,
    recordedAt: '2026-09-07T11:46:00.000Z',
  };
}

describe('extractDeclaredWoStems', () => {
  test('hostile spaced declaration finishes under 100 ms', () => {
    const body = `WO: x${' '.repeat(HOSTILE_LEN)}y`;
    const started = performance.now();
    extractDeclaredWoStems(body);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden WO declaration bodies', () => {
    expect(extractDeclaredWoStems('WO: WO-FOO-01, WO-BAR-02')).toEqual(['WO-FOO-01', 'WO-BAR-02']);
    expect(extractDeclaredWoStems('intro\r\nWO: WO-FOO-01\r\n')).toEqual(['WO-FOO-01']);
    expect(extractDeclaredWoStems('  wo :  wo-foo-01  ')).toEqual(['WO-FOO-01']);
    expect(extractDeclaredWoStems('The WO: WO-FOO-01 line')).toEqual([]);
  });
});

describe('extractReconcileSkipStems', () => {
  test('hostile spaced skip marker finishes under 100 ms', () => {
    const body = `Reconcile-Skip: x${' '.repeat(HOSTILE_LEN)}y`;
    const started = performance.now();
    extractReconcileSkipStems(body);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden reconcile-skip bodies', () => {
    expect(extractReconcileSkipStems('Reconcile-Skip: wo-foo-01, WO-BAR-02')).toEqual(
      new Set(['WO-FOO-01', 'WO-BAR-02'])
    );
    expect(extractReconcileSkipStems('we could add a Reconcile-Skip: WO-FOO-01 marker')).toEqual(
      new Set()
    );
  });
});

describe('blockingCheckNamesFromVerdict', () => {
  test('hostile note line finishes under 100 ms', () => {
    const summary = `[note]${' '.repeat(HOSTILE_LEN)}x\ry`;
    const started = performance.now();
    blockingCheckNamesFromVerdict(summary);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile blocker check line finishes under 100 ms', () => {
    const summary = `[blocker] checks/a${' '.repeat(HOSTILE_LEN)}b: x`;
    const started = performance.now();
    blockingCheckNamesFromVerdict(summary);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden finding summaries', () => {
    expect(
      blockingCheckNamesFromVerdict('[blocker] checks/test (windows-latest) failed: x')
    ).toEqual(['test (windows-latest)']);
    expect(blockingCheckNamesFromVerdict('[major] checks/lint failed')).toEqual(['lint']);
    expect(blockingCheckNamesFromVerdict('[blocker] src/a.ts: bad')).toEqual([]);
    expect(blockingCheckNamesFromVerdict('[blocker]checks/x: y')).toEqual([]);
  });
});

describe('stripMatrixSuffix and completionIsRelevantToVerdict', () => {
  test('hostile open-paren string finishes under 100 ms', () => {
    const input = '('.repeat(HOSTILE_LEN);
    const started = performance.now();
    stripMatrixSuffix(input);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile spaced string finishes under 100 ms', () => {
    const input = `a${' '.repeat(HOSTILE_LEN)}b`;
    const started = performance.now();
    stripMatrixSuffix(input);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile suite check name finishes under 100 ms', () => {
    const verdict = changesRequestedVerdict('[blocker] checks/test failed: x');
    const started = performance.now();
    completionIsRelevantToVerdict(verdict, {
      checkId: 'check_suite:1',
      checkName: '('.repeat(HOSTILE_LEN),
    });
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden matrix suffix and relevance', () => {
    expect(stripMatrixSuffix('test (windows-latest)')).toBe('test');
    expect(stripMatrixSuffix('a (b) (c)')).toBe('a (b)');
    expect(stripMatrixSuffix('x ((y)')).toBe('x');
    expect(stripMatrixSuffix('foo (bar (baz))')).toBe('foo (bar (baz))');
    expect(stripMatrixSuffix('plain')).toBe('plain');

    const verdict = changesRequestedVerdict('[blocker] checks/test failed: x');
    expect(completionIsRelevantToVerdict(verdict, { checkName: 'test (windows-latest)' })).toBe(
      true
    );
    expect(completionIsRelevantToVerdict(verdict, { checkName: 'a'.repeat(513) })).toBe(false);
  });
});

describe('extractBoardSeat', () => {
  test('hostile blank lines finish under 100 ms', () => {
    const motion = '\n'.repeat(HOSTILE_LEN);
    const started = performance.now();
    extractBoardSeat(motion);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile approval heading finishes under 100 ms', () => {
    const motion = `## a${' '.repeat(HOSTILE_LEN)}b`;
    const started = performance.now();
    extractBoardSeat(motion);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile mover line finishes under 100 ms', () => {
    const motion = `Mover: a${' '.repeat(HOSTILE_LEN)} `;
    const started = performance.now();
    extractBoardSeat(motion);
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden motion lines', () => {
    expect(extractBoardSeat('**Proposed by:** Claude (acting XO)')).toBe('Claude');
    expect(extractBoardSeat('Mover: Codex')).toBe('Codex');
    expect(extractBoardSeat('## Codex (Sol) -- APPROVE with notes')).toBe('Codex');
    expect(extractBoardSeat('## Codex -- approve')).toBe('Codex');
    expect(extractBoardSeat('## Grok -- APPROVED')).toBeNull();
    expect(extractBoardSeat('##### Grok -- APPROVE')).toBeNull();
    expect(extractBoardSeat('  ## Claude -- APPROVE')).toBeNull();
  });
});

describe('classifyError', () => {
  test('hostile bash prefix finishes under 100 ms', () => {
    const message = 'bash:'.repeat(13108);
    const started = performance.now();
    classifyError({ message });
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('hostile branch-named prefix finishes under 100 ms', () => {
    const message = 'fatal: a branch named '.repeat(2979);
    const started = performance.now();
    classifyError({ message });
    expect(performance.now() - started).toBeLessThan(LIMIT_MS);
  });

  test('golden classification messages', () => {
    expect(classifyError({ message: 'bash: line 1: npm: command not found' })).toBe(
      'npm_not_found'
    );
    expect(classifyError({ message: 'command not found: yarn' })).toBe('npm_not_found');
    expect(classifyError({ message: "fatal: a branch named 'archon/task-x' already exists" })).toBe(
      'worktree_collision'
    );
    const filler = `${'x'.repeat(20000 - 'bash: line 9: pnpm: command not found'.length)}bash: line 9: pnpm: command not found`;
    expect(filler.length).toBe(20000);
    expect(classifyError({ message: filler })).toBe('npm_not_found');
  });
});
