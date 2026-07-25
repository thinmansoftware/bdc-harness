import { describe, expect, mock, test } from 'bun:test';
import {
  M42_SLICE8B_MANIFEST_SCHEMA,
  type M42Slice8BManifestPayload,
} from '../m42-slice8b-manifest';
import { executeM42Slice8BStagingRefireBridge } from '../staging-refire-bridge';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = `sha256:${'2'.repeat(64)}`;

function payload(overrides: Partial<M42Slice8BManifestPayload> = {}): M42Slice8BManifestPayload {
  return {
    schema_version: M42_SLICE8B_MANIFEST_SCHEMA,
    execution_id: 'exec-s8b-staging-refire',
    mode: 'fake',
    candidate_sha: SHA_A,
    starting_sha: SHA_B,
    repository_full_name: 'bluedevilcollectibles/bdc-harness',
    provider_repository_id: 'R_sandbox_123',
    credential_principal_id: 'principal-sandbox-only-1234',
    image_digest: DIGEST,
    fusion_caps_digest: DIGEST,
    verifier_registry_digest: DIGEST,
    action_policy_digest: DIGEST,
    expected_primary_actions: ['REFIRE', 'REFRESH', 'CLOSE', 'MERGE'],
    expected_unexpected_actions: 0,
    max_window_minutes: 60,
    no_production_effect: true,
    declared_rollback_state_digest: DIGEST,
    sibling_merge_ancestor_shas: {
      'S8B-SANDBOX-GH-ADAPTERS-01': SHA_A,
      'S8B-CAULDRON-REFIRE-BRIDGE-01': SHA_B,
      'S8B-FUSION-BUDGET-RECEIPTS-01': 'c'.repeat(40),
    },
    issued_at: '2026-07-17T12:00:00.000Z',
    expires_at: '2026-07-17T13:00:00.000Z',
    ...overrides,
  };
}

describe('M-42 Slice 8B staging refire bridge', () => {
  test('admits the registered staging workload with repository-bound evidence', async () => {
    const requests: unknown[] = [];
    const receipt = await executeM42Slice8BStagingRefireBridge(payload(), 'exec-refire-1', {
      admitRun: mock(async request => {
        requests.push(request);
        return {
          status: 'admitted',
          runId: 'staging-refire-run-1',
          providerRequestId: 'staging-refire-run-1',
          admittedAt: '2026-07-17T12:02:00.000Z',
          bindingEvidence: request.inputs,
          reason: 'accepted',
        };
      }),
    });

    expect(receipt.normalized_outcome).toBe('admitted');
    expect(receipt.side_effect_count).toBe(1);
    expect(receipt.admitted_run_id).toBe('staging-refire-run-1');
    expect(receipt.binding_evidence?.repository).toBe('bluedevilcollectibles/bdc-harness');
    expect(receipt.binding_evidence?.execution_id).toBe('exec-refire-1');
    expect(requests).toHaveLength(1);
  });

  test('rejects non-staging target descriptors before admission', async () => {
    const admitRun = mock(async request => ({
      status: 'admitted' as const,
      runId: 'should-not-run',
      providerRequestId: 'should-not-run',
      admittedAt: '2026-07-17T12:02:00.000Z',
      bindingEvidence: request.inputs,
      reason: 'accepted',
    }));
    const receipt = await executeM42Slice8BStagingRefireBridge(payload(), 'exec-refire-2', {
      admitRun,
      target: {
        environment: 'production',
        archon: 'production',
        event_store: 'production',
        worktree: 'production',
        credential: 'production',
      },
    });

    expect(receipt.normalized_outcome).toBe('rejected');
    expect(receipt.reason).toBe('non_staging_target');
    expect(admitRun).toHaveBeenCalledTimes(0);
  });

  test('turns admission uncertainty into reconciliation instead of a second blind run', async () => {
    const committed: unknown[] = [];
    const receipt = await executeM42Slice8BStagingRefireBridge(payload(), 'exec-refire-3', {
      admitRun: mock(async request => ({
        status: 'timeout',
        runId: null,
        providerRequestId: 'request-refire-3',
        admittedAt: null,
        bindingEvidence: request.inputs,
        reason: 'timeout',
      })),
      idempotency: {
        commit: mock(async (_executionId, saved) => {
          committed.push(saved);
        }),
      },
    });

    expect(receipt.normalized_outcome).toBe('reconciliation_required');
    expect(receipt.reason).toBe('admission_timeout');
    expect(receipt.circuit_breaker_opened).toBe(true);
    expect(committed).toHaveLength(1);
  });
});
