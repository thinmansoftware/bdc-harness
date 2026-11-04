/**
 * Tests 6-8 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): approved-first
 * discovery. Every listed PR is classified structurally each pass at zero GitHub
 * cost; only approved PRs on a watched base consume the evidence budget, and
 * they rotate so none starves.
 *
 * The claim these tests pin (amended spec wording): approved PRs are NEVER crowded
 * out by non-approved ones, and the rotation BOUNDS THE WAIT AMONG APPROVED PRs to
 * ceil(approved / budget) passes. It is NOT a claim that every approved PR is
 * evaluated inside one window: Test 8 has green PR 61 wait until pass 3 because 60
 * other approved PRs ahead of it use the budget.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  discoverMergeCandidates,
  resetDiscoveryCursorForTests,
} from '../merge-candidate-discovery.ts';
import type {
  DiscoveredPullRequest,
  MergeCandidateDiscoveryDeps,
  PullRequestEvidence,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const REPOS = [{ owner: OWNER, repo: REPO }];
const WATCHED_BASES = ['dev'] as const;

function pr(
  prNumber: number,
  overrides: Partial<DiscoveredPullRequest> = {}
): DiscoveredPullRequest {
  return {
    owner: OWNER,
    repo: REPO,
    prNumber,
    title: `pull request ${prNumber}`,
    state: 'open',
    draft: false,
    baseRef: 'dev',
    headRef: `feat/pr-${prNumber}`,
    headSha: `sha-${prNumber}`,
    reviewDecision: 'APPROVED',
    ...overrides,
  };
}

function evidence(prNumber: number, pending: number): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 4, passed: 4 - pending, failed: 0, pending },
    mergeable: true,
    pr: { owner: OWNER, repo: REPO, number: prNumber },
    prTitle: `pull request ${prNumber}`,
    headSha: `sha-${prNumber}`,
    lookupFailed: false,
  };
}

function makeDeps(
  pullRequests: readonly DiscoveredPullRequest[],
  evidenceFor: (prNumber: number) => PullRequestEvidence
): { deps: MergeCandidateDiscoveryDeps; findCalls: number[] } {
  const findCalls: number[] = [];
  return {
    findCalls,
    deps: {
      listOpenPullRequests: async () => pullRequests,
      hasQualifiedReview: async () => true,
      findPullRequest: async input => {
        const prNumber = Number(String(input.headBranch).replace('feat/pr-', ''));
        findCalls.push(prNumber);
        return evidenceFor(prNumber);
      },
    },
  };
}

beforeEach(() => {
  resetDiscoveryCursorForTests();
});

describe('merge candidate discovery -- approved-first budgeting', () => {
  test('Test 6: an approved-at-head PR beyond the first 100 becomes a candidate in one pass', async () => {
    const pullRequests = [
      ...Array.from({ length: 249 }, (_, index) =>
        pr(index + 1, { reviewDecision: 'REVIEW_REQUIRED' })
      ),
      pr(250),
    ];
    const { deps, findCalls } = makeDeps(pullRequests, number => evidence(number, 0));

    const result = await discoverMergeCandidates(deps, {
      repos: REPOS,
      watchedBases: WATCHED_BASES,
      maxPullRequestsPerTick: 100,
      cursor: null,
    });

    expect(result.candidates.map(candidate => candidate.prEvidence.pr?.number)).toEqual([250]);
    expect(result.evaluated).toBe(1);
    expect(result.structurallyClassified).toBe(250);
    expect(result.totalOpen).toBe(250);
    expect(findCalls).toEqual([250]);
    expect(result.exclusions).toHaveLength(249);
    expect(result.exclusions.every(exclusion => exclusion.reason === 'review_not_approved')).toBe(
      true
    );
    expect(result.evaluationWindowTruncated).toBe(false);
  });

  test('Test 7: non-approved PRs never consume the evidence budget and every PR is still classified', async () => {
    const pullRequests = [
      ...Array.from({ length: 120 }, (_, index) => pr(index + 1, { draft: true })),
      ...Array.from({ length: 100 }, (_, index) => pr(121 + index, { baseRef: 'main' })),
      ...Array.from({ length: 80 }, (_, index) => pr(221 + index)),
    ];
    const { deps, findCalls } = makeDeps(pullRequests, number => evidence(number, 2));

    const result = await discoverMergeCandidates(deps, {
      repos: REPOS,
      watchedBases: WATCHED_BASES,
      maxPullRequestsPerTick: 30,
      cursor: null,
    });

    expect(result.structurallyClassified).toBe(300);
    const byReason = (reason: string): number =>
      result.exclusions.filter(exclusion => exclusion.reason === reason).length;
    expect(byReason('draft')).toBe(120);
    expect(byReason('base_branch_not_watched')).toBe(100);
    // 30 approved PRs consumed the budget and were excluded for pending checks.
    expect(byReason('checks_pending')).toBe(30);
    expect(result.exclusions).toHaveLength(250);
    expect(result.evaluated).toBe(30);
    expect(findCalls).toHaveLength(30);
    // The other 50 approved PRs wait in the approved queue for the next pass.
    expect(result.evaluationWindowTruncated).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  test('Test 8: approved PRs rotate so none starves behind persistently excluded approved PRs', async () => {
    const pullRequests = [...Array.from({ length: 61 }, (_, index) => pr(index + 1))];
    // PRs 1-60 stay checks_pending forever; PR 61 is green.
    const { deps, findCalls } = makeDeps(pullRequests, number =>
      evidence(number, number === 61 ? 0 : 2)
    );
    const options = {
      repos: REPOS,
      watchedBases: WATCHED_BASES,
      maxPullRequestsPerTick: 30,
    } as const;

    // Every PR here is approved, so none is crowded out by a non-approved PR. PR 61 still
    // waits: 60 approved PRs ahead of it spend the whole budget in passes 1 and 2 (a
    // bounded rotation delay among approved PRs, ceil(61 / 30) = 3 passes at most).
    const pass1 = await discoverMergeCandidates(deps, options);
    const pass1Calls = findCalls.splice(0);
    expect(pass1Calls).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(pass1Calls).not.toContain(61);
    expect(pass1.evaluationWindowTruncated).toBe(true);
    expect(pass1.cursorAfter?.perRepo[`${OWNER}/${REPO}`]).toBe(30);
    expect(pass1.candidates).toHaveLength(0);

    const pass2 = await discoverMergeCandidates(deps, options);
    const pass2Calls = findCalls.splice(0);
    expect(pass2Calls).toEqual(Array.from({ length: 30 }, (_, index) => index + 31));
    expect(pass2Calls).not.toContain(61);
    expect(pass2.evaluationWindowTruncated).toBe(true);
    expect(pass2.candidates).toHaveLength(0);

    const pass3 = await discoverMergeCandidates(deps, options);
    expect(pass3.candidates.map(candidate => candidate.prEvidence.pr?.number)).toEqual([61]);
    // A full cycle is complete: the cursor resets and the window is no longer truncated.
    expect(pass3.cursorAfter).toBeNull();
    expect(pass3.evaluationWindowTruncated).toBe(false);
  });
});
