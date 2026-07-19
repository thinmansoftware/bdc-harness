import { describe, expect, mock, test } from 'bun:test';
import { createGitHubQualifiedMergeAdapter } from '../adapters/github-qualified-merge.ts';
import type { QualifiedMergeAdapterRequestV2 } from '../actions/merge-ready.ts';

const request: QualifiedMergeAdapterRequestV2 = {
  schema_version: 'overseer-qualified-merge-adapter-request-v2',
  permit_id: 'permit-1',
  proposal_id: 'proposal-1',
  execution_id: 'execution-1',
  repository: 'bluedevilcollectibles/bdc-harness',
  target_kind: 'pull_request',
  target_key: 'bluedevilcollectibles/bdc-harness#pull_request:42',
  target_digest: '1'.repeat(64),
  pr_number: 42,
  head_sha: 'a'.repeat(40),
  base_branch: 'dev',
  base_sha: 'b'.repeat(40),
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  policy_digest: '2'.repeat(64),
  verifier_registry_digest: '3'.repeat(64),
  fusion_receipt_digest: '4'.repeat(64),
  fusion_evidence_digest: '5'.repeat(64),
  permit_event_digest: '6'.repeat(64),
  reservation_event_digest: '7'.repeat(64),
};

describe('GitHub qualified merge adapter', () => {
  test('dispatches pulls.merge with the exact qualified head SHA', async () => {
    const merge = mock(async () => ({ data: { merged: true, sha: request.head_sha } }));
    const result = await createGitHubQualifiedMergeAdapter({ pulls: { merge } }).attemptMerge(
      request
    );
    expect(merge).toHaveBeenCalledWith({
      owner: 'bluedevilcollectibles',
      repo: 'bdc-harness',
      pull_number: 42,
      sha: request.head_sha,
    });
    expect(result.status).toBe('succeeded');
  });

  test('treats 409 and 422 as definitive no-effect failures', async () => {
    for (const status of [409, 422]) {
      const adapter = createGitHubQualifiedMergeAdapter({
        pulls: { merge: async () => Promise.reject({ status }) },
      });
      await expect(adapter.attemptMerge(request)).resolves.toMatchObject({
        status: 'failed',
        reason: `github_merge_rejected_${status}`,
      });
    }
  });

  test('treats transport failure after dispatch as indeterminate', async () => {
    const adapter = createGitHubQualifiedMergeAdapter({
      pulls: { merge: async () => Promise.reject(new Error('socket closed')) },
    });
    await expect(adapter.attemptMerge(request)).resolves.toMatchObject({
      status: 'indeterminate',
      reason: 'github_merge_transport_ambiguous',
    });
  });
});
