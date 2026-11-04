/**
 * Tests 1-3 (WO-HARNESS-MERGE-SWEEP-LIVENESS-AND-PAGING-01): a hung or throwing
 * await can no longer end or stall the merge-sweep loop, and an error in the
 * operator-card delivery scheduler can no longer stop the watcher.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetDiscoveryCursorForTests } from '../merge-candidate-discovery.ts';
import { runOverseerService } from '../service.ts';
import { watchLoop, type WatchHeartbeatLogger } from '../watch.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO_A = 'repo-a';
const REPO_B = 'repo-b';
const REPOS = [
  { owner: OWNER, repo: REPO_A },
  { owner: OWNER, repo: REPO_B },
];
const WATCHED_BASES = ['dev'] as const;

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function spyLogger(): { logger: WatchHeartbeatLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
    },
  };
}

const count = (entries: readonly LogEntry[], msg: string): number =>
  entries.filter(entry => entry.msg === msg).length;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await sleep(5);
  }
}

function pr(repo: string, prNumber: number): DiscoveredPullRequest {
  return {
    owner: OWNER,
    repo,
    prNumber,
    title: `pull request ${prNumber}`,
    state: 'open',
    draft: false,
    baseRef: 'dev',
    headRef: `feat/${repo}-${prNumber}`,
    headSha: `sha-${repo}-${prNumber}`,
    reviewDecision: 'APPROVED',
  };
}

function greenEvidence(repo: string, prNumber: number): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 4, passed: 4, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: OWNER, repo, number: prNumber },
    prTitle: `pull request ${prNumber}`,
    headSha: `sha-${repo}-${prNumber}`,
    lookupFailed: false,
  };
}

const baseStore: OverseerRunStoreDeps = {
  listRunsForWatch: async () => [],
  listRunEvents: async () => [],
};

beforeEach(() => {
  resetDiscoveryCursorForTests();
});

describe('watchLoop resilience', () => {
  test('Test 1: a hung await is timed out and the next pass still runs', async () => {
    const { logger, entries } = spyLogger();
    const controller = new AbortController();
    let listCallsForA = 0;
    let onRecordCalls = 0;
    const candidates = [pr(REPO_B, 11), pr(REPO_B, 12)];

    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      ...baseStore,
      listOpenPullRequests: async input => {
        if (input.repo === REPO_A) {
          listCallsForA += 1;
          // Pass 1: never settles. Pass 2+: normal.
          if (listCallsForA === 1) return new Promise<DiscoveredPullRequest[]>(() => undefined);
          return [];
        }
        return candidates;
      },
      findPullRequest: async input => {
        const match = candidates.find(candidate => candidate.headRef === input.headBranch);
        if (!match) throw new Error('no fixture');
        return greenEvidence(match.repo, match.prNumber);
      },
      hasQualifiedReview: async () => true,
      mergePullRequest: async () => ({ merged: true }),
    };

    const loop = watchLoop(
      deps,
      async (_record: WatchedRunRecord) => {
        onRecordCalls += 1;
        // The very first record never settles; every later one is fine.
        if (onRecordCalls === 1) await new Promise<void>(() => undefined);
      },
      {
        intervalMs: 5,
        stepTimeoutMs: 50,
        recordTimeoutMs: 50,
        passTimeoutMs: 5000,
        logger,
        signal: controller.signal,
        discovery: { watchedBases: WATCHED_BASES, repos: REPOS },
      }
    );

    await waitFor(
      () =>
        count(entries, 'merge-coordinator.heartbeat_evaluated') >= 2 &&
        count(entries, 'merge-coordinator.record_timeout') >= 1 &&
        onRecordCalls >= 3,
      'two heartbeats, a record timeout and the next records'
    );
    controller.abort();
    await loop;

    // The hung repo listing was named and skipped; the pass still heartbeated.
    const stepTimeout = entries.find(entry => entry.msg === 'merge-coordinator.step_timeout');
    expect(stepTimeout).toBeDefined();
    expect(String(stepTimeout?.obj.label)).toContain(
      `discovery.listOpenPullRequests:${OWNER}/${REPO_A}`
    );
    // The hung onRecord was abandoned, and the NEXT record in the same pass still ran.
    expect(count(entries, 'merge-coordinator.record_timeout')).toBeGreaterThanOrEqual(1);
    expect(onRecordCalls).toBeGreaterThanOrEqual(3);
    // Pass 1 evaluated repo B despite repo A hanging.
    const firstHeartbeat = entries.find(
      entry => entry.msg === 'merge-coordinator.heartbeat_evaluated'
    );
    expect(firstHeartbeat?.obj.prCandidates).toBe(2);
    // A second pass ran and listed repo A again.
    expect(listCallsForA).toBeGreaterThanOrEqual(2);
  });

  test('Test 2: a throw in a pass still reschedules', async () => {
    const { logger, entries } = spyLogger();
    const controller = new AbortController();
    let listRunsCalls = 0;
    let onRecordCalls = 0;
    const candidate = pr(REPO_B, 21);

    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      ...baseStore,
      listRunsForWatch: async () => {
        listRunsCalls += 1;
        // Pass 1 throws outright.
        if (listRunsCalls === 1) throw new Error('database is locked');
        return [];
      },
      listOpenPullRequests: async input => (input.repo === REPO_B ? [candidate] : []),
      findPullRequest: async () => greenEvidence(REPO_B, 21),
      hasQualifiedReview: async () => true,
      mergePullRequest: async () => ({ merged: true }),
    };

    const loop = watchLoop(
      deps,
      async () => {
        onRecordCalls += 1;
        // Pass 2's record throws; pass 3 succeeds.
        if (onRecordCalls === 1) throw new Error('record_handler_boom');
      },
      {
        intervalMs: 5,
        stepTimeoutMs: 500,
        recordTimeoutMs: 500,
        passTimeoutMs: 5000,
        logger,
        signal: controller.signal,
        discovery: { watchedBases: WATCHED_BASES, repos: REPOS },
      }
    );

    await waitFor(() => onRecordCalls >= 2, 'a third pass delivering a record');
    controller.abort();
    await expect(loop).resolves.toBeUndefined();

    const failures = entries.filter(entry => entry.msg === 'overseer.watch.pass_failed_isolated');
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.every(entry => entry.level === 'error')).toBe(true);
    expect(failures.map(entry => entry.obj.stage)).toEqual(
      expect.arrayContaining(['watchOnce', 'onRecord'])
    );
    // Passes two and three ran and heartbeated after the failures.
    expect(count(entries, 'merge-coordinator.heartbeat_evaluated')).toBeGreaterThanOrEqual(2);
    expect(listRunsCalls).toBeGreaterThanOrEqual(3);
  });

  test('Test 3: a throw in the delivery scheduler does not stop the watcher', async () => {
    const { logger, entries } = spyLogger();
    const controller = new AbortController();
    let watcherPasses = 0;
    let drains = 0;
    let rejected: unknown;

    const deps = {
      listRunsForWatch: async () => {
        watcherPasses += 1;
        return [];
      },
      listRunEvents: async () => [],
      findPullRequest: async () => ({ exists: false as const }),
      mergePullRequest: async () => undefined,
      insertOverseerAction: async () => undefined,
    };

    const service = runOverseerService({
      enabled: true,
      adapterKind: 'fake',
      deps,
      signal: controller.signal,
      intervalMs: 5,
      deliveryEnabled: true,
      deliveryIntervalMs: 5,
      logger,
      reconcileRun: async () => undefined,
      deliveryDrain: async () => {
        drains += 1;
        // The 2026-11-04 failure: SQLITE_BUSY on the first drain, fine afterwards.
        if (drains === 1) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
      },
    }).catch((error: unknown) => {
      rejected = error;
    });

    await waitFor(() => drains >= 3 && watcherPasses >= 4, 'drain retries and watcher passes');
    const passesAtCheck = watcherPasses;
    await waitFor(
      () => watcherPasses > passesAtCheck,
      'watcher still passing after the drain error'
    );
    controller.abort();
    await service;

    expect(rejected).toBeUndefined();
    expect(count(entries, 'overseer.delivery.iteration_failed_isolated')).toBe(1);
    expect(drains).toBeGreaterThanOrEqual(3);
  });
});
