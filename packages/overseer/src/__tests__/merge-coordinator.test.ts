import { describe, expect, mock, test } from 'bun:test';
import { assembleQualifiedMergeEvidence, coordinateMergeReady } from '../merge-coordinator.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type { GrokDispositionReceipt, WatchedRunRecord } from '../types.ts';

const record: WatchedRunRecord = {
  runId: 'run-1',
  woId: 'WO-REAL-01',
  owner: 'bluedevilcollectibles',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
  },
};

describe('merge coordinator', () => {
  function exactEvidence(): QualifiedMergeEvidence {
    return {
      record,
      pr_number: 42,
      head_sha: 'a'.repeat(40),
      base_sha: 'b'.repeat(40),
      changed_files: [],
      operator: { identity: 'grok-overseer', provider: 'xai', model_family: 'grok' },
    } as QualifiedMergeEvidence;
  }

  test('assembles policy, exact PR, review, manifest v2, M31, Fusion, and final state evidence', async () => {
    const calls: string[] = [];
    const assembled = await assembleQualifiedMergeEvidence(record, {
      operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
      readPolicy: async () => {
        calls.push('policy');
        return {
          registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
          credentialPrincipal: 'grok-overseer',
          resultingDeploymentEffect: 'none',
        };
      },
      readPullRequest: async () => {
        calls.push('pr');
        return {
          owner: 'bluedevilcollectibles',
          repository: 'bdc-harness',
          baseBranch: 'dev',
          changedFiles: ['src/index.ts'],
          prNumber: 42,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          prEvidence: {
            exists: true,
            state: 'open',
            checks: { total: 1, passed: 0, failed: 1, pending: 0 },
            mergeable: false,
            pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
            prTitle: 'Exact live PR',
            filesChangedCount: 1,
            diffStat: '+1 -0',
          },
          requiredChecks: [{ name: 'ci', conclusion: 'success', head_sha: 'a'.repeat(40) }],
          reviews: [{ resolved: true }],
        };
      },
      readIndependentReview: async () => {
        calls.push('review');
        return null;
      },
      readManifestV2: async () => {
        calls.push('manifest');
        return { valid: true };
      },
      readM31Proposal: async () => {
        calls.push('m31');
        return {
          proposalId: 'proposal-1',
          present: true,
          verifierRegistryDigest: 'c'.repeat(64),
        };
      },
      readFusionEvidence: async () => {
        calls.push('fusion');
        return null;
      },
      compareFinalState: async () => {
        calls.push('final');
        return true;
      },
    });
    expect(new Set(calls)).toEqual(
      new Set(['policy', 'pr', 'review', 'manifest', 'm31', 'fusion', 'final'])
    );
    expect(assembled.evidence).toMatchObject({
      proposal_id: 'proposal-1',
      manifest: { valid: true },
      final_state_consistent: true,
      operator: { provider: 'xai', model_family: 'grok' },
      record: { prEvidence: { mergeable: false, prTitle: 'Exact live PR' } },
    });
    expect(assembled.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('an approval receipt still delegates through handleMergeReady gates', async () => {
    const evidence = exactEvidence();
    const handleMergeReady = mock(async () => ({ merged: false, action: 'denied' }) as never);
    const approve: GrokDispositionReceipt = {
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'approve',
      reason: 'judge_approve',
      woId: record.woId,
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      evidenceDigest: 'c'.repeat(64),
      operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
    };
    const result = await coordinateMergeReady(record, {
      assembleEvidence: async () => ({ evidence, evidenceDigest: approve.evidenceDigest }),
      assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'proposal-1' }),
      judge: async () => approve,
      handleMergeReady,
      executionDeps: {} as never,
      insertOverseerAction: async () => undefined,
    });
    expect(result.status).toBe('executed');
    expect(handleMergeReady).toHaveBeenCalledTimes(1);
    expect(handleMergeReady).toHaveBeenCalledWith(evidence, expect.anything());
  });

  test('HOLD fails closed without invoking the merge executor', async () => {
    const evidence = exactEvidence();
    const handleMergeReady = mock(async () => ({}) as never);
    const hold: GrokDispositionReceipt = {
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'hold',
      reason: 'judge_timeout',
      woId: record.woId,
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      evidenceDigest: 'c'.repeat(64),
      operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
    };
    const result = await coordinateMergeReady(record, {
      assembleEvidence: async () => ({ evidence, evidenceDigest: hold.evidenceDigest }),
      assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'proposal-1' }),
      judge: async () => hold,
      handleMergeReady,
      executionDeps: {} as never,
      insertOverseerAction: async () => undefined,
    });
    expect(result).toMatchObject({ status: 'held', receipt: hold });
    expect(handleMergeReady).not.toHaveBeenCalled();
  });

  test('receipt identity drift fails closed before the merge executor', async () => {
    const evidence = exactEvidence();
    const handleMergeReady = mock(async () => ({}) as never);
    const result = await coordinateMergeReady(record, {
      assembleEvidence: async () => ({ evidence, evidenceDigest: 'c'.repeat(64) }),
      assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'proposal-1' }),
      judge: async () => ({
        schemaVersion: 'overseer-grok-merge-disposition-v1',
        disposition: 'approve',
        reason: 'judge_approve',
        woId: 'WO-WRONG',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        evidenceDigest: 'c'.repeat(64),
        operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
      }),
      handleMergeReady,
      executionDeps: {} as never,
      insertOverseerAction: async () => undefined,
    });
    expect(result.status).toBe('held');
    expect(handleMergeReady).not.toHaveBeenCalled();
  });

  test('an inconsistent APPROVE reason fails closed before the merge executor', async () => {
    const evidence = exactEvidence();
    const handleMergeReady = mock(async () => ({}) as never);
    const result = await coordinateMergeReady(record, {
      assembleEvidence: async () => ({ evidence, evidenceDigest: 'c'.repeat(64) }),
      assess: () => ({ eligible: true, entry: {} as never, proposal_id: 'proposal-1' }),
      judge: async () => ({
        schemaVersion: 'overseer-grok-merge-disposition-v1',
        disposition: 'approve',
        reason: 'judge_hold',
        woId: record.woId,
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        evidenceDigest: 'c'.repeat(64),
        operator: { identity: 'grok-overseer', provider: 'xai', modelFamily: 'grok' },
      }),
      handleMergeReady,
      executionDeps: {} as never,
      insertOverseerAction: async () => undefined,
    });
    expect(result.status).toBe('held');
    expect(handleMergeReady).not.toHaveBeenCalled();
  });

  test('deterministic denial recuses Grok and delegates only to the gated executor', async () => {
    const evidence = exactEvidence();
    const judge = mock(async () => {
      throw new Error('Grok must not be called');
    });
    const handleMergeReady = mock(async () => ({ merged: false, action: 'denied' }) as never);
    const result = await coordinateMergeReady(record, {
      assembleEvidence: async () => ({ evidence, evidenceDigest: 'c'.repeat(64) }),
      assess: () => ({
        eligible: false,
        stage: 'operator_recusal',
        reason: 'operator_builder_correlated',
        disposition: 'deny',
      }),
      judge,
      handleMergeReady,
      executionDeps: {} as never,
      insertOverseerAction: async () => undefined,
    });
    expect(result.status).toBe('gated');
    expect(judge).not.toHaveBeenCalled();
    expect(handleMergeReady).toHaveBeenCalledTimes(1);
  });
});
