/**
 * gate-pr-detection.test.ts -- Regression suite for WO-HARNESS-CASCADE-GATE-PR-DETECTION-01.
 *
 * Anchor incident (thinmansoftware/bdc-xo#1502, 2026-08-11): a mechanical WO
 * fired at the zero rung produced lspro-react PRs #513/#515, yet the conductor
 * recorded "no PR opened after completed run" at EVERY rung and climbed to a
 * fable apex run on work finished 4 rungs earlier. Root causes:
 *   (a) the gate's gh lookup carried no --repo, so it resolved the CONDUCTOR'S
 *       cwd repo (bdc-harness) and could never see lspro-react PRs;
 *   (b) branch discovery matched only the last unique_branch= marker, missing
 *       archon/thread-* pushes and dual-branch pushes;
 *   (c) the GitHub lookup ran once, outside the retry loop, so GitHub's own
 *       eventual-consistency window (PR list briefly empty right after run
 *       completion) produced a false negative with no second chance.
 *
 * Spec test scenarios (WO section 11):
 *   1. SUCCESS: completed run + PR on feat/wo-<id> -> PR-found, no climb,
 *      PR recorded in the cascade log (additive prUrl field).
 *   2. EDGE (race): PR exists but the FIRST gate query returns an empty list
 *      (simulated eventual consistency) -> retry finds it, no climb.
 *   3. EDGE (branch pattern): PR head is archon/thread-<id> -> attributed.
 *   4. VALIDATION (true negative): genuinely no PR, retries exhausted ->
 *      verdict stays no-PR and the ladder climbs (fix must not fail-open).
 *
 * All GitHub access goes through the injectable execGh seam -- no live gh
 * calls, no live API calls (CascadeDeps injection for cascade-level tests).
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { pollForTerminal } from '../poll.js';
import { judgeGate } from '../judge.js';
import { runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';
import { loadLadder } from '../ladder.js';
import type { PollResult } from '../types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TARGET_REPO = 'thinmansoftware/lspro-react';

/** Completed-run API response with the given events. */
const completedRun = (events: unknown[]) =>
  new Response(
    JSON.stringify({
      run: { id: 'run-1502', status: 'completed', metadata: {} },
      events,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );

const commitAndPushEvent = (branch: string) => ({
  event_type: 'node_completed',
  step_name: 'commit-and-push',
  data: { output: `VERIFIED: origin/${branch} == local HEAD (abc123)\nunique_branch=${branch}` },
});

// ---------------------------------------------------------------------------
// Scenario 1: completed run opened a PR on feat/wo-<id> -> PR-found, no climb
// ---------------------------------------------------------------------------

describe('Scenario 1: PR on feat/wo-<id> is found and attributed (repo-scoped)', () => {
  test('gate verdict is PR-found and gh receives --repo with the resolved target repo', async () => {
    const branch = 'feat/wo-lspro-ce-cover-picker-scroll-01-thread-abc12345';
    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/513';

    globalThis.fetch = (async () =>
      completedRun([commitAndPushEvent(branch)])) as unknown as typeof fetch;

    const ghCalls: string[][] = [];
    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
      repo: TARGET_REPO,
      execGh: async args => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') return { stdout: `${prUrl}\n` };
        return { stdout: 'MERGEABLE\n' };
      },
    });

    expect(result.prUrl).toBe(prUrl);
    expect(result.prMergeable).toBe(true);

    // Incident-critical: the PR lives on a DIFFERENT repo than the conductor's
    // cwd. The lookup must be scoped with --repo <owner/name>.
    const listCall = ghCalls.find(args => args[0] === 'pr' && args[1] === 'list');
    expect(listCall).toBeDefined();
    expect(listCall).toContain('--repo');
    expect(listCall).toContain(TARGET_REPO);
    expect(listCall).toContain(branch);

    // No climb: the 4-condition gate passes on this PollResult.
    const verdict = judgeGate(result);
    expect(verdict.pass).toBe(true);
    expect(verdict.prOpened).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: GitHub eventual-consistency race -- first PR-list query is empty
// ---------------------------------------------------------------------------

describe('Scenario 2: eventual-consistency race on the PR list', () => {
  test('first gh query returns an empty list; the bounded retry finds the PR -> PR-found, no climb', async () => {
    const branch = 'feat/wo-lspro-ce-cover-picker-scroll-01-thread-abc12345';
    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/515';

    globalThis.fetch = (async () =>
      completedRun([commitAndPushEvent(branch)])) as unknown as typeof fetch;

    // Eventual-consistency fixture: the PR EXISTS, but GitHub's PR list is
    // briefly empty immediately after run completion. First lookup sees [],
    // the next one sees the PR.
    let prListCalls = 0;
    const eventuallyConsistentPrList = (): { stdout: string } => {
      prListCalls++;
      return prListCalls === 1 ? { stdout: '' } : { stdout: `${prUrl}\n` };
    };

    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 3,
      prRetryDelayMs: 1,
      repo: TARGET_REPO,
      execGh: async args => {
        if (args[0] === 'pr' && args[1] === 'list') return eventuallyConsistentPrList();
        return { stdout: 'MERGEABLE\n' };
      },
    });

    // The empty first read did NOT become a false negative: the retry re-asked
    // GitHub and found the PR.
    expect(prListCalls).toBe(2);
    expect(result.prUrl).toBe(prUrl);

    const verdict = judgeGate(result);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).not.toContain('no PR opened after completed run');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: PR head is the engine's archon/thread-<id> branch (no marker)
// ---------------------------------------------------------------------------

describe('Scenario 3: archon/thread-<id> push without a unique_branch marker', () => {
  test('the PR is attributed to the run via the thread-branch token in event output', async () => {
    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/517';

    // No commit-and-push marker event -- only an implement-loop push whose
    // output mentions the engine worktree branch (Patch 2 commit-and-push).
    globalThis.fetch = (async () =>
      completedRun([
        {
          event_type: 'node_completed',
          step_name: 'implement',
          data: {
            output:
              "git push -u origin archon/thread-2d0f2f8a\nbranch 'archon/thread-2d0f2f8a' set up to track remote.",
          },
        },
      ])) as unknown as typeof fetch;

    const headsQueried: string[] = [];
    const result = await pollForTerminal({
      runId: 'run-1502',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 1,
      prRetryDelayMs: 1,
      repo: TARGET_REPO,
      execGh: async args => {
        if (args[0] === 'pr' && args[1] === 'list') {
          const head = args[args.indexOf('--head') + 1] ?? '';
          headsQueried.push(head);
          if (head === 'archon/thread-2d0f2f8a') return { stdout: `${prUrl}\n` };
          return { stdout: '' };
        }
        return { stdout: 'MERGEABLE\n' };
      },
    });

    expect(headsQueried).toContain('archon/thread-2d0f2f8a');
    expect(result.prUrl).toBe(prUrl);
    expect(judgeGate(result).pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: true negative preserved -- genuinely no PR -> gate fails, climb
// ---------------------------------------------------------------------------

describe('Scenario 4: true negative -- no PR anywhere, retries exhausted', () => {
  test('verdict remains no-PR after bounded retries (fix does not fail-open)', async () => {
    const branch = 'feat/wo-truly-no-pr-01-thread-dd55ee66';

    globalThis.fetch = (async () =>
      completedRun([commitAndPushEvent(branch)])) as unknown as typeof fetch;

    let prListCalls = 0;
    const result = await pollForTerminal({
      runId: 'run-no-pr',
      apiBaseUrl: 'http://archon.test',
      timeoutMs: 60_000,
      intervalMs: 1,
      prRetryAttempts: 2,
      prRetryDelayMs: 1,
      repo: TARGET_REPO,
      execGh: async args => {
        if (args[0] === 'pr' && args[1] === 'list') {
          prListCalls++;
          return { stdout: '' };
        }
        return { stdout: '' };
      },
    });

    // Retries are bounded and were exhausted: 1 initial lookup + 2 retries.
    expect(prListCalls).toBe(3);
    expect(result.prUrl).toBeNull();

    // The gate still fails closed -- this is the climb signal.
    const verdict = judgeGate(result);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('no PR opened after completed run');
  });

  test('cascade level: a genuinely PR-less run still climbs the ladder (real judge)', async () => {
    const tiers = loadLadder();
    const fireCalls: string[] = [];
    let specRepairCalled = false;

    const noPrPoll: PollResult = {
      runId: 'run-no-pr',
      terminalStatus: 'completed',
      validatorVerdict: 'unknown',
      prUrl: null,
      prMergeable: null,
      servedModelId: null,
      rawMetadata: {},
    };

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return {
          ok: true,
          runId: `run-${fireCalls.length}`,
          conversationId: 'c',
          infraError: null,
        };
      },
      // Repo RESOLVED: the gate's repo-scoped lookup ran and confirmed no PR.
      // Only a confirmed negative is a climb signal (an unresolved repo is
      // infra-error instead -- see the next describe block).
      resolveRepo: async () => TARGET_REPO,
      poll: async _opts => noPrPoll,
      // deps.judge omitted -- the REAL judgeGate decides the climb.
      escalate: async _ctx => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
      specRepair: async _ctx => {
        specRepairCalled = true;
        return { posted: true, issueRepo: 'thinmansoftware/bdc-xo', issueNumber: 1502 };
      },
    };

    const record = await runCascade({
      woId: 'WO-TEST-NO-PR-01',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir: '/tmp/smart-cauldron-test-runs',
      token: 'test-token',
      project: 'test-project',
      deps,
    } satisfies RunCascadeOptions);

    // Every tier fired: the ladder climbed on each true-negative gate fail.
    expect(record.attempts.length).toBe(tiers.length);
    expect(record.telemetry.climbed).toBe(true);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.attempts[0]?.gateFailReason).toContain('no PR opened after completed run');
    expect(record.attempts[0]?.prUrl).toBeNull();
    // Frontier gate-fail escalated to spec-repair, as before the fix.
    expect(record.status).toBe('spec-repair');
    expect(specRepairCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unresolved repo: a no-PR verdict without attribution is infra-error, not a
// climb (diff-review fix: never convert an attribution failure into a no-PR
// ladder climb, and never fall back to an unscoped gh lookup).
// ---------------------------------------------------------------------------

describe('Unresolved target repo: no-PR verdict is infra-error, never a climb', () => {
  test('completed run, no PR event, repo never resolved -> infra-alert, single attempt, escalated', async () => {
    const fireCalls: string[] = [];
    const escalations: { errorClass: string; reason: string }[] = [];

    const noPrPoll: PollResult = {
      runId: 'run-unattributable',
      terminalStatus: 'completed',
      validatorVerdict: 'unknown',
      prUrl: null,
      prMergeable: null,
      servedModelId: null,
      rawMetadata: {},
    };

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return {
          ok: true,
          runId: `run-${fireCalls.length}`,
          conversationId: 'c',
          infraError: null,
        };
      },
      // Repo resolution FAILS: attribution is impossible for this cascade.
      resolveRepo: async () => null,
      poll: async _opts => noPrPoll,
      // deps.judge omitted -- the REAL judgeGate produces the no-PR failure.
      escalate: async ctx => {
        escalations.push({ errorClass: ctx.errorClass, reason: ctx.reason });
      },
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade({
      woId: 'WO-TEST-UNRESOLVED-REPO-01',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir: '/tmp/smart-cauldron-test-runs',
      token: 'test-token',
      project: 'test-project',
      deps,
    } satisfies RunCascadeOptions);

    // NO ladder climb on the unknown: exactly one tier fired.
    expect(fireCalls.length).toBe(1);
    expect(record.attempts.length).toBe(1);
    expect(record.telemetry.climbed).toBe(false);

    // The attempt is an infra-error (attribution unavailable), not gate-failed.
    expect(record.status).toBe('infra-alert');
    expect(record.attempts[0]?.outcome).toBe('infra-error');
    expect(record.attempts[0]?.infraErrorReason).toContain('PR attribution unavailable');
    expect(record.attempts[0]?.gateFailReason).toBeNull();

    // The operator was alerted with the attribution failure.
    expect(escalations.length).toBe(1);
    expect(escalations[0]?.reason).toContain('never resolved');
  });

  test('failures independent of PR attribution still climb with an unresolved repo', async () => {
    const fireCalls: string[] = [];
    let pollCallIndex = 0;

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return {
          ok: true,
          runId: `run-${fireCalls.length}`,
          conversationId: 'c',
          infraError: null,
        };
      },
      resolveRepo: async () => null,
      poll: async _opts => {
        pollCallIndex++;
        // Tier 0: validator says needs_revision -- a climb signal that does
        // NOT depend on PR attribution. Tier 1: clean win.
        if (pollCallIndex === 1) {
          return {
            runId: 'run-1',
            terminalStatus: 'completed',
            validatorVerdict: 'needs_revision',
            prUrl: null,
            prMergeable: null,
            servedModelId: null,
            rawMetadata: {},
          } satisfies PollResult;
        }
        return {
          runId: 'run-2',
          terminalStatus: 'completed',
          validatorVerdict: 'satisfied',
          prUrl: 'https://github.com/thinmansoftware/lspro-react/pull/518',
          prMergeable: true,
          servedModelId: null,
          rawMetadata: {},
        } satisfies PollResult;
      },
      // deps.judge omitted -- the REAL judgeGate decides.
      escalate: async _ctx => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade({
      woId: 'WO-TEST-UNRESOLVED-REPO-02',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir: '/tmp/smart-cauldron-test-runs',
      token: 'test-token',
      project: 'test-project',
      deps,
    } satisfies RunCascadeOptions);

    // needs_revision climbed normally despite the unresolved repo, and the
    // next rung won on its PR event.
    expect(fireCalls.length).toBe(2);
    expect(record.attempts[0]?.outcome).toBe('gate-failed');
    expect(record.attempts[0]?.gateFailReason).toContain('needs_revision');
    expect(record.status).toBe('won');
  });
});

// ---------------------------------------------------------------------------
// Cascade log + repo threading: PR recorded via prUrl; ladder stops at rung 1
// ---------------------------------------------------------------------------

describe('Cascade: PR-found stops the ladder and lands in the cascade log', () => {
  test('winning attempt records prUrl (additive field), no climb, poll receives the resolved repo', async () => {
    const tiers = loadLadder();
    const prUrl = 'https://github.com/thinmansoftware/lspro-react/pull/513';
    const fireCalls: string[] = [];
    const pollRepos: (string | undefined)[] = [];

    const deps: CascadeDeps = {
      fire: async opts => {
        fireCalls.push(opts.workflowName);
        return { ok: true, runId: 'run-513', conversationId: 'c', infraError: null };
      },
      resolveRepo: async (project, _apiBaseUrl, _token) => {
        expect(project).toBe('lspro-react');
        return TARGET_REPO;
      },
      poll: async opts => {
        pollRepos.push(opts.repo);
        return {
          runId: 'run-513',
          terminalStatus: 'completed',
          validatorVerdict: 'satisfied',
          prUrl,
          prMergeable: true,
          servedModelId: null,
          rawMetadata: {},
        };
      },
      // deps.judge omitted -- the REAL judgeGate decides win/climb.
      escalate: async _ctx => undefined,
      writeRecord: async (record, _dir) => `/tmp/cascade-record-${record.cascadeId}.json`,
    };

    const record = await runCascade({
      woId: 'WO-LSPRO-CE-COVER-PICKER-SCROLL-01',
      woClass: 'CODE',
      tags: ['mechanical'],
      outDir: '/tmp/smart-cauldron-test-runs',
      token: 'test-token',
      project: 'lspro-react',
      deps,
    } satisfies RunCascadeOptions);

    // The ladder STOPPED at the first rung that landed a PR.
    expect(record.status).toBe('won');
    expect(record.attempts.length).toBe(1);
    expect(record.telemetry.climbed).toBe(false);
    expect(record.telemetry.wonCheap).toBe(true);
    expect(record.winningTier).toBe(tiers[0]?.name ?? null);
    expect(fireCalls.length).toBe(1);

    // PR recorded in the cascade log via the additive prUrl field.
    expect(record.attempts[0]?.prUrl).toBe(prUrl);

    // The resolved owner/name repo (NOT the shortname) reached the poll layer.
    expect(pollRepos).toEqual([TARGET_REPO]);
  });
});
