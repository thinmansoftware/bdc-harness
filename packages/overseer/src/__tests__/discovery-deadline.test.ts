/**
 * Round 2, finding 2 (PR 1502): the aggregate discovery deadline returns the
 * candidates gathered so far, advances the cursor only past evaluated PRs, and
 * cancels the remaining lookups.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetDiscoveryCursorForTests } from '../merge-candidate-discovery.ts';
import { watchOnce, type WatchHeartbeatLogger } from '../watch.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'slow-repo';
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

function setup(lookupMs: number) {
  const started: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const entries: Array<{ msg: string; obj: Record<string, unknown> }> = [];
  const logger: WatchHeartbeatLogger = {
    info: (obj, msg) => entries.push({ msg, obj }),
    warn: (obj, msg) => entries.push({ msg, obj }),
    error: (obj, msg) => entries.push({ msg, obj }),
  };
  const deps: OverseerRunStoreDeps & GitHubClientDeps = {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [],
    listOpenPullRequests: async () => prs,
    hasQualifiedReview: async () => true,
    mergePullRequest: async () => ({ merged: true }),
    findPullRequest: async input => {
      const n = input.prNumber as number;
      started.push(n);
      signals.push((input as { signal?: AbortSignal }).signal);
      await sleep(lookupMs);
      return evidenceFor(n);
    },
  };
  return { deps, started, signals, entries, logger };
}

beforeEach(() => {
  resetDiscoveryCursorForTests();
});

describe('discovery aggregate deadline', () => {
  test('(iv) a slow-but-valid 100-PR discovery returns partial candidates and resumes next pass', async () => {
    const { deps, entries, logger } = setup(15);
    const options = {
      logger,
      stepTimeoutMs: 1000, // every individual lookup is well inside its own deadline
      discoveryDeadlineMs: 120,
      discovery: { watchedBases: ['dev'], repos: [{ owner: OWNER, repo: REPO }] },
    } as const;

    const pass1 = await watchOnce(deps, options);
    const numbers1 = pass1.map(r => r.prEvidence.pr?.number as number);
    expect(numbers1.length).toBeGreaterThan(0);
    expect(numbers1.length).toBeLessThan(100);
    expect(entries.some(e => e.msg === 'merge-coordinator.discovery_deadline')).toBe(true);
    const heartbeat1 = entries.filter(e => e.msg === 'merge-coordinator.heartbeat_evaluated')[0];
    expect(heartbeat1?.obj.prsWindowTruncated).toBe(true);

    // The cursor advanced only past evaluated PRs: pass 2 starts right after the last one.
    const lastEvaluated = Math.max(...numbers1);
    const pass2 = await watchOnce(deps, options);
    const numbers2 = pass2.map(r => r.prEvidence.pr?.number as number);
    expect(numbers2.length).toBeGreaterThan(0);
    expect(Math.min(...numbers2)).toBe(lastEvaluated + 1);
    expect(numbers2.some(n => numbers1.includes(n))).toBe(false);
  });

  test('(v) abandoned lookups are cancelled and no work starts after the deadline', async () => {
    const { deps, started, signals, logger } = setup(400);
    const before = Date.now();
    const pass = await watchOnce(deps, {
      logger,
      stepTimeoutMs: 5000,
      discoveryDeadlineMs: 60,
      discovery: { watchedBases: ['dev'], repos: [{ owner: OWNER, repo: REPO }] },
    });
    expect(Date.now() - before).toBeLessThan(300); // did not wait for the 400 ms lookup
    expect(pass).toHaveLength(0);
    const startedAtDeadline = started.length;
    expect(startedAtDeadline).toBeGreaterThanOrEqual(1);
    // The in-flight lookup was handed a signal and it is aborted.
    expect(signals.every(s => s?.aborted === true)).toBe(true);
    await sleep(500);
    expect(started.length).toBe(startedAtDeadline);
  });
});
