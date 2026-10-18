import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge';
import { hasActiveRunForWo, userMessageWoId } from '../active-run-guard';
import type { GitHubClientDeps, PullRequestEvidence } from '../types.ts';

const HEAD = 'judged-sha';

function verdict(id: string, overrides: Partial<OverseerVerdictRow> = {}): OverseerVerdictRow {
  return {
    id,
    run_id: `run-${id}`,
    wo_id: 'WO-TEST',
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
    ...overrides,
  } as OverseerVerdictRow;
}

function run(id: string): OverseerWatchRun {
  return {
    id,
    woId: 'WO-TEST',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'completed',
    headBranch: `branch-${id}`,
    metadata: {},
  } as OverseerWatchRun;
}

function greenPr(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    mergeable: true,
    mergeableState: 'clean',
    changedFilePaths: ['packages/overseer/src/code.ts'],
    baseBranch: 'dev',
    headSha: HEAD,
    htmlUrl: 'https://github.test/pr/1',
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
    ...overrides,
  };
}

function policy() {
  return {
    service_enabled: true,
    emergency_stop: false,
    legacy_dry_run: false,
    capability_flags: {
      escalation: false,
      repair: false,
      branch: false,
      lifecycle: false,
      merge: true,
    },
  } as const;
}

interface HarnessOptions {
  evidence?: PullRequestEvidence;
  hasActiveRunForWo?: (woId: string) => Promise<boolean>;
  omitHasActiveRun?: boolean;
}

