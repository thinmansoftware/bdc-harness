/**
 * pr-detection-gate-regression.test.ts
 *
 * Regression coverage for WO-HARNESS-CASCADE-GATE-PR-DETECTION-01
 * (anchor: issue thinmansoftware/bdc-xo#1502).
 *
 * Incident (2026-08-11): WO-LSPRO-CE-COVER-PICKER-SCROLL-01, a mechanical fix at
 * the zero rung, opened lspro-react PRs #513/#515, yet the conductor recorded
 * "no PR opened after completed run" at every rung and climbed to a fable apex
 * run -- frontier price paid for work finished 4 rungs earlier.
 *
 * Root cause (verified against poll.ts + the workflow YAMLs, NOT the spec's
 * "archon/thread-* vs feat/wo-*" hypothesis, which does not match what the
 * workflow pushes): the pushed / PR-head branch is ALWAYS the workflow's
 * UNIQUE_BRANCH ("${BRANCH}-thread-${THREAD_ID}", BRANCH validated
 * ^(feat|fix|wip)/...), emitted as `unique_branch=<name>` by commit-and-push
 * (bdc-feature-development-zero.yaml:2316 + siblings). `archon/thread-<hash>` is
 * only the LOCAL worktree ref -- never the pushed branch. Attribution via
 * `unique_branch=` + `gh pr list --head` was already correct; the gap was that
 * findExistingPrForBranch fired that `gh pr list` ONCE, with no retry, after the
 * event-feed retries were exhausted. GitHub's eventual-consistency window on the
 * `gh pr list` REST path can outlive those event-feed retries, so a single-shot
 * lookup false-negatives and the ladder climbs on already-landed work.
 *
 * The fix adds retry/backoff to the branch lookup. These tests exercise:
 *   Scenario 1 (cascade): completed run opened a PR -> ladder wins on entry tier,
 *              does NOT climb.
 *   Scenario 2 (poll + cascade): PR exists but the FIRST `gh pr list` returns an
 *              empty list (eventual consistency) -> retry finds it -> no climb.
 *   Scenario 3 (poll): PR attributed via the pushed `unique_branch=` value ->
 *              found on first lookup.
 *   Scenario 4 (poll + cascade): a completed run that genuinely opened NO PR ->
 *              retries exhausted -> verdict stays no-PR and the ladder climbs
 *              (fail-closed; the fix must NOT fail-open).
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm as realRm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';

import { ghPrListForBranchDefault, pollForTerminal } from '../poll.js';
import { judgeGate } from '../judge.js';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import type { FireResult } from '../types.js';
import { acquireWoLock, releaseWoLock } from '../wo-lock.js';

const originalFetch = globalThis.fetch;
const intendedTempParent = resolve(tmpdir());
const fixturePrefix = 'smart-cauldron-pr-detection-';
const ownedRoots = new Set<string>();
type RemoveOwnedRoot = (path: string, options: { recursive: true; force: true }) => Promise<void>;

async function makeOutDir(): Promise<string> {
  const root = await mkdtemp(join(intendedTempParent, fixturePrefix));
  ownedRoots.add(root);
  return root;
}

async function cleanupTestState(remove: RemoveOwnedRoot = realRm): Promise<void> {
  try {
    const roots = [...ownedRoots];
    const outcomes = await Promise.allSettled(
      roots.map(async root => {
        const resolvedRoot = resolve(root);
        if (
          !ownedRoots.has(root) ||
          resolvedRoot !== root ||
          dirname(resolvedRoot) !== intendedTempParent ||
          !basename(resolvedRoot).startsWith(fixturePrefix) ||
          basename(resolvedRoot).length <= fixturePrefix.length
        ) {
          throw new Error(`Refusing cleanup of an unowned fixture root: ${root}`);
        }
        await remove(resolvedRoot, { recursive: true, force: true });
        ownedRoots.delete(root);
      })
    );
    const errors: unknown[] = [];
    const failedRoots: string[] = [];
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        errors.push(outcome.reason);
        failedRoots.push(roots[index]!);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Failed to remove owned fixture roots: ${failedRoots.join(', ')}`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

afterEach(async () => {
  await cleanupTestState();
});

// A completed-run API response carrying the given events.
const completedRun = (events: unknown[], runId = 'run-1502') =>
  new Response(JSON.stringify({ run: { id: runId, status: 'completed', metadata: {} }, events }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

// The open-pr node event (PR visible on the run's own event feed).
const openPrEvent = {
  event_type: 'node_completed',
  step_name: 'open-pr-if-needed',
  data: { output: 'PR_URL=https://github.com/thinmansoftware/lspro-react/pull/513' },
};

const liveOpenPrEvent = {
  event_type: 'node_completed',
  step_name: 'open-pr-if-needed',
  data: {
    duration_ms: 3132,
    type: 'bash',
    node_output:
      'ORIGIN_PREC... == db05798e... (attempt 1)\nhttps://github.com/thinmansoftware/bdc-harness/pull/898',
    gate_result: { pass: true },
  },
};

// The commit-and-push node event. Carries the pushed branch as unique_branch=,
// which is the value findExistingPrForBranch attributes the PR by. NOTE the
// branch is a feat/wo-...-thread-... UNIQUE_BRANCH, never archon/thread-*.
const commitPushEvent = (branch: string) => ({
  event_type: 'node_completed',
  step_name: 'commit-and-push',
  data: { output: `VERIFIED: origin/${branch} == local HEAD\nunique_branch=${branch}` },
});

const liveCommitPushEvent = (branch: string) => ({
  event_type: 'node_completed',
  step_name: 'commit-and-push',
  data: { node_output: `VERIFIED: origin/${branch} == local HEAD\nunique_branch=${branch}` },
});

const UNIQUE_BRANCH = 'feat/wo-lspro-ce-cover-picker-scroll-01-thread-abcd1234';

/**
 * Builds a `gh pr list --head` stub that simulates GitHub eventual consistency:
 * the branch's PR is invisible for the first `emptyResponses` calls, then
 * becomes visible. Records the branches it was asked about.
 */
