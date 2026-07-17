import { describe, expect, test } from 'bun:test';
import {
  assertNoLooseTargetOverrides,
  M42_SLICE8B_MANIFEST_SCHEMA,
  sha256IntegrityDigest,
  verifyM42Slice8BManifest,
  type M42Slice8BManifestEnvelope,
  type M42Slice8BManifestPayload,
} from '../m42-slice8b-manifest';
import { enforceM42Slice8BGate1 } from '../m42-slice8b-gate1';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;

function payload(overrides: Partial<M42Slice8BManifestPayload> = {}): M42Slice8BManifestPayload {
  return {
    schema_version: M42_SLICE8B_MANIFEST_SCHEMA,
    execution_id: 'exec-s8b-1',
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

function envelope(payloadValue = payload()): M42Slice8BManifestEnvelope {
  return { payload: payloadValue, payload_sha256: sha256IntegrityDigest(payloadValue) };
}

function expected() {
  return {
    candidate_sha: SHA_A,
    starting_sha: SHA_B,
    repository_full_name: 'bluedevilcollectibles/bdc-harness',
    provider_repository_id: 'R_sandbox_123',
  };
}

describe('M-42 Slice 8B manifest v2 integrity gate', () => {
  test('accepts an integrity-checked frozen manifest with four exact primary actions', () => {
    const verified = verifyM42Slice8BManifest(envelope(), expected());
    expect(verified.ok).toBe(true);
    if (verified.ok)
      expect(verified.manifest.expected_primary_actions).toEqual([
        'REFIRE',
        'REFRESH',
        'CLOSE',
        'MERGE',
      ]);
  });

  test('tampered manifest digest is refused before any action', () => {
    const base = envelope();
    const tampered: M42Slice8BManifestEnvelope = {
      ...base,
      payload: { ...base.payload, candidate_sha: 'd'.repeat(40) },
    };
    expect(verifyM42Slice8BManifest(tampered, expected())).toEqual({
      ok: false,
      reason: 'manifest_digest_mismatch',
    });
  });

  test('CLI target override attempt is refused', () => {
    expect(() => assertNoLooseTargetOverrides(['--manifest', 'fixture.json'])).not.toThrow();
    expect(() =>
      assertNoLooseTargetOverrides(['--manifest', 'fixture.json', '--repository=x'])
    ).toThrow('loose_target_override_refused:--repository');
  });

  test('sandbox mode is machine-refused absent a Gate-2 authorization artifact', () => {
    expect(enforceM42Slice8BGate1(payload({ mode: 'sandbox' }))).toEqual({
      ok: false,
      reason: 'gate2_authorization_artifact_missing',
    });
  });

  test('sandbox Gate-2 artifact must bind the frozen manifest values, not mode alone', () => {
    const manifest = payload({
      mode: 'sandbox',
      gate2_authorization_artifact: {
        artifact_id: 'artifact-1',
        carried_motion_id: 'M-66-sandbox-proof',
        candidate_sha: SHA_A,
        image_digest: DIGEST,
        repository_full_name: 'bluedevilcollectibles/bdc-harness',
        provider_repository_id: 'R_sandbox_123',
        credential_principal_id: 'other-principal',
        action_policy_digest: DIGEST,
        verifier_registry_digest: DIGEST,
        fusion_caps_digest: DIGEST,
        expires_at: '2026-07-17T14:00:00.000Z',
      },
    });
    expect(
      enforceM42Slice8BGate1(manifest, {
        nowMs: () => Date.parse('2026-07-17T13:00:00.000Z'),
      })
    ).toEqual({
      ok: false,
      reason: 'gate2_authorization_artifact_binding_mismatch',
    });
  });

  test('sandbox Gate-2 artifact must bind image and Fusion cap digests', () => {
    const artifact = {
      artifact_id: 'artifact-1',
      carried_motion_id: 'M-66-sandbox-proof',
      candidate_sha: SHA_A,
      image_digest: DIGEST,
      repository_full_name: 'bluedevilcollectibles/bdc-harness',
      provider_repository_id: 'R_sandbox_123',
      credential_principal_id: 'principal-sandbox-only-1234',
      action_policy_digest: DIGEST,
      verifier_registry_digest: DIGEST,
      fusion_caps_digest: DIGEST,
      expires_at: '2026-07-17T14:00:00.000Z',
    };
    const nowMs = () => Date.parse('2026-07-17T13:00:00.000Z');
    expect(
      enforceM42Slice8BGate1(
        payload({
          mode: 'sandbox',
          gate2_authorization_artifact: {
            ...artifact,
            image_digest: `sha256:${'4'.repeat(64)}`,
          },
        }),
        { nowMs }
      )
    ).toEqual({ ok: false, reason: 'gate2_authorization_artifact_binding_mismatch' });
    expect(
      enforceM42Slice8BGate1(
        payload({
          mode: 'sandbox',
          gate2_authorization_artifact: {
            ...artifact,
            fusion_caps_digest: `sha256:${'5'.repeat(64)}`,
          },
        }),
        { nowMs }
      )
    ).toEqual({ ok: false, reason: 'gate2_authorization_artifact_binding_mismatch' });
  });

  test('sandbox Gate-2 artifact expires against the runner clock', () => {
    const manifest = payload({
      mode: 'sandbox',
      gate2_authorization_artifact: {
        artifact_id: 'artifact-1',
        carried_motion_id: 'M-66-sandbox-proof',
        candidate_sha: SHA_A,
        image_digest: DIGEST,
        repository_full_name: 'bluedevilcollectibles/bdc-harness',
        provider_repository_id: 'R_sandbox_123',
        credential_principal_id: 'principal-sandbox-only-1234',
        action_policy_digest: DIGEST,
        verifier_registry_digest: DIGEST,
        fusion_caps_digest: DIGEST,
        expires_at: '2026-07-17T14:00:00.000Z',
      },
    });
    expect(
      enforceM42Slice8BGate1(manifest, {
        nowMs: () => Date.parse('2026-07-17T14:00:00.000Z'),
      })
    ).toEqual({ ok: false, reason: 'gate2_authorization_artifact_expired' });
  });
});
