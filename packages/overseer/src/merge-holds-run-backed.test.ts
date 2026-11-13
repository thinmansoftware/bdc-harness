/**
 * WO-HARNESS-MERGE-GATES-01, Test 9: run_backed_merge_hold_pr_is_merged_by_neither_path.
 *
 * The incident (2026-11-13): shopops-storefront PR 239 carried merge-hold, was Overseer-approved at its
 * exact head with green required checks, and its originating run (a558296f, recorded completed) was
 * merged by the merge MANAGER handler 7 s after the merge COORDINATOR had declined it on the label.
 * The manager's precondition checked owner:reworking and never merge-hold.
 *
 * This file drives the REAL createMergeManager handler and the REAL runMergeExecutionBridgeOnce over ONE
 * shared fake GitHub (the same fake octokit behind createRealMergePullRequest, the single function both
 * paths call to merge). With merge-hold present, no path may merge; with the label removed, the PR merges
 * exactly once. It must FAIL on unmodified dev (the manager path merges the held PR).
 */
import { describe, expect, mock, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import type { QualifiedMergeEvidence } from './actions/merge-ready.ts';
import {
  createRealMergePullRequest,
  type RealGitHubOctokitLike,
} from './adapters/github-real-deps.ts';
import {
  runMergeExecutionBridgeOnce as runMergeExecutionBridgeOnceProduction,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from './merge-execution-bridge.ts';
import { createMergeManager } from './merge-manager.ts';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';

const OWNER = 'thinmansoftware';
const REPO = 'shopops-storefront';
const PR_NUMBER = 239;
const HEAD = 'd8804a704744b9a5c2d979c16506aafe16270b36';
const BASE_SHA = 'b'.repeat(40);
const RUN_ID = 'a558296f2c8ca7767811eee2adffd3e3';
const WO_ID = 'WO-STOREFRONT-PORTAL-PULL-PRICE-DISPLAY-01';

/** One fake GitHub: pulls.get serves the CURRENT labels; pulls.merge succeeds once, then refuses (405). */
function fakeGitHub(initialLabels: string[]) {
  const state = { labels: [...initialLabels], merged: false, mergeCalls: 0, mergesSucceeded: 0 };
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          number: PR_NUMBER,
          title: 'BDC feature Work Order implementation',
          state: state.merged ? 'closed' : 'open',
          merged: state.merged,
          html_url: `https://github.test/${OWNER}/${REPO}/pull/${PR_NUMBER}`,
          head: { sha: HEAD, ref: 'archon/task-web-worker-1794590614509-0n8a50' },
          base: { sha: BASE_SHA, ref: 'staging' },
          labels: state.labels.map(name => ({ name })),
          draft: false,
        },
      }),
      merge: async () => {
        state.mergeCalls += 1;
        if (state.merged) {
          throw Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
        }
        state.merged = true;
        state.mergesSucceeded += 1;
        return { data: { merged: true, sha: 'f'.repeat(40), message: 'merged' } };
      },
    },
  } as unknown as RealGitHubOctokitLike;
  return { state, octokit };
}

function prEvidence(labels: string[]): PullRequestEvidence {
  return {
    exists: true,
    state: 'open',
    checks: { total: 2, passed: 2, failed: 0, pending: 0 },
    mergeable: true,
    mergeableState: 'clean',
    changedFilePaths: ['src/portal/pull-price.tsx'],
    baseBranch: 'staging',
    headSha: HEAD,
    htmlUrl: `https://github.test/${OWNER}/${REPO}/pull/${PR_NUMBER}`,
    pr: { owner: OWNER, repo: REPO, number: PR_NUMBER },
    prTitle: 'BDC feature Work Order implementation',
    labels,
  };
}

// ---- manager path ----------------------------------------------------------------------------------
function managerRecord(labels: string[]): WatchedRunRecord {
  return {
    runId: RUN_ID,
    woId: WO_ID,
    owner: OWNER,
    repo: REPO,
    status: 'completed',
    action: 'merge_ready',
    reason: 'terminal status completed with a green, mergeable PR -- merge candidate',
    workingPath: `/archon/worktrees/${RUN_ID}`,
    prEvidence: prEvidence(labels),
  };
}

function qualifiedEvidence(record: WatchedRunRecord): QualifiedMergeEvidence {
  return {
    record,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: OWNER,
    repository: REPO,
    base_branch: 'staging',
    resulting_deployment_effect: 'staging',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/portal/pull-price.tsx'],
    pr_number: PR_NUMBER,
    head_sha: HEAD,
    base_sha: BASE_SHA,
    required_checks: [{ name: 'storefront-unit-tests', conclusion: 'success', head_sha: HEAD }],
    reviews: [{ resolved: true }],
    independent_review: null,
    operator: {
      identity: 'overseer-merge-manager-v1',
      provider: 'overseer',
      model_family: 'merge-manager',
    },
    manifest: null,
    proposal_id: null,
    proposal_present: false,
    fusion: null,
    expected_verifier_registry_digest: '',
    final_state_consistent: true,
  } as QualifiedMergeEvidence;
}

function approve(
  input: Parameters<NonNullable<Parameters<typeof createMergeManager>[0]['judge']>>[0]
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition: 'approve',
    reason: 'judge_approve',
    woId: input.woId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    evidenceDigest: input.evidenceDigest,
    operator: input.operator,
  };
}