function simulateEventualConsistency(emptyResponses: number, url: string) {
  const branchesSeen: string[] = [];
  let calls = 0;
  const lookup = async (branch: string): Promise<string | null> => {
    branchesSeen.push(branch);
    calls++;
    return calls <= emptyResponses ? null : url;
  };
  return {
    lookup,
    branchesSeen,
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------------------
// pollForTerminal-level: hermetic (gh pr list injected via ghPrListForBranch)
// ---------------------------------------------------------------------------

describe('findExistingPrForBranch retry/backoff (issue #1502)', () => {
  test('reads an explicit PR_URL from node_output', async () => {
    const url = 'https://github.com/thinmansoftware/bdc-harness/pull/900';
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'open-pr-if-needed',
          data: { node_output: `PR_URL=${url}` },
        },
      ])) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-node-output-explicit',
      apiBaseUrl: 'http://archon.test',
      checkPrMergeable: async () => true,
    });

    expect(result.prUrl).toBe(url);
  });

  test('reads the live bare GitHub pull URL shape from node_output', async () => {
    globalThis.fetch = (async () => completedRun([liveOpenPrEvent])) as unknown as typeof fetch;

    const result = await pollForTerminal({
      runId: 'run-node-output-bare',
      apiBaseUrl: 'http://archon.test',
      checkPrMergeable: async () => true,
    });

    expect(result.prUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/898');
  });

  test('ignores non-GitHub URLs and GitHub pull URLs from non-PR nodes', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'open-pr-if-needed',
          data: { node_output: 'https://example.com/thinmansoftware/bdc-harness/pull/898' },
        },
        {
          event_type: 'node_completed',
          step_name: 'publish-result',
          data: { node_output: 'https://github.com/thinmansoftware/bdc-harness/pull/898' },
        },
      ])) as unknown as typeof fetch;

    let ghCalls = 0;
    const result = await pollForTerminal({
      runId: 'run-decoys',
      apiBaseUrl: 'http://archon.test',
      prRetryAttempts: 0,
      ghPrListForBranch: async () => {
        ghCalls++;
        return null;
      },
    });

    expect(result.prUrl).toBeNull();
    expect(ghCalls).toBe(0);
    expect(judgeGate(result).pass).toBe(false);
  });

  test('Scenario 2: PR list empty on first lookup, found on retry -> PR-found (eventual consistency)', async () => {
    // Run completed, pushed its branch, but opened no open-pr NODE event and the
    // gh pr list REST path is briefly empty. The event-feed retries find nothing;
    // the branch lookup must retry and then succeed.
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/515';
    const gh = simulateEventualConsistency(1, prUrl);

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: gh.lookup,
    });

    expect(result.prUrl).toBe(prUrl);
    // First call empty, second call found -> the fix retried instead of giving up.
    expect(gh.calls).toBe(2);
    // Gate must read this as a pass -> no climb.
    expect(judgeGate(result).pass).toBe(true);
  });

  test('Scenario 3: PR attributed to the run via the pushed unique_branch value', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/513';
    const gh = simulateEventualConsistency(0, prUrl);

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: gh.lookup,
    });

    expect(result.prUrl).toBe(prUrl);
    // Attribution used the exact pushed branch, not repo-wide recency.
    expect(gh.branchesSeen).toEqual([UNIQUE_BRANCH]);
    expect(judgeGate(result).pass).toBe(true);
  });

  test('Scenario 4: genuine no-PR after retries exhausted -> verdict stays no-PR (fail-closed)', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    // gh pr list is empty on EVERY attempt -- the run really opened no PR.
    let calls = 0;
    const lookup = async (): Promise<string | null> => {
      calls++;
      return null;
    };

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: lookup,
    });

    expect(result.prUrl).toBeNull();
    // The lookup was retried to exhaustion (3 attempts) before giving up.
    expect(calls).toBe(3);
    // The gate must still fail -- the fix must NOT fail-open on a true negative.
    const verdict = judgeGate(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('no PR opened after completed run');
  });
});

