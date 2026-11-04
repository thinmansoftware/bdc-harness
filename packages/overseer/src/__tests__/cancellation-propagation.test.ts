/**
 * Round 3 (PR 1502), finding 1: cancellation must reach INTO the merge coordinator
 * and the deterministic merge handoff, not just fence their entry. A cancellation
 * that lands DURING an evidence or judgment await must lead to no merge and no write.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import { RecordHandlerCancelledError } from '../cancellation-fence.ts';
import { coordinateMergeReady } from '../merge-coordinator.ts';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
} from '../merge-execution-bridge.ts';
import { createMergeManager } from '../merge-manager.ts';
import { fenceMergeHandlers, handleRecord } from '../service.ts';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

const HEAD = 'a'.repeat(40);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const record: WatchedRunRecord = {
  runId: 'run-cancel-1',
  woId: 'WO-CANCEL-01',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  errorClass: 'tail_node_false_fail',
  workingPath: '/archon/worktrees/run-cancel-1',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
    prTitle: 'Ready to merge',
    filesChangedCount: 1,
    diffStat: '+1 -0',
    headSha: HEAD,
  },
};

function evidence(): QualifiedMergeEvidence {
  return {
    record,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: record.owner,
    repository: record.repo,
    base_branch: 'dev',
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/index.ts'],
    pr_number: 42,
    head_sha: HEAD,
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: HEAD }],
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

function receipt(
  disposition: 'approve' | 'hold',
  input: {
    woId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    evidenceDigest: string;
    operator: never;
  }
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition,
    reason: disposition === 'approve' ? 'judge_approve' : 'judge_hold',
    woId: input.woId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    evidenceDigest: input.evidenceDigest,
    operator: input.operator,
  } as GrokDispositionReceipt;
}

describe('coordinateMergeReady cancellation', () => {
  test('cancellation during the judgment await: approve verdict leads to no merge and no write', async () => {
    const controller = new AbortController();
    const handleMergeReady = mock(async () => ({ merged: true }) as never);
    const insertOverseerAction = mock(async () => undefined);
    const run = coordinateMergeReady(
      record,
      {
        assembleEvidence: async () => ({ evidence: evidence(), evidenceDigest: 'c'.repeat(64) }),
        assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'p' }),
        judge: async input => {
          await sleep(30);
          return receipt('approve', input as never);
        },
        handleMergeReady,
        executionDeps: { insertOverseerAction } as never,
        insertOverseerAction,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(handleMergeReady).not.toHaveBeenCalled();
    expect(insertOverseerAction).not.toHaveBeenCalled();
  });

  test('cancellation during the judgment await: hold verdict writes no merge_denied row', async () => {
    const controller = new AbortController();
    const insertOverseerAction = mock(async () => undefined);
    const run = coordinateMergeReady(
      record,
      {
        assembleEvidence: async () => ({ evidence: evidence(), evidenceDigest: 'c'.repeat(64) }),
        assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'p' }),
        judge: async input => {
          await sleep(30);
          return receipt('hold', input as never);
        },
        handleMergeReady: mock(async () => ({}) as never),
        executionDeps: {} as never,
        insertOverseerAction,
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(insertOverseerAction).not.toHaveBeenCalled();
  });

  test('cancellation during the evidence await: nothing runs, even the gated executor', async () => {
    const controller = new AbortController();
    const handleMergeReady = mock(async () => ({}) as never);
    const run = coordinateMergeReady(
      record,
      {
        assembleEvidence: async () => {
          await sleep(30);
          return { evidence: evidence(), evidenceDigest: 'c'.repeat(64) };
        },
        assess: () => ({ eligible: false }) as never,
        judge: async () => {
          throw new Error('judge must not run');
        },
        handleMergeReady,
        executionDeps: {} as never,
        insertOverseerAction: mock(async () => undefined),
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(handleMergeReady).not.toHaveBeenCalled();
  });

  test('an executor that reaches mergePullRequest after cancellation cannot merge', async () => {
    const controller = new AbortController();
    const mergePullRequest = mock(async () => ({ merged: true }));
    const result = coordinateMergeReady(
      record,
      {
        assembleEvidence: async () => ({ evidence: evidence(), evidenceDigest: 'c'.repeat(64) }),
        assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'p' }),
        judge: async input => receipt('approve', input as never),
        // The executor itself is slow: cancellation lands while it is mid-flight.
        handleMergeReady: (async (
          _evidence: unknown,
          deps: { mergePullRequest: () => Promise<unknown> }
        ) => {
          await sleep(30);
          return deps.mergePullRequest();
        }) as never,
        executionDeps: { mergePullRequest } as never,
        insertOverseerAction: mock(async () => undefined),
      },
      controller.signal
    );
    setTimeout(() => controller.abort(), 10);
    await expect(result).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });
});

describe('merge manager cancellation', () => {
  test('cancellation during the judge await in execute mode: no merge, no action row', async () => {
    const controller = new AbortController();
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true }));
    const mergePullRequest = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev'],
      reviewGateLogin: 'gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'gate[bot]', state: 'APPROVED', commitId: HEAD },
      ],
      assembleEvidence: async () => ({ evidence: evidence(), evidenceDigest: 'c'.repeat(64) }),
      judge: async input => {
        await sleep(30);
        return receipt('approve', input as never);
      },
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      readWorktreeHeadSha: async () => HEAD,
    });
    const run = manager(record, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(run).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(execute).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).not.toHaveBeenCalled();
  });

  test('through handleRecord: cancellation during the manager judge await is fenced end to end', async () => {
    const controller = new AbortController();
    const insertOverseerAction = mock(async () => undefined);
    const mergePullRequest = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev'],
      reviewGateLogin: 'gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'gate[bot]', state: 'APPROVED', commitId: HEAD },
      ],
      assembleEvidence: async () => ({ evidence: evidence(), evidenceDigest: 'c'.repeat(64) }),
      judge: async input => {
        await sleep(30);
        return receipt('approve', input as never);
      },
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      readWorktreeHeadSha: async () => HEAD,
    });
    const deps = {
      listRunsForWatch: async () => [],
      listRunEvents: async () => [],
      findPullRequest: async () => record.prEvidence,
      mergePullRequest,
      insertOverseerAction,
    };
    setTimeout(() => controller.abort(), 10);
    await handleRecord(record, deps, false, 'test', manager, undefined, controller.signal);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(insertOverseerAction).not.toHaveBeenCalled();
  });
});

describe('deterministic merge handoff cancellation', () => {
  const T0 = new Date('2026-11-04T00:00:00.000Z');
  const verdictRow = {
    id: 'v1',
    run_id: 'run-v1',
    wo_id: 'WO-V1',
    head_sha: 'head',
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
    merge_not_before: null,
    merge_last_transient_reason: null,
  } as unknown as OverseerVerdictRow;
  const green: PullRequestEvidence = {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    mergeableState: 'clean',
    changedFilePaths: ['src/code.ts'],
    baseBranch: 'dev',
    headSha: 'head',
    htmlUrl: 'https://github.test/pull/1',
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
  };

  function harness(findDelayMs: number) {
    const calls = { merge: 0, outcome: 0, claim: 0, release: 0, reserve: 0 };
    const store: MergeExecutionBridgeStore = {
      listUnactionedVerdicts: async () => [{ ...verdictRow }],
      claimVerdict: async () => {
        calls.claim += 1;
        return true;
      },
      releaseVerdictClaim: async () => {
        calls.release += 1;
        return true;
      },
      getRunById: async id =>
        ({
          id,
          woId: 'WO-TEST',
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          status: 'completed',
          headBranch: 'feature',
          metadata: {},
        }) as OverseerWatchRun,
      getEarliestMergeSlotReservation: async () =>
        new Date(Date.now() - 50 * 60 * 1000).toISOString(),
      reserveMergeSlot: async () => {
        calls.reserve += 1;
        return true;
      },
      releaseMergeSlot: async () => undefined,
      recordOutcome: async () => {
        calls.outcome += 1;
      },
    };
    const github: GitHubClientDeps = {
      findPullRequest: async () => {
        await sleep(findDelayMs);
        return green;
      },
      mergePullRequest: async () => {
        calls.merge += 1;
        return { merged: true, mergeSha: 'merged' };
      },
    };
    const options: MergeExecutionBridgeOptions = {
      store,
      github,
      hasQualifiedReview: async () => true,
      reviewConflictAtHead: async () => null,
      now: () => T0,
      readPolicy: () => ({
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
      }),
      repoConfig: { 'thinmansoftware/bdc-harness': { baseBranch: 'dev' } },
    };
    return { options, calls };
  }

  test('control: without cancellation the bridge merges', async () => {
    const h = harness(0);
    await runMergeExecutionBridgeOnce(h.options);
    expect(h.calls.merge).toBe(1);
  });

  test('cancellation during the bridge evidence await: no merge and no outcome write', async () => {
    const controller = new AbortController();
    const h = harness(40);
    const run = runMergeExecutionBridgeOnce({ ...h.options, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await run.catch(() => undefined);
    expect(h.calls.merge).toBe(0);
    expect(h.calls.outcome).toBe(0);
    expect(h.calls.reserve).toBe(0);
  });

  test('the handoff and coordinator wrappers pass the signal in and refuse after abort', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const { coordinator, handoff } = fenceMergeHandlers(
      async (_record, signal) => {
        seen.push(signal);
      },
      {
        handoff: async (_record, signal) => {
          seen.push(signal);
        },
      },
      controller.signal
    );
    await coordinator?.(record);
    await handoff?.handoff(record);
    expect(seen).toEqual([controller.signal, controller.signal]);
    controller.abort();
    await expect(coordinator?.(record)).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    await expect(handoff?.handoff(record)).rejects.toBeInstanceOf(RecordHandlerCancelledError);
    expect(seen).toHaveLength(2);
  });
});
