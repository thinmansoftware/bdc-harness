/**
 * WO-HARNESS-CLIMB-REPAIR-TARGET-BY-RUN-BRANCH-01 (bdc-xo #4638).
 *
 * Anchors (2026-11-04): the CANARY-09 climb opened bdc-harness #1480 beside #1476,
 * whose body had no `WO:` line and whose head branch was archon/task-web-worker-*;
 * the provisioner climb opened #88 beside #87 although #87 matched, because the
 * open-PR lookup swallowed an error to []. A climb now also matches the earlier
 * runs' head branches and HOLDS (one operator message, no fire) when it cannot look.
 */
import { describe, expect, test } from 'bun:test';
import { listOpenWoPullRequests, type OpenWoPullRequest } from '../already-satisfied.js';
import { CLIMB_HELD_REASON_PREFIX, runCascade } from '../cascade.js';
import type { CascadeDeps, RunCascadeOptions } from '../cascade.js';

const WO = 'WO-TEST-001';
const PRIOR_BRANCH = 'archon/task-web-worker-1793777881142-odejgq';

/** A raw GitHub open-PR row (gh api repos/<r>/pulls shape). */
function ghRow(overrides: { number: number; ref: string; body?: string; draft?: boolean }) {
  return {
    number: overrides.number,
    draft: overrides.draft ?? false,
    body: overrides.body ?? 'Adds the canary marker.\n\nRelated: WO-TEST-001 (not a WO: line)',
    html_url: `https://github.com/thinmansoftware/bdc-harness/pull/${String(overrides.number)}`,
    created_at: '2026-11-04T07:42:58Z',
    head: {
      ref: overrides.ref,
      sha: 'a'.repeat(40),
      repo: { full_name: 'thinmansoftware/bdc-harness' },
    },
  };
}

describe('listOpenWoPullRequests (bdc-xo #4638)', () => {
  test('pr_found_by_prior_run_branch (Test 1)', async () => {
    const lookup = async () => [ghRow({ number: 1476, ref: PRIOR_BRANCH })];
    // Without the prior branch the marker-less PR is invisible (today's gap).
    expect(await listOpenWoPullRequests({ woId: WO, project: 'bdc-harness', lookup })).toEqual([]);
    const found = await listOpenWoPullRequests({
      woId: WO,
      project: 'bdc-harness',
      lookup,
      headBranches: [PRIOR_BRANCH],
    });
    expect(found.map(pr => [pr.number, pr.headRefName])).toEqual([[1476, PRIOR_BRANCH]]);
    // A draft on that branch still does not count.
    const drafts = await listOpenWoPullRequests({
      woId: WO,
      project: 'bdc-harness',
      lookup: async () => [ghRow({ number: 88, ref: PRIOR_BRANCH, draft: true })],
      headBranches: [PRIOR_BRANCH],
    });
    expect(drafts).toEqual([]);
  });

  test('lookup_error_throws_only_when_asked (Test 2)', async () => {
    const lookup = async (): Promise<never> => {
      throw new Error('github down');
    };
    expect(await listOpenWoPullRequests({ woId: WO, project: 'bdc-harness', lookup })).toEqual([]);
    let thrown = '';
    try {
      await listOpenWoPullRequests({ woId: WO, project: 'bdc-harness', lookup, failOnError: true });
    } catch (error) {
      thrown = (error as Error).message;
    }
    expect(thrown).toBe('github down');
  });
});

function makeFireOk(runId: string) {
  return { ok: true as const, runId, infraError: null };
}

function pollResult(overrides: Record<string, unknown> = {}) {
  return {
    terminalStatus: 'completed',
    validatorVerdict: 'pass',
    prUrl: 'https://github.com/thinmansoftware/test-project/pull/1',
    prMergeable: true,
    rawMetadata: {},
    ...overrides,
  };
}

interface Harness {
  readonly opts: RunCascadeOptions;
  readonly messages: string[];
  readonly escalations: { errorClass: string; reason: string }[];
  readonly prsCreated: number[];
}

/**
 * Entry tier gate-fails after opening a PR on PRIOR_BRANCH (as the cursor rung did);
 * the climb tier passes. `prsCreated` counts PRs the climb's fire would open: a fire
 * WITHOUT a repair-target line opens a new PR, as the canary climbs did.
 */