describe('default gh branch lookup', () => {
  test('passes the explicit repository to gh pr list', async () => {
    let invocation: { command: string; args: string[] } | null = null;
    const url = 'https://github.com/thinmansoftware/bdc-harness/pull/898';

    const result = await ghPrListForBranchDefault(
      'feat/example',
      'thinmansoftware/bdc-harness',
      async (command, args) => {
        invocation = { command, args };
        return { stdout: `${url}\n`, stderr: '' };
      }
    );

    expect(result).toBe(url);
    expect(invocation?.command).toBe('gh');
    const repoIndex = invocation?.args.indexOf('--repo') ?? -1;
    expect(repoIndex).toBeGreaterThan(-1);
    expect(invocation?.args[repoIndex + 1]).toBe('thinmansoftware/bdc-harness');
  });

  test('skips gh and logs when the repository is unknown', async () => {
    let execCalls = 0;
    const log = spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await ghPrListForBranchDefault('feat/example', null, async () => {
        execCalls++;
        throw new Error('must not execute');
      });

      expect(result).toBeNull();
      expect(execCalls).toBe(0);
      expect(log.mock.calls.some(call => String(call[0]).includes('repo is unknown'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cascade-level: proves the LADDER does not climb (attempts.length === 1)
// ---------------------------------------------------------------------------

function makeFireOk(runId: string): FireResult {
  return { ok: true, runId, conversationId: 'conv-1502', infraError: null };
}

// Fake WO ID: must NOT resolve to a real bdc-xo issue. The frontier gate-fail
// path (Scenario 4) reaches defaultSpecRepair, which shells out to `gh issue
// comment`/`gh issue edit` against a REAL repo -- so every cascade dep below
// ALSO injects a no-op specRepair stub. The fake id is defense in depth.
async function baseOpts(deps: CascadeDeps): Promise<RunCascadeOptions> {
  return {
    woId: 'WO-TEST-1502-PR-DETECTION-REGRESSION',
    woClass: 'CODE',
    tags: ['mechanical'],
    outDir: await makeOutDir(),
    token: 'test-token',
    project: 'lspro-react',
    deps,
  };
}

describe('PR-detection fixture lifecycle', () => {
  test('fresh roots isolate the same WO and cleanup preserves an untracked sibling', async () => {
    const deps: CascadeDeps = {};
    const firstOpts = await baseOpts(deps);
    const secondOpts = await baseOpts(deps);
    const firstRoot = firstOpts.outDir!;
    const secondRoot = secondOpts.outDir!;
    // Fail before any filesystem operation if allocation still returns a shared root.
    expect(firstRoot).not.toBe(secondRoot);
    for (const opts of [firstOpts, secondOpts]) {
      expect(opts).toMatchObject({
        woId: 'WO-TEST-1502-PR-DETECTION-REGRESSION',
        woClass: 'CODE',
        tags: ['mechanical'],
        token: 'test-token',
        project: 'lspro-react',
      });
      expect(opts.deps).toBe(deps);
    }
    expect((await stat(firstRoot)).isDirectory()).toBe(true);
    expect((await stat(secondRoot)).isDirectory()).toBe(true);

    const woId = firstOpts.woId;
    const project = 'lspro-react';
    let controlRoot: string | undefined;
    try {
      const first = await acquireWoLock(woId, project, 'fixture-first', firstRoot);
      const second = await acquireWoLock(woId, project, 'fixture-second', secondRoot);
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(true);
      const refused = await acquireWoLock(woId, project, 'fixture-refused', firstRoot);
      expect(refused.acquired).toBe(false);
      expect(refused.record.cascadeId).toBe('fixture-first');

      await releaseWoLock(woId, project, 'fixture-first', firstRoot);
      await releaseWoLock(woId, project, 'fixture-second', secondRoot);
      expect(JSON.parse(await readFile(first.path, 'utf8')).status).toBe('released');
      expect(JSON.parse(await readFile(second.path, 'utf8')).status).toBe('released');

      controlRoot = await mkdtemp(join(intendedTempParent, fixturePrefix));
      const control = await acquireWoLock(woId, project, 'fixture-control', controlRoot);
      expect(control.acquired).toBe(true);
      expect(control.record.status).toBe('running');
      const controlBytes = await readFile(control.path);
      globalThis.fetch = (async () => new Response('fixture-fetch')) as typeof fetch;

      await cleanupTestState();

      await expect(stat(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(secondRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(ownedRoots.size).toBe(0);
      expect(globalThis.fetch).toBe(originalFetch);
      expect((await stat(controlRoot)).isDirectory()).toBe(true);
      expect(await readFile(control.path)).toEqual(controlBytes);
      expect(JSON.parse(await readFile(control.path, 'utf8')).status).toBe('running');
    } finally {
      // This control was created by this test; register it only after observation.
      if (controlRoot !== undefined) ownedRoots.add(controlRoot);
    }
  });

  test('cleanup failure stays visible, attempts sibling roots and restores fetch', async () => {
    const failedRoot = await mkdtemp(join(intendedTempParent, fixturePrefix));
    ownedRoots.add(failedRoot);
    const siblingRoot = await mkdtemp(join(intendedTempParent, fixturePrefix));
    ownedRoots.add(siblingRoot);
    const removalError = new Error('synthetic owned-root removal failure');
    const attempts: string[] = [];
    globalThis.fetch = (async () => new Response('fixture-fetch')) as typeof fetch;
    let observedError: unknown;
    try {
      try {
        await cleanupTestState((path, options) => {
          attempts.push(path);
          if (path === failedRoot) throw removalError;
          return realRm(path, options);
        });
      } catch (error) {
        observedError = error;
      }

      expect(observedError).toBeInstanceOf(AggregateError);
      const failure = observedError as AggregateError;
      expect(failure.errors).toContain(removalError);
      expect(failure.message).toContain(failedRoot);
      expect(attempts).toEqual([failedRoot, siblingRoot]);
      await expect(stat(siblingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(ownedRoots.has(siblingRoot)).toBe(false);
      expect((await stat(failedRoot)).isDirectory()).toBe(true);
      expect(ownedRoots.has(failedRoot)).toBe(true);
      expect(globalThis.fetch).toBe(originalFetch);
    } finally {
      // Genuine removal of only the new roots arranged by this negative control.
      for (const root of [failedRoot, siblingRoot]) {
        if (ownedRoots.has(root)) {
          await realRm(root, { recursive: true, force: true });
          ownedRoots.delete(root);
        }
      }
    }
    await expect(stat(failedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(ownedRoots.size).toBe(0);
  });
});

// No-op spec-repair: prevents the frontier gate-fail path from making real
// `gh issue comment` / `gh issue edit` GitHub mutations in unit tests.
const noopSpecRepair: NonNullable<CascadeDeps['specRepair']> = async () => ({
  posted: false,
  issueRepo: null,
  issueNumber: null,
});

// A poll dep that runs the REAL pollForTerminal (so detection + retry are
// exercised end to end) with test-fast delays and an injected gh lookup.
function realPollDep(ghLookup: (branch: string) => Promise<string | null>): CascadeDeps['poll'] {
  return async opts =>
    pollForTerminal({
      ...opts,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      prBranchLookupAttempts: 3,
      prBranchLookupDelayMs: 1,
      ghPrListForBranch: ghLookup,
    });
}

describe('cascade does not climb when the completed run landed a PR (issue #1502)', () => {
  test('Scenario 1: PR present on the run event feed -> wins on entry tier, no climb', async () => {
    globalThis.fetch = (async () => completedRun([openPrEvent])) as unknown as typeof fetch;

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      poll: realPollDep(async () => null),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(await baseOpts(deps));

    expect(result.status).toBe('won');
    expect(result.attempts).toHaveLength(1);
    expect(fireCalls).toBe(1);
  });

  test('live node_output event shape wins on entry tier without climbing', async () => {
    globalThis.fetch = (async () =>
      completedRun([
        liveCommitPushEvent(UNIQUE_BRANCH),
        liveOpenPrEvent,
      ])) as unknown as typeof fetch;

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      poll: realPollDep(async () => null),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(await baseOpts(deps));

    expect(result.status).toBe('won');
    expect(result.attempts).toHaveLength(1);
    expect(fireCalls).toBe(1);
  });

  test('Scenario 2: PR found only after the branch-lookup retry -> still wins on entry tier, no climb', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    // Eventual consistency: gh pr list is empty on the first call, then finds the PR.
    const gh = simulateEventualConsistency(
      1,
      'https://github.com/thinmansoftware/lspro-react/pull/515'
    );

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      poll: realPollDep(gh.lookup),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(await baseOpts(deps));

    expect(result.status).toBe('won');
    expect(result.attempts).toHaveLength(1);
    expect(fireCalls).toBe(1);
  });

  test('Scenario 4: genuine no-PR -> ladder climbs (fail-closed, true negative preserved)', async () => {
    globalThis.fetch = (async () =>
      completedRun([commitPushEvent(UNIQUE_BRANCH)])) as unknown as typeof fetch;

    let fireCalls = 0;
    const deps: CascadeDeps = {
      fire: async () => {
        fireCalls++;
        return makeFireOk(`run-${fireCalls}`);
      },
      // gh pr list never finds a PR -- the run truly opened none.
      poll: realPollDep(async () => null),
      specRepair: noopSpecRepair,
      escalate: async () => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const result = await runCascade(await baseOpts(deps));

    // The fix must NOT fail-open: the entry tier gate-fails and the ladder climbs.
    expect(result.status).not.toBe('won');
    expect(result.attempts[0]?.outcome).toBe('gate-failed');
    expect(result.attempts[0]?.gateFailReason).toContain('no PR opened after completed run');
    expect(result.attempts.length).toBeGreaterThan(1);
    expect(fireCalls).toBeGreaterThan(1);
  });
});
