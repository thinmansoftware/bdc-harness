/**
 * Wiring tests for the newest-run-per-name reduction at the two check-collection
 * sites in adapters/github-real-deps.ts (WO-HARNESS-OVERSEER-LATEST-CHECK-RUN-01).
 *
 * github-real-deps.ts imports @octokit/rest, @octokit/auth-app and @archon/paths,
 * none of which are installed in lane worktrees (issue #882). They are mock.module
 * -ed BEFORE the dynamic import so this file runs standalone with
 * `bun test <file>`. Type-only imports are erased and trigger no module load.
 * The octokit stub + inMemoryAttemptCounterStore pattern mirrors
 * github-real-deps-octokit-shape.test.ts and github-real-deps.test.ts.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';
import fixture from './fixtures/check-runs-latest.live-2026-09-29.json';

mock.module('@octokit/rest', () => ({ Octokit: class {} }));
mock.module('@octokit/auth-app', () => ({
  createAppAuth: () => () => Promise.resolve({ token: 'mock-token' }),
}));
mock.module('@archon/paths', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
mock.module('../adapters/required-contexts-store', () => ({
  createDurableAttemptCounterStore: () => ({
    increment: () => Promise.resolve(0),
    clear: () => Promise.resolve(),
  }),
}));

const { createRealFetchExactHeadPullRequestEvidence, createRealFindPullRequest, summarizeChecks } =
  await import('../adapters/github-real-deps.ts');
const { inMemoryAttemptCounterStore } = await import('../adapters/required-contexts.ts');

const HEAD = 'a'.repeat(40);

interface StubRun {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string;
}

/** Octokit stub for createRealFetchExactHeadPullRequestEvidence. */
function evidenceOctokit(checkRuns: StubRun[]): RealGitHubOctokitLike {
  const octokit = {
    pulls: {
      get: async () => ({
        data: { head: { sha: HEAD }, base: { sha: 'c'.repeat(40), ref: 'dev' } },
      }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: checkRuns } }),
    },
    repos: {
      compareCommits: async () => ({ data: { files: [] } }),
      getAllStatusCheckContexts: async () => ({ data: [] }),
      getBranch: async () => ({ data: { protected: false, protection: { enabled: false } } }),
      getBranchRules: async () => ({ data: [] }),
    },
  };
  return octokit as unknown as RealGitHubOctokitLike;
}

/** Octokit stub for createRealFindPullRequest (prNumber-first path). */
function findOctokit(checkRuns: StubRun[]): RealGitHubOctokitLike {
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          number: 42,
          title: 'WO test PR',
          state: 'open',
          merged: false,
          mergeable: true,
          head: { sha: HEAD, ref: 'feat/x' },
          user: { login: 'builder' },
          created_at: '2026-09-29T00:00:00Z',
          changed_files: 1,
        },
      }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: checkRuns } }),
    },
  };
  return octokit as unknown as RealGitHubOctokitLike;
}

function fetchEvidence(checkRuns: StubRun[]) {
  return createRealFetchExactHeadPullRequestEvidence(
    evidenceOctokit(checkRuns),
    undefined,
    inMemoryAttemptCounterStore
  )({ owner: 'thinmansoftware', repo: 'bdc-harness', prNumber: 42, headSha: HEAD });
}

function baShopopsRuns(): StubRun[] {
  const head = (fixture.heads as { headSha: string; checkRuns: StubRun[] }[]).find(
    h => h.headSha === 'ba023dca82a7f41274a68a98bb05967531eac1a8'
  );
  if (!head) throw new Error('fixture missing ba023dca head');
  return head.checkRuns;
}

describe('check-run reduction wiring in github-real-deps', () => {
  test('8 evidence fetch returns only the newest run per name and lists older ones under supersededChecks', async () => {
    const evidence = await fetchEvidence([
      {
        id: 50,
        name: 'CE Change Scope Gate',
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 51,
        name: 'CE Change Scope Gate',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:05:00Z',
      },
      {
        id: 99,
        name: 'unrelated check',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
    ]);

    const gate = evidence.checks.filter(c => c.name === 'CE Change Scope Gate');
    expect(gate).toHaveLength(1);
    expect(gate[0]?.conclusion).toBe('success');
    expect(evidence.checks.some(c => c.name === 'unrelated check')).toBe(true);

    const superseded = evidence.supersededChecks ?? [];
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.id).toBe(50);
    expect(superseded[0]?.conclusion).toBe('failure');
    expect(superseded[0]?.superseded_by).toBe(51);
  });

  test('9 evidence fetch with older success and newer failure keeps the failure', async () => {
    const evidence = await fetchEvidence([
      {
        id: 60,
        name: 'CE Change Scope Gate',
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-29T08:00:00Z',
      },
      {
        id: 61,
        name: 'CE Change Scope Gate',
        status: 'completed',
        conclusion: 'failure',
        completed_at: '2026-09-29T08:05:00Z',
      },
    ]);
    expect(summarizeChecks(evidence.checks).failed).toBe(1);
  });

  test('10 summarizeChecks over the reduced ba023dca replay reports no failure and no pending', async () => {
    const evidence = await fetchEvidence(baShopopsRuns());
    const summary = summarizeChecks(evidence.checks);
    expect(summary.failed).toBe(0);
    expect(summary.pending).toBe(0);
  });

  test('11 createRealFindPullRequest checks summary excludes the superseded failure', async () => {
    const evidence = await createRealFindPullRequest(
      findOctokit([
        {
          id: 70,
          name: 'CE Change Scope Gate',
          status: 'completed',
          conclusion: 'failure',
          completed_at: '2026-09-29T08:00:00Z',
        },
        {
          id: 71,
          name: 'CE Change Scope Gate',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-09-29T08:05:00Z',
        },
      ])
    )({ owner: 'thinmansoftware', repo: 'bdc-harness', prNumber: 42, woId: 'WO-TEST' });

    expect(evidence.checks.failed).toBe(0);
    expect(evidence.checks.passed).toBe(1);
  });
});
