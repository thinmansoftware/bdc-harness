import { describe, expect, mock, test } from 'bun:test';
import { createMergeManager } from '../merge-manager.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type { GrokDispositionReceipt, WatchedRunRecord } from '../types.ts';

const RUN_HEAD_SHA = 'a'.repeat(40);

const record: WatchedRunRecord = {
  runId: 'run-merge-manager-1',
  woId: 'WO-MERGE-MANAGER-01',
  owner: 'bluedevilcollectibles',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  errorClass: 'tail_node_false_fail',
  // Engine-written worktree path -- required for merge provenance.
  workingPath: '/archon/worktrees/run-merge-manager-1',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
    prTitle: 'Ready to merge',
    filesChangedCount: 1,
    diffStat: '+1 -0',
    headSha: RUN_HEAD_SHA,
  },
};

/** Stand-in for git: the run's worktree tip matches the PR head. */
const readWorktreeHeadSha = async (): Promise<string | null> => RUN_HEAD_SHA;

function evidence(overrides: Partial<QualifiedMergeEvidence> = {}): QualifiedMergeEvidence {
  return {
    record,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: record.owner,
    repository: record.repo,
    base_branch: 'dev',
    resulting_deployment_effect: 'staging',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/index.ts'],
    pr_number: 42,
    head_sha: 'a'.repeat(40),
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: 'a'.repeat(40) }],
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
    ...overrides,
  };
}

function approveReceipt(
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

describe('merge manager', () => {
  test('staging and dev-effect merge candidates are judged, executed, and recorded', async () => {
    const assembled = evidence({ resulting_deployment_effect: 'none' });
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true, message: 'fake_merge_accepted' }));
    const manager = createMergeManager({
      assembleEvidence: async () => ({ evidence: assembled, evidenceDigest: 'c'.repeat(64) }),
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result.status).toBe('executed');
    expect(judge).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(assembled);
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'merged', result: 'fake_merge_accepted' })
    );
  });

  test('production-effect merge candidates are held for John and never executed', async () => {
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      assembleEvidence: async () => ({
        evidence: evidence({ resulting_deployment_effect: 'production' }),
        evidenceDigest: 'd'.repeat(64),
      }),
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'production_effect_held_for_john',
      })
    );
  });

  test('default evidence assembly holds feature branches targeting production for John', async () => {
    const productionTargetRecord: WatchedRunRecord = {
      ...record,
      headBranch: 'archon/thread-x',
      metadata: {
        base_branch: 'main',
        head_sha: 'f'.repeat(40),
        base_sha: '1'.repeat(40),
        changed_files: 'packages/overseer/src/merge-manager.ts',
      },
    };
    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const manager = createMergeManager({
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => productionTargetRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(productionTargetRecord);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'production_effect_held_for_john',
      })
    );
  });

  test('a merge candidate from another repo is not denied for registry scope', async () => {
    const otherRecord = {
      ...record,
      repo: 'bdc-public-site',
      prEvidence: {
        ...record.prEvidence,
        pr: { owner: 'bluedevilcollectibles', repo: 'bdc-public-site', number: 77 },
      },
    };
    const insertOverseerAction = mock(async () => undefined);
    const execute = mock(async () => ({ merged: true, message: 'other_repo_merged' }));
    const manager = createMergeManager({
      assembleEvidence: async () => ({
        evidence: evidence({
          record: otherRecord,
          repository: 'bdc-public-site',
          pr_number: 77,
          resulting_deployment_effect: 'staging',
        }),
        evidenceDigest: 'e'.repeat(64),
      }),
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction,
      findPullRequest: async () => otherRecord.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha,
    });

    const result = await manager(otherRecord);

    expect(result.status).toBe('executed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'merged', result: 'other_repo_merged' })
    );
  });
});
