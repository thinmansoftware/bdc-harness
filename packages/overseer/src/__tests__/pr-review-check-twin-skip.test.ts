import { beforeEach, expect, test } from 'bun:test';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import {
  inMemoryAttemptCounterStore,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import { latestAttemptPerCheck, namedBlockingChecksAreGreen } from '../pr-review-check-ingest.ts';
import { listCheckRunsForRefFromOctokit } from '../pr-review-check-wiring.ts';
import {
  applyRequiredCheckGate,
  partitionChecksByRequired,
  type PrReviewCheck,
} from '../pr-review-evaluator.ts';

// Anchor: lspro-react #777 at head ca6fa304. ce-promotion-gate.yml has two jobs
// named "CE Promotion Gate"; the PR #429 self-install exemption job is skipped on
// every other PR and is created AFTER the real job, so it has the higher run id.
// Both jobs of one workflow execution share a check suite (ids below are real).
const GATE = 'CE Promotion Gate';
const APP = { slug: 'github-actions' };
const HEAD = 'ca6fa304f66296e99185567de3bc5cf05f2a6f68';
const BASE = 'b4a37927a9fa0a93294065cef25d6f47b7e06452';

beforeEach(() => {
  resetRequiredContextsAttemptCounters();
  resetRequiredContextsCache();
});

function run(
  id: number,
  conclusion: string | null,
  suite: number | undefined,
  status = 'completed'
): PrReviewCheck {
  return {
    id,
    name: GATE,
    status,
    conclusion,
    started_at: '2026-11-03T23:55:59Z',
    completed_at: status === 'completed' ? '2026-11-03T23:56:01Z' : null,
    app: APP,
    ...(suite === undefined ? {} : { check_suite: { id: suite } }),
  };
}

test('twin job: the real success wins over a newer skipped twin in the same suite', () => {
  const real = run(126288831019, 'success', 113117241780);
  const twin = run(126288833084, 'skipped', 113117241780);
  expect(latestAttemptPerCheck([real, twin]).map(c => c.id)).toEqual([126288831019]);
  expect(latestAttemptPerCheck([twin, real]).map(c => c.id)).toEqual([126288831019]);

  const partition = partitionChecksByRequired([real, twin], [GATE]);
  expect(partition.gating).toHaveLength(1);
  expect(partition.gating[0]?.conclusion).toBe('success');
});

test('twin job: a real failure is not masked by a newer skipped twin in the same suite', () => {
  const real = run(126188364537, 'failure', 113039551793);
  const twin = run(126188367041, 'skipped', 113039551793);
  expect(latestAttemptPerCheck([real, twin]).map(c => c.conclusion)).toEqual(['failure']);

  // Before the fix the skipped twin was kept, and skipped counts as passing.
  expect(namedBlockingChecksAreGreen([real, twin], [GATE])).toBe(false);

  const gated = applyRequiredCheckGate(
    { verdict: 'APPROVE' as const, findings: [] },
    partitionChecksByRequired([real, twin], [GATE])
  );
  expect(gated.verdict).toBe('REQUEST_CHANGES');
  expect(gated.findings.map(f => f.scope)).toEqual([`checks/${GATE}`]);
});

test('full #777 history: each execution is reduced by its own twins, newest execution wins', () => {
  const runs = [
    run(126186366548, 'failure', 113037969438),
    run(126186369939, 'skipped', 113037969438),
    run(126186739881, 'failure', 113038259971),
    run(126186742456, 'skipped', 113038259971),
    run(126188364537, 'failure', 113039551793),
    run(126188367041, 'skipped', 113039551793),
    run(126288831019, 'success', 113117241780),
    run(126288833084, 'skipped', 113117241780),
  ];
  expect(latestAttemptPerCheck(runs).map(c => c.id)).toEqual([126288831019]);
  expect(namedBlockingChecksAreGreen(runs, [GATE])).toBe(true);
});

test('older failure, then a newer execution that legitimately skips: the skip wins', () => {
  const oldFailure = run(900, 'failure', 1);
  const laterSkip = run(1000, 'skipped', 2);
  expect(latestAttemptPerCheck([oldFailure, laterSkip]).map(c => c.id)).toEqual([1000]);
  expect(latestAttemptPerCheck([laterSkip, oldFailure]).map(c => c.id)).toEqual([1000]);
  expect(namedBlockingChecksAreGreen([oldFailure, laterSkip], [GATE])).toBe(true);
});

test('runs without a suite id are never treated as twins (newest wins, as before)', () => {
  const real = run(10, 'failure', undefined);
  const skipped = run(20, 'skipped', undefined);
  expect(latestAttemptPerCheck([real, skipped]).map(c => c.id)).toEqual([20]);
});

test('only skipped runs: the check stays skipped (newest skipped kept)', () => {
  const kept = latestAttemptPerCheck([run(200, 'skipped', 5), run(100, 'skipped', 5)]);
  expect(kept.map(c => c.id)).toEqual([200]);
  expect(kept[0]?.conclusion).toBe('skipped');
});

test('rerun among non-skipped runs: newest attempt still wins', () => {
  expect(
    latestAttemptPerCheck([run(300, 'failure', 7), run(400, 'success', 7)]).map(c => c.id)
  ).toEqual([400]);
  expect(
    latestAttemptPerCheck([run(600, 'failure', 8), run(500, 'success', 7)]).map(c => c.id)
  ).toEqual([600]);
});

test('a non-skipped run still in progress outranks its skipped twin', () => {
  const pending = run(700, null, 9, 'in_progress');
  const twin = run(800, 'skipped', 9);
  expect(latestAttemptPerCheck([pending, twin]).map(c => c.id)).toEqual([700]);
  expect(namedBlockingChecksAreGreen([pending, twin], [GATE])).toBe(false);
});

test('different check names in one suite are never merged by the twin rule', () => {
  const gate = run(126288831019, 'success', 113117241780);
  const other: PrReviewCheck = {
    ...run(126288833084, 'skipped', 113117241780),
    name: 'CE Regression Gate',
  };
  expect(
    latestAttemptPerCheck([gate, other])
      .map(c => c.id)
      .sort()
  ).toEqual([126288831019, 126288833084]);
});

test('same suite, later rerun attempt that legitimately skips: the skip wins', () => {
  const firstAttemptFail: PrReviewCheck = {
    ...run(100, 'failure', 1),
    started_at: '2026-11-03T10:00:00Z',
    completed_at: '2026-11-03T10:01:00Z',
  };
  const rerunSkip: PrReviewCheck = {
    ...run(200, 'skipped', 1),
    started_at: '2026-11-03T10:05:00Z',
    completed_at: '2026-11-03T10:05:00Z',
  };
  expect(latestAttemptPerCheck([firstAttemptFail, rerunSkip]).map(c => c.id)).toEqual([200]);
  expect(namedBlockingChecksAreGreen([firstAttemptFail, rerunSkip], [GATE])).toBe(true);
});

test('skipped run without a start time is never treated as a twin', () => {
  const real = run(10, 'failure', 3);
  const skipped: PrReviewCheck = { ...run(20, 'skipped', 3), started_at: null };
  expect(latestAttemptPerCheck([real, skipped]).map(c => c.id)).toEqual([20]);
});

// The real #777 pair from GitHub (filter=all), as the adapters return it.
const REAL_PAIR = [
  {
    id: 126188367041,
    name: GATE,
    status: 'completed',
    conclusion: 'skipped',
    started_at: '2026-11-03T20:34:16Z',
    completed_at: '2026-11-03T20:34:16Z',
    app: APP,
    check_suite: { id: 113039551793 },
  },
  {
    id: 126188364537,
    name: GATE,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-11-03T20:34:19Z',
    completed_at: '2026-11-03T20:34:27Z',
    app: APP,
    check_suite: { id: 113039551793 },
  },
];

test('review evidence adapter requests filter=all and carries check_suite', async () => {
  const calls: Record<string, unknown>[] = [];
  const octokit = {
    pulls: {
      get: async () => ({ data: { head: { sha: HEAD }, base: { sha: BASE, ref: 'release/ce' } } }),
    },
    repos: {
      compareCommits: async () => ({ data: { files: [] } }),
      getAllStatusCheckContexts: async () => ({ data: [GATE] }),
    },
    checks: {
      listForRef: async (args: Record<string, unknown>) => {
        calls.push(args);
        return { data: { check_runs: REAL_PAIR } };
      },
    },
  } as unknown as RealGitHubOctokitLike;
  const evidence = await createRealFetchExactHeadPullRequestEvidence(
    octokit,
    undefined,
    inMemoryAttemptCounterStore
  )({ owner: 'thinmansoftware', repo: 'lspro-react', prNumber: 777, headSha: HEAD });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.filter).toBe('all');
  expect(evidence.checks.map(c => c.check_suite?.id)).toEqual([113039551793, 113039551793]);
  const gating = partitionChecksByRequired(evidence.checks, [GATE]).gating;
  expect(gating.map(c => c.conclusion)).toEqual(['failure']);
});

test('recheck adapter requests filter=all and the twin cannot mask the failure', async () => {
  const calls: Record<string, unknown>[] = [];
  const listed = await listCheckRunsForRefFromOctokit(
    {
      checks: {
        listForRef: async (args: Record<string, unknown>) => {
          calls.push(args);
          return { data: { check_runs: REAL_PAIR } };
        },
      },
    },
    { owner: 'thinmansoftware', repo: 'lspro-react', headSha: HEAD }
  );
  expect(calls[0]?.filter).toBe('all');
  expect(listed.complete).toBe(true);
  expect(namedBlockingChecksAreGreen(listed.runs, [GATE])).toBe(false);
});