function harness(rows: OverseerVerdictRow[], opts: HarnessOptions = {}) {
  const evidence = opts.evidence ?? greenPr();
  const pending = [...rows];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  const claimReleases: { verdictId: string; reason: string }[] = [];
  const reserveSlotCalls: string[] = [];
  const activeRunCalls: string[] = [];
  const processing = new Set<string>();
  const slots = new Map<string, { released: boolean }>();
  let merges = 0;
  let approvals = 0;
  let occupied = 0;

  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async verdictId => {
      if (!pending.some(row => row.id === verdictId)) return false;
      processing.add(verdictId);
      return true;
    },
    releaseVerdictClaim: async (verdictId, reason) => {
      if (!processing.has(verdictId)) return false;
      processing.delete(verdictId);
      claimReleases.push({ verdictId, reason });
      return true;
    },
    getRunById: async runId => run(runId),
    reserveMergeSlot: async (verdictId, _since, limit) => {
      reserveSlotCalls.push(verdictId);
      const existing = slots.get(verdictId);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(verdictId, { released: false });
      return true;
    },
    releaseMergeSlot: async verdictId => {
      const existing = slots.get(verdictId);
      if (!existing || existing.released) return;
      existing.released = true;
      occupied -= 1;
    },
    recordOutcome: async input => {
      outcomes.push(input);
      processing.delete(input.verdictId);
      const index = pending.findIndex(row => row.id === input.verdictId);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  if (!opts.omitHasActiveRun) {
    const impl = opts.hasActiveRunForWo ?? (async (): Promise<boolean> => false);
    store.hasActiveRunForWo = async (woId: string): Promise<boolean> => {
      activeRunCalls.push(woId);
      return impl(woId);
    };
  }

  const github: GitHubClientDeps = {
    findPullRequest: async () => evidence,
    approvePullRequest: async input => {
      expect(input.expectedHeadSha).toBe(HEAD);
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: async input => {
      expect(input.mergeMethod).toBe('squash');
      expect(input.expectedHeadSha).toBe(HEAD);
      merges += 1;
      return { merged: true, mergeSha: 'merge-sha' };
    },
  };

  return {
    store,
    github,
    outcomes,
    claimReleases,
    reserveSlotCalls,
    activeRunCalls,
    get merges() {
      return merges;
    },
    get approvals() {
      return approvals;
    },
  };
}

afterEach(() => {
  delete process.env.OVERSEER_MAX_MERGES_PER_HOUR;
  delete process.env.OVERSEER_MERGE_REPO_CONFIG;
  delete process.env.MERGE_MANAGER_REPO_POLICY;
});

describe('merge execution bridge active-run defer', () => {
  test('active_run_for_the_same_wo_defers_the_merge', async () => {
    const h = harness([verdict('defer-1')], { hasActiveRunForWo: async () => true });

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.reserveSlotCalls).toHaveLength(0);
    expect(h.outcomes).toHaveLength(0);
    expect(h.claimReleases).toEqual([{ verdictId: 'defer-1', reason: 'active_run_deferred' }]);
  });

  test('no_active_run_merges_exactly_as_before', async () => {
    const h = harness([verdict('merge-1')], { hasActiveRunForWo: async () => false });

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(1);
    expect(h.reserveSlotCalls).toEqual(['merge-1']);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'merge-1',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('deferred_verdict_merges_on_a_later_pass_once_the_run_is_terminal', async () => {
    let firstPass = true;
    const h = harness([verdict('later-1')], {
      hasActiveRunForWo: async () => {
        if (firstPass) {
          firstPass = false;
          return true;
        }
        return false;
      },
    });
    const options = { store: h.store, github: h.github, readPolicy: () => policy() };

    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(0);
    expect(h.claimReleases).toEqual([{ verdictId: 'later-1', reason: 'active_run_deferred' }]);

    await runMergeExecutionBridgeOnce(options);
    expect(h.merges).toBe(1);
    expect(h.outcomes).toEqual([
      expect.objectContaining({
        verdictId: 'later-1',
        mutationSent: true,
        reason: 'merge_executed',
      }),
    ]);
  });

  test('deferral_does_not_stop_later_verdicts_in_the_same_pass', async () => {
    const h = harness(
      [
        verdict('v-a', { wo_id: 'WO-A-01', run_id: 'run-a' }),
        verdict('v-b', { wo_id: 'WO-B-01', run_id: 'run-b' }),
      ],
      { hasActiveRunForWo: async woId => woId === 'WO-A-01' }
    );

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.merges).toBe(1);
    expect(h.claimReleases).toContainEqual({ verdictId: 'v-a', reason: 'active_run_deferred' });
    expect(h.outcomes).toContainEqual(
      expect.objectContaining({ verdictId: 'v-b', mutationSent: true, reason: 'merge_executed' })
    );
    expect(h.outcomes.some(outcome => outcome.verdictId === 'v-a')).toBe(false);
  });

  test('failing_active_run_check_defers_fail_safe', async () => {
    const h = harness([verdict('fail-1')], {
      hasActiveRunForWo: async () => {
        throw new Error('db down');
      },
    });

    await expect(
      runMergeExecutionBridgeOnce({ store: h.store, github: h.github, readPolicy: () => policy() })
    ).resolves.toBeUndefined();

    expect(h.merges).toBe(0);
    expect(h.reserveSlotCalls).toHaveLength(0);
    expect(h.claimReleases).toEqual([{ verdictId: 'fail-1', reason: 'active_run_check_failed' }]);
  });

  test('runless_pull_ref_verdict_is_not_deferred_and_never_calls_the_helper', async () => {
    const h = harness(
      [
        verdict('pr5', {
          wo_id: 'gh:thinmansoftware/bdc-harness#5',
          run_id: 'pr-discovery:thinmansoftware/bdc-harness#5',
        }),
      ],
      {
        evidence: greenPr({ pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 5 } }),
        // Would defer if ever consulted -- it must not be for a run-less ref.
        hasActiveRunForWo: async () => true,
      }
    );

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.activeRunCalls).toHaveLength(0);
    expect(h.merges).toBe(1);
  });

  test('pr_discovery_verdict_carrying_a_real_wo_id_defers_when_a_run_is_active', async () => {
    // A discovered PR (run-less, pr-discovery: run id) can still carry a real
    // WO id. The gate is on the wo_id shape, not on run-backing, so this MUST
    // defer while a repair run for the same WO is executing (bdc-harness #1046).
    const h = harness(
      [
        verdict('disc-1', {
          wo_id: 'WO-DISCOVERED-01',
          run_id: 'pr-discovery:thinmansoftware/bdc-harness#7',
        }),
      ],
      {
        evidence: greenPr({ pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 7 } }),
        hasActiveRunForWo: async woId => woId === 'WO-DISCOVERED-01',
      }
    );

    await runMergeExecutionBridgeOnce({
      store: h.store,
      github: h.github,
      readPolicy: () => policy(),
    });

    expect(h.activeRunCalls).toEqual(['WO-DISCOVERED-01']);
    expect(h.merges).toBe(0);
    expect(h.approvals).toBe(0);
    expect(h.reserveSlotCalls).toHaveLength(0);
    expect(h.outcomes).toHaveLength(0);
    expect(h.claimReleases).toEqual([{ verdictId: 'disc-1', reason: 'active_run_deferred' }]);
  });

  test('active_run_matching_is_exact_on_the_wo_id_and_ignores_prose', async () => {
    const messages = [
      'WO_ID=WO-A-01 --project x',
      'WO_ID=WO-A-011 --project x',
      'notes mention WO-A-01 only in prose',
    ];
    const list = async (): Promise<string[]> => messages;

    expect(await hasActiveRunForWo('WO-A-01', list)).toBe(true);
    expect(await hasActiveRunForWo('WO-A-0', list)).toBe(false);
    expect(await hasActiveRunForWo('WO-Z-09', list)).toBe(false);
    expect(userMessageWoId(messages[0] as string)).toBe('WO-A-01');
    expect(userMessageWoId(messages[2] as string)).toBeNull();
  });

  test('service_wiring_passes_the_helper_into_the_production_store', () => {
    const serviceSrc = readFileSync(join(import.meta.dir, '..', 'service.ts'), 'utf8');
    expect(serviceSrc).toContain('hasActiveRunForWo');
  });
});