function harness(
  read: NonNullable<CascadeDeps['listOpenWoPullRequests']>,
  readRunDetail?: CascadeDeps['readRunDetail']
): Harness {
  const messages: string[] = [];
  const escalations: { errorClass: string; reason: string }[] = [];
  const prsCreated: number[] = [];
  let fires = 0;
  const deps = {
    findWoClaim: async () => null,
    listOpenWoPullRequests: read,
    fire: async (opts: { message: string }) => {
      fires += 1;
      messages.push(opts.message);
      if (fires > 1 && !opts.message.split('\n').some(l => l.startsWith('Repair target: '))) {
        prsCreated.push(fires);
      }
      return makeFireOk(`run-${String(fires)}`);
    },
    poll: async () =>
      fires === 1
        ? pollResult({ prUrl: null, prMergeable: null, validatorVerdict: 'needs_revision' })
        : pollResult(),
    judge: () =>
      fires === 1
        ? { pass: false, failingConditions: ['no PR opened'], reasons: ['no PR opened'] }
        : { pass: true, failingConditions: [], reasons: [] },
    escalate: async (input: { errorClass: string; reason: string }) => {
      escalations.push({ errorClass: input.errorClass, reason: input.reason });
    },
    writeRecord: async (record: { cascadeId: string }) => `/tmp/cascade-${record.cascadeId}.json`,
    acquireWoLock: async ({ woId, project, cascadeId }: Record<string, string>) => ({
      acquired: true,
      path: 'in-memory-test-lock',
      record: {
        woId,
        project,
        cascadeId,
        status: 'running',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    }),
    releaseWoLock: async () => {},
    readRunDetail:
      readRunDetail ??
      (async () => ({
        status: 'failed',
        metadata: {
          teardown_confirmed_at: '2026-11-01T00:00:00.000Z',
          head_branch: PRIOR_BRANCH,
        },
      })),
  } as unknown as CascadeDeps;
  const opts = {
    woId: WO,
    project: 'test-project',
    apiBaseUrl: 'http://localhost:9999',
    token: 'test-token',
    deps,
  } as unknown as RunCascadeOptions;
  return { opts, messages, escalations, prsCreated };
}

function openPr(number: number, headRefName: string): OpenWoPullRequest {
  return {
    number,
    headRefName,
    headSha: 'a'.repeat(40),
    url: `https://github.com/thinmansoftware/test-project/pull/${String(number)}`,
    createdAt: '2026-11-04T07:42:58Z',
    isDraft: false,
    isFork: false,
    body: '',
  };
}

describe('climb repair target by earlier run branch (bdc-xo #4638)', () => {
  test('escalation_replay_with_open_pr_opens_no_new_pr (Test 3)', async () => {
    const seen: { headBranches?: readonly string[]; failOnError?: boolean }[] = [];
    const h = harness(async (_wo, _project, options) => {
      seen.push(options ?? {});
      // The marker-less PR is found only through the earlier run's branch.
      return options?.headBranches?.includes(PRIOR_BRANCH) ? [openPr(1476, PRIOR_BRANCH)] : [];
    });
    const record = await runCascade(h.opts);

    expect(record.status).toBe('won');
    expect(h.messages.length).toBe(2);
    expect(seen).toEqual([{ headBranches: [PRIOR_BRANCH], failOnError: true }]);
    expect(h.messages[1]?.split('\n').filter(l => l.startsWith('Repair target: '))).toEqual([
      `Repair target: PR #1476 (branch ${PRIOR_BRANCH})`,
    ]);
    expect(h.prsCreated).toEqual([]);
    expect(h.escalations).toEqual([]);
  });

  test('lookup_failure_holds_climb_with_one_operator_message (Test 4)', async () => {
    const h = harness(async () => {
      throw new Error('github down');
    });
    const record = await runCascade(h.opts);

    expect(record.status).toBe('infra-alert');
    expect(h.messages.length).toBe(1);
    expect(h.prsCreated).toEqual([]);
    expect(h.escalations.length).toBe(1);
    expect(h.escalations[0]?.reason.startsWith(`${CLIMB_HELD_REASON_PREFIX} ${WO}`)).toBe(true);
    expect(h.escalations[0]?.reason).toContain('github down');
  });

  test('unreadable earlier run holds the climb too (Test 4)', async () => {
    let reads = 0;
    const h = harness(
      async () => [],
      async () => {
        reads += 1;
        // The teardown wait reads first; the repair-target lookup read fails.
        return reads === 1
          ? { status: 'failed', metadata: { teardown_confirmed_at: '2026-11-01T00:00:00.000Z' } }
          : null;
      }
    );
    const record = await runCascade(h.opts);

    expect(record.status).toBe('infra-alert');
    expect(h.messages.length).toBe(1);
    expect(h.escalations.length).toBe(1);
    expect(h.escalations[0]?.reason.startsWith(`${CLIMB_HELD_REASON_PREFIX} ${WO}`)).toBe(true);
    expect(h.escalations[0]?.reason).toContain('run detail unavailable for prior run run-1');
  });

  test('first_attempt_unchanged (Test 5)', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      throw new Error('github down');
    });
    // Make the entry tier pass: no climb, so the climb lookup never runs.
    const deps = h.opts.deps as unknown as Record<string, unknown>;
    deps.poll = async () => pollResult();
    deps.judge = () => ({ pass: true, failingConditions: [], reasons: [] });
    const record = await runCascade(h.opts);

    expect(record.status).toBe('won');
    expect(h.messages.length).toBe(1);
    expect(calls).toBe(0);
    expect(h.escalations).toEqual([]);
  });
});
