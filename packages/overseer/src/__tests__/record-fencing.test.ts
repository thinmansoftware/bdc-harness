/**
 * Round 2, finding 1 (PR 1502): a timed-out or stopped record handler must be
 * cancelled and fenced, and must never overlap a newer handler for the same record.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetDiscoveryCursorForTests } from '../merge-candidate-discovery.ts';
import { handleRecord } from '../service.ts';
import { watchLoop, type WatchHeartbeatLogger } from '../watch.ts';
import type {
  DiscoveredPullRequest,
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'fence-repo';
const REPOS = [{ owner: OWNER, repo: REPO }];

interface Entry {
  level: string;
  obj: Record<string, unknown>;
  msg: string;
}
function spyLogger(): { logger: WatchHeartbeatLogger; entries: Entry[] } {
  const entries: Entry[] = [];
  return {
    entries,
    logger: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
    },
  };
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${label}`);
    await sleep(5);
  }
}

const candidatePr: DiscoveredPullRequest = {
  owner: OWNER,
  repo: REPO,
  prNumber: 31,
  title: 'pr 31',
  state: 'open',
  draft: false,
  baseRef: 'dev',
  headRef: 'feat/pr-31',
  headSha: 'sha-31',
  reviewDecision: 'APPROVED',
};
const evidence: PullRequestEvidence = {
  exists: true,
  state: 'open',
  checks: { total: 4, passed: 4, failed: 0, pending: 0 },
  mergeable: true,
  pr: { owner: OWNER, repo: REPO, number: 31 },
  prTitle: 'pr 31',
  headSha: 'sha-31',
  lookupFailed: false,
};
const deps: OverseerRunStoreDeps & GitHubClientDeps & OverseerActionsDeps = {
  listRunsForWatch: async () => [],
  listRunEvents: async () => [],
  listOpenPullRequests: async () => [candidatePr],
  findPullRequest: async () => evidence,
  hasQualifiedReview: async () => true,
  mergePullRequest: async () => ({ merged: true }),
  insertOverseerAction: async () => undefined,
};
const loopOptions = {
  intervalMs: 5,
  stepTimeoutMs: 500,
  passTimeoutMs: 5000,
  discovery: { watchedBases: ['dev'], repos: REPOS },
} as const;

beforeEach(() => {
  resetDiscoveryCursorForTests();
});

describe('record handler fencing', () => {
  test('(i) a handler that times out and then resumes performs no merge', async () => {
    const { logger, entries } = spyLogger();
    const controller = new AbortController();
    const merges: string[] = [];
    let handlerStarts = 0;
    let resumed = false;

    const loop = watchLoop(
      deps,
      async (record: WatchedRunRecord, signal?: AbortSignal) => {
        handlerStarts += 1;
        if (handlerStarts > 1) return;
        await sleep(120); // outlives the 40 ms record timeout
        resumed = true;
        await handleRecord(
          record,
          deps,
          false,
          'test',
          async r => {
            merges.push(r.runId);
          },
          undefined,
          signal
        );
      },
      { ...loopOptions, recordTimeoutMs: 40, logger, signal: controller.signal }
    );
    await waitFor(() => resumed, 'handler resumed after its timeout');
    await sleep(30);
    controller.abort();
    await loop;

    expect(entries.some(e => e.msg === 'merge-coordinator.record_timeout')).toBe(true);
    expect(merges).toEqual([]);
  });

  test('(ii) the same record is never handled by two handlers at once', async () => {
    const { logger, entries } = spyLogger();
    const controller = new AbortController();
    let active = 0;
    let maxActive = 0;
    let starts = 0;

    const loop = watchLoop(
      deps,
      async () => {
        starts += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(100); // longer than the 30 ms record timeout and several passes
        active -= 1;
      },
      { ...loopOptions, recordTimeoutMs: 30, logger, signal: controller.signal }
    );
    await waitFor(
      () => entries.filter(e => e.msg === 'merge-coordinator.record_skipped_in_flight').length >= 2,
      'in-flight skips'
    );
    controller.abort();
    await loop;
    await sleep(120);

    expect(maxActive).toBe(1);
    expect(starts).toBe(1);
    const skip = entries.find(e => e.msg === 'merge-coordinator.record_skipped_in_flight');
    expect(skip?.obj.reason).toBe('previous_handler_unfinished');
  });

  test('(iii) after the loop stops, a resumed handler performs no side effect', async () => {
    const controller = new AbortController();
    const merges: string[] = [];
    const actions: string[] = [];
    const fencedDeps = {
      ...deps,
      insertOverseerAction: async (r: { action: string }) => {
        actions.push(r.action);
      },
    };
    let resumed = false;
    const loop = watchLoop(
      deps,
      async (record: WatchedRunRecord, signal?: AbortSignal) => {
        await sleep(80);
        resumed = true;
        await handleRecord(
          record,
          fencedDeps,
          false,
          'test',
          async r => {
            merges.push(r.runId);
          },
          undefined,
          signal
        );
      },
      { ...loopOptions, recordTimeoutMs: 5000, signal: controller.signal }
    );
    await sleep(20);
    controller.abort();
    await loop; // returns promptly: it does not wait for the handler
    expect(resumed).toBe(false);
    await waitFor(() => resumed, 'handler resumed after stop');
    await sleep(30);
    expect(merges).toEqual([]);
    expect(actions).toEqual([]);
  });

  test('handleRecord fences merge and actions on an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const record = {
      runId: 'r1',
      woId: 'WO-X',
      action: 'merge_ready',
      reason: 'x',
      prEvidence: evidence,
    } as unknown as WatchedRunRecord;
    await handleRecord(
      record,
      {
        ...deps,
        insertOverseerAction: async () => {
          calls.push('action');
        },
      },
      false,
      'test',
      async () => {
        calls.push('merge');
      },
      undefined,
      controller.signal
    );
    expect(calls).toEqual([]);
  });
});
