/**
 * Merge provenance + deployment-effect precedence.
 *
 * Both guards exist because agent-written run metadata was previously trusted:
 *   - any PR the judge approved was merged, with no binding to the run that made it
 *   - `environment: dev` in metadata could downgrade a main-targeting merge and skip
 *     John's production hold
 */

import { describe, expect, mock, test } from 'bun:test';
import { createMergeManager } from '../merge-manager.ts';
import { verifyMergeProvenance } from '../merge-provenance.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type { GrokDispositionReceipt, WatchedRunRecord } from '../types.ts';

const RUN_HEAD_SHA = 'a'.repeat(40);
const FOREIGN_HEAD_SHA = '9'.repeat(40);

function makeRecord(overrides: Partial<WatchedRunRecord> = {}): WatchedRunRecord {
  return {
    runId: 'run-provenance-1',
    woId: 'WO-PROVENANCE-01',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'failed',
    action: 'merge_ready',
    reason: 'green PR',
    errorClass: 'tail_node_false_fail',
    workingPath: '/archon/worktrees/run-provenance-1',
    prEvidence: {
      exists: true,
      state: 'open',
      checks: { total: 1, passed: 1, failed: 0, pending: 0 },
      mergeable: true,
      pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
      prTitle: 'Ready to merge',
      filesChangedCount: 1,
      diffStat: '+1 -0',
      headSha: RUN_HEAD_SHA,
    },
    ...overrides,
  };
}

function evidenceFor(
  record: WatchedRunRecord,
  overrides: Partial<QualifiedMergeEvidence> = {}
): QualifiedMergeEvidence {
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
    head_sha: RUN_HEAD_SHA,
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: RUN_HEAD_SHA }],
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

describe('verifyMergeProvenance', () => {
  test('verifies when the PR head is the tip of the run own worktree', async () => {
    const result = await verifyMergeProvenance(makeRecord(), RUN_HEAD_SHA, {
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    expect(result).toMatchObject({ verified: true, reason: 'verified' });
    expect(result.runHeadSha).toBe(RUN_HEAD_SHA);
  });

  test('rejects a PR this run did not produce (substitution)', async () => {
    const result = await verifyMergeProvenance(makeRecord(), FOREIGN_HEAD_SHA, {
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    expect(result).toMatchObject({ verified: false, reason: 'head_sha_mismatch' });
  });

  test('holds when the run carries no engine-written worktree path', async () => {
    const result = await verifyMergeProvenance(
      makeRecord({ workingPath: undefined }),
      RUN_HEAD_SHA,
      { readWorktreeHeadSha: async () => RUN_HEAD_SHA }
    );

    expect(result).toMatchObject({ verified: false, reason: 'working_path_missing' });
  });

  test('holds when the worktree was swept (reader returns null)', async () => {
    const result = await verifyMergeProvenance(makeRecord(), RUN_HEAD_SHA, {
      readWorktreeHeadSha: async () => null,
    });

    expect(result).toMatchObject({ verified: false, reason: 'worktree_unavailable' });
  });

  test('holds when the reader throws rather than propagating', async () => {
    const result = await verifyMergeProvenance(makeRecord(), RUN_HEAD_SHA, {
      readWorktreeHeadSha: async () => {
        throw new Error('git exploded');
      },
    });

    expect(result).toMatchObject({ verified: false, reason: 'worktree_unavailable' });
  });

  test('holds when GitHub reports no PR head SHA', async () => {
    const result = await verifyMergeProvenance(makeRecord(), undefined, {
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    expect(result).toMatchObject({ verified: false, reason: 'pr_head_sha_missing' });
  });

  test('matches an abbreviated SHA against the full worktree SHA', async () => {
    const result = await verifyMergeProvenance(makeRecord(), RUN_HEAD_SHA.slice(0, 12), {
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    expect(result.verified).toBe(true);
  });

  test('rejects a malformed SHA rather than treating it as a match', async () => {
    const result = await verifyMergeProvenance(makeRecord(), 'not-a-sha', {
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    expect(result).toMatchObject({ verified: false, reason: 'pr_head_sha_missing' });
  });
});

describe('merge manager provenance gate', () => {
  test('a PR the run did not produce is never judged and never merged', async () => {
    const record = makeRecord();
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    const manager = createMergeManager({
      // Explicit execute so this test would fail loud if provenance short-circuit broke.
      mode: 'execute',
      assembleEvidence: async () => ({
        evidence: evidenceFor(record),
        evidenceDigest: 'c'.repeat(64),
      }),
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      // The run built a different commit than the PR presents.
      readWorktreeHeadSha: async () => FOREIGN_HEAD_SHA,
    });

    const result = await manager(record);

    expect(result.status).toBe('held');
    expect(result.reason).toBe('provenance_head_sha_mismatch');
    expect(judge).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merge_denied',
        result: 'provenance_head_sha_mismatch',
      })
    );
  });
});

describe('deployment effect precedence', () => {
  test('agent metadata cannot downgrade a main-targeting merge out of John hold', async () => {
    // The exact bypass: metadata claims dev while the PR targets main.
    const record = makeRecord({
      headBranch: 'archon/thread-x',
      metadata: {
        base_branch: 'main',
        environment: 'dev',
        head_sha: RUN_HEAD_SHA,
        base_sha: 'b'.repeat(40),
      },
    });
    const judge = mock(async input => approveReceipt(input));
    const execute = mock(async () => ({ merged: true }));
    const insertOverseerAction = mock(async () => undefined);

    const manager = createMergeManager({
      judge,
      execute,
      insertOverseerAction,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    const result = await manager(record);

    expect(result).toMatchObject({
      status: 'held',
      reason: 'production_effect_held_for_john',
      execution: null,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('metadata may still escalate a dev-targeting merge to production', async () => {
    const record = makeRecord({
      headBranch: 'archon/thread-y',
      metadata: {
        base_branch: 'dev',
        environment: 'production',
        head_sha: RUN_HEAD_SHA,
        base_sha: 'b'.repeat(40),
      },
    });
    const execute = mock(async () => ({ merged: true }));

    const manager = createMergeManager({
      judge: async input => approveReceipt(input),
      execute,
      insertOverseerAction: async () => undefined,
      findPullRequest: async () => record.prEvidence,
      mergePullRequest: async () => ({ merged: false }),
      readWorktreeHeadSha: async () => RUN_HEAD_SHA,
    });

    const result = await manager(record);

    expect(result).toMatchObject({ reason: 'production_effect_held_for_john' });
    expect(execute).not.toHaveBeenCalled();
  });
});
