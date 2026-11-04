/**
 * Round 3 (PR 1502), finding 2: with the production timeout relationship (the
 * whole-pass timeout EQUALS the aggregate discovery deadline, both
 * stepTimeout x 5) a slow discovery must return partial candidates BEFORE the
 * enclosing pass deadline, so onRecord actually processes them and the cursor
 * never advances past PRs that were not handled.
 *
 * Production values: step 60000, discovery 5 x step = 300000, pass 300000. The
 * test keeps that exact relationship at 1/600 scale (step 100, discovery 500,
 * pass 500) so it can run in real time. The pass timer starts earlier than the
 * discovery timer (a slow run-store read precedes the sweep, inside its own step deadline), which is what made
 * the old outer wait reject first and discard everything.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetDiscoveryCursorForTests } from '../merge-candidate-discovery.ts';
import { watchLoop, type WatchHeartbeatLogger } from '../watch.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'deadline-repo';
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const prs: DiscoveredPullRequest[] = Array.from({ length: 100 }, (_, index) => ({
  owner: OWNER,
  repo: REPO,
  prNumber: index + 1,
  title: `pr ${index + 1}`,
  state: 'open',
  draft: false,
  baseRef: 'dev',
  headRef: `feat/pr-${index + 1}`,
  headSha: `sha-${index + 1}`,
  reviewDecision: 'APPROVED',
}));
const evidenceFor = (n: number): PullRequestEvidence => ({
  exists: true,
  state: 'open',
  checks: { total: 4, passed: 4, failed: 0, pending: 0 },
  mergeable: true,
  pr: { owner: OWNER, repo: REPO, number: n },
  prTitle: `pr ${n}`,
  headSha: `sha-${n}`,
  lookupFailed: false,
});

beforeEach(() => {
  resetDiscoveryCursorForTests();
});

describe('whole-pass deadline vs discovery deadline', () => {
  test('a slow discovery yields partial candidates that onRecord processes; the cursor stops at the last handled PR', async () => {
    const entries: Array<{ msg: string; obj: Record<string, unknown> }> = [];
    const logger: WatchHeartbeatLogger = {
      info: (obj, msg) => entries.push({ msg, obj }),
      warn: (obj, msg) => entries.push({ msg, obj }),
      error: (obj, msg) => entries.push({ msg, obj }),
    };
    const handled: number[] = [];
    const controller = new AbortController();
    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      // The pass timer is already 90 ms old when the sweep starts.
      listRunsForWatch: async () => {
        await sleep(90);
        return [];
      },
      listRunEvents: async () => [],
      listOpenPullRequests: async () => prs,
      hasQualifiedReview: async () => true,
      mergePullRequest: async () => ({ merged: true }),
      findPullRequest: async input => {
        await sleep(20); // slow, but far inside the 100 ms step deadline
        return evidenceFor(input.prNumber as number);
      },
    };

    const loop = watchLoop(
      deps,
      async (record: WatchedRunRecord) => {
        handled.push(record.prEvidence.pr?.number as number);
      },
      {
        intervalMs: 5,
        // Production relationship: pass timeout === discovery deadline === 5 x step.
        stepTimeoutMs: 100,
        passTimeoutMs: 500,
        recordTimeoutMs: 1000,
        logger,
        signal: controller.signal,
        discovery: { watchedBases: ['dev'], repos: [{ owner: OWNER, repo: REPO }] },
      }
    );
    const deadline = Date.now() + 6000;
    while (
      entries.filter(e => e.msg === 'merge-coordinator.heartbeat_evaluated').length < 2 &&
      Date.now() < deadline
    ) {
      await sleep(10);
    }
    await sleep(60); // let pass 2 hand its records over
    controller.abort();
    await loop;

    // The pass deadline never discarded the sweep.
    expect(
      entries.some(
        e => e.msg === 'merge-coordinator.step_timeout' && String(e.obj.label).includes('watchOnce')
      )
    ).toBe(false);
    expect(entries.some(e => e.msg === 'merge-coordinator.discovery_deadline')).toBe(true);
    // Partial candidates were actually handled.
    expect(handled.length).toBeGreaterThan(0);
    expect(handled.length).toBeLessThan(100);
    // Handled PRs form an unbroken run from 1: the cursor never advanced past a PR
    // whose candidate was not handed to onRecord, and nothing repeats.
    expect(handled).toEqual(Array.from({ length: handled.length }, (_, index) => index + 1));
  });
});