function runManager(labels: string[], github: ReturnType<typeof fakeGitHub>) {
  const record = managerRecord(labels);
  const actions: { action: string; result: string }[] = [];
  const handler = createMergeManager({
    readRunEvents: async () => [],
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['staging'],
    reviewGateLogin: 'thinman-review-gate[bot]',
    listPullRequestReviews: async () => [
      { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: HEAD },
    ],
    assembleEvidence: async () => ({
      evidence: qualifiedEvidence(record),
      evidenceDigest: 'c'.repeat(64),
    }),
    judge: async input => approve(input),
    insertOverseerAction: async input => {
      actions.push({ action: String(input.action), result: String(input.result) });
    },
    findPullRequest: async () => record.prEvidence,
    // The REAL merge function over the shared fake GitHub, exactly as the live wiring does.
    mergePullRequest: createRealMergePullRequest(github.octokit),
    readWorktreeHeadSha: async () => HEAD,
  });
  return { handler, record, actions };
}

// ---- coordinator path (harness copied in shape from merge-owner-reworking.test.ts) --------------------
const runCoordinator = (options: MergeExecutionBridgeOptions): Promise<void> =>
  runMergeExecutionBridgeOnceProduction({
    readRunEvents: async () => [],
    hasQualifiedReview: async () => true,
    reviewConflictAtHead: async () => null,
    ...options,
  });

const verdictRow = (): OverseerVerdictRow =>
  ({
    id: 'verdict-239',
    run_id: RUN_ID,
    wo_id: WO_ID,
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
  }) as OverseerVerdictRow;

function coordinatorHarness(labels: string[], github: ReturnType<typeof fakeGitHub>) {
  const pending = [verdictRow()];
  const processing = new Set<string>();
  const claimReleases: { verdictId: string; reason: string }[] = [];
  const outcomes: { verdictId: string; mutationSent: boolean; reason: string }[] = [];
  let approvals = 0;
  let occupied = 0;
  const slots = new Map<string, { released: boolean }>();
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () => [...pending],
    claimVerdict: async id => {
      if (!pending.some(row => row.id === id)) return false;
      processing.add(id);
      return true;
    },
    releaseVerdictClaim: async (id, reason) => {
      if (!processing.has(id)) return false;
      processing.delete(id);
      claimReleases.push({ verdictId: id, reason });
      return true;
    },
    getRunById: async runId =>
      ({
        id: runId,
        woId: WO_ID,
        owner: OWNER,
        repo: REPO,
        status: 'completed',
        headBranch: 'archon/task-web-worker-1794590614509-0n8a50',
        metadata: {},
      }) as OverseerWatchRun,
    getEarliestMergeSlotReservation: async () =>
      new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async (id, _since, limit) => {
      const existing = slots.get(id);
      if (existing && !existing.released) return false;
      if (occupied >= limit) return false;
      occupied += 1;
      slots.set(id, { released: false });
      return true;
    },
    releaseMergeSlot: async id => {
      const existing = slots.get(id);
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
  const realMerge = createRealMergePullRequest(github.octokit);
  const githubDeps: GitHubClientDeps = {
    findPullRequest: async () => prEvidence(labels),
    approvePullRequest: async () => {
      approvals += 1;
      return { approved: true };
    },
    mergePullRequest: input => realMerge(input),
    listPullRequestComments: async () => [],
    commentOnPullRequest: async () => ({ commented: true }),
  };
  return {
    store,
    githubDeps,
    claimReleases,
    outcomes,
    get approvals() {
      return approvals;
    },
  };
}

const policy = {
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

describe('Test 9: a run-backed PR carrying merge-hold is merged by neither path', () => {
  test('with merge-hold present, the coordinator then the manager merge nothing, and no approval is posted', async () => {
    const github = fakeGitHub(['merge-hold']);

    // Path 1, as seen live at 17:37:35Z: the coordinator.
    const coordinator = coordinatorHarness(['merge-hold'], github);
    await runCoordinator({
      store: coordinator.store,
      github: coordinator.githubDeps,
      readPolicy: () => policy,
    });
    expect(coordinator.claimReleases).toEqual([
      { verdictId: 'verdict-239', reason: 'merge_hold_label' },
    ]);
    expect(coordinator.approvals).toBe(0);

    // Path 2, 7 s later at 17:37:41Z: the manager handler over the same fake GitHub.
    const manager = runManager(['merge-hold'], github);
    const result = await manager.handler(manager.record);

    expect(github.state.mergesSucceeded).toBe(0);
    expect(github.state.mergeCalls).toBe(0);
    expect(result.status).toBe('held');
    expect(manager.actions.filter(a => a.action === 'merged')).toEqual([]);
    expect(
      manager.actions.some(
        a =>
          a.action === 'merge_denied' &&
          a.result.includes('"precondition_miss_reason":"merge_hold_label"')
      )
    ).toBe(true);
  });

  test('with the label removed, the PR merges exactly once (squash, expected head)', async () => {
    const github = fakeGitHub([]);
    const coordinator = coordinatorHarness([], github);
    await runCoordinator({
      store: coordinator.store,
      github: coordinator.githubDeps,
      readPolicy: () => policy,
    });
    const manager = runManager([], github);
    await manager.handler(manager.record);

    expect(github.state.mergesSucceeded).toBe(1);
  });
});

// Keep `mock` imported for parity with sibling suites that spy on the logger.
void mock;
