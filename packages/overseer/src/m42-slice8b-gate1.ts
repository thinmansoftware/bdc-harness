import type {
  M42Slice8BGate2AuthorizationArtifact,
  M42Slice8BManifestPayload,
} from './m42-slice8b-manifest';

export type M42Slice8BGate1Result =
  | { readonly ok: true; readonly artifact: M42Slice8BGate2AuthorizationArtifact | null }
  | { readonly ok: false; readonly reason: string };

export function enforceM42Slice8BGate1(manifest: M42Slice8BManifestPayload): M42Slice8BGate1Result {
  if (manifest.mode === 'fake') return { ok: true, artifact: null };

  const artifact = manifest.gate2_authorization_artifact;
  if (!artifact) return { ok: false, reason: 'gate2_authorization_artifact_missing' };
  if (
    artifact.candidate_sha !== manifest.candidate_sha ||
    artifact.repository_full_name !== manifest.repository_full_name ||
    artifact.provider_repository_id !== manifest.provider_repository_id ||
    artifact.credential_principal_id !== manifest.credential_principal_id ||
    artifact.action_policy_digest !== manifest.action_policy_digest ||
    artifact.verifier_registry_digest !== manifest.verifier_registry_digest
  ) {
    return { ok: false, reason: 'gate2_authorization_artifact_binding_mismatch' };
  }
  if (Date.parse(artifact.expires_at) <= Date.parse(manifest.issued_at)) {
    return { ok: false, reason: 'gate2_authorization_artifact_expired' };
  }
  if (!artifact.carried_motion_id.startsWith('M-66')) {
    return { ok: false, reason: 'gate2_authorization_artifact_not_m66' };
  }
  return { ok: true, artifact };
}
