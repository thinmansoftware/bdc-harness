import { createHash } from 'node:crypto';

export const M42_SLICE8B_MANIFEST_SCHEMA = 'm42-slice8b-frozen-manifest-v2';

export const M42_SLICE8B_REQUIRED_SIBLING_WOS = [
  'S8B-SANDBOX-GH-ADAPTERS-01',
  'S8B-CAULDRON-REFIRE-BRIDGE-01',
  'S8B-FUSION-BUDGET-RECEIPTS-01',
] as const;

export const M42_SLICE8B_PRIMARY_ACTIONS = ['REFIRE', 'REFRESH', 'CLOSE', 'MERGE'] as const;

export type M42Slice8BPrimaryAction = (typeof M42_SLICE8B_PRIMARY_ACTIONS)[number];
export type M42Slice8BExecutionMode = 'fake' | 'sandbox';

export interface M42Slice8BGate2AuthorizationArtifact {
  readonly artifact_id: string;
  readonly carried_motion_id: string;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly repository_full_name: string;
  readonly provider_repository_id: string;
  readonly credential_principal_id: string;
  readonly action_policy_digest: string;
  readonly verifier_registry_digest: string;
  readonly fusion_caps_digest: string;
  readonly expires_at: string;
}

export interface M42Slice8BManifestPayload {
  readonly schema_version: typeof M42_SLICE8B_MANIFEST_SCHEMA;
  readonly execution_id: string;
  readonly mode: M42Slice8BExecutionMode;
  readonly candidate_sha: string;
  readonly starting_sha: string;
  readonly repository_full_name: string;
  readonly provider_repository_id: string;
  readonly credential_principal_id: string;
  readonly verifier_registry_digest: string;
  readonly action_policy_digest: string;
  readonly expected_primary_actions: readonly M42Slice8BPrimaryAction[];
  readonly expected_unexpected_actions: 0;
  readonly max_window_minutes: 60;
  readonly no_production_effect: true;
  readonly declared_rollback_state_digest: string;
  readonly sibling_merge_ancestor_shas: Readonly<
    Record<(typeof M42_SLICE8B_REQUIRED_SIBLING_WOS)[number], string>
  >;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly gate2_authorization_artifact?: M42Slice8BGate2AuthorizationArtifact;
}

export interface M42Slice8BManifestEnvelope {
  readonly payload: M42Slice8BManifestPayload;
  readonly payload_sha256: string;
  readonly signature?: {
    readonly algorithm: string;
    readonly key_id: string;
    readonly value: string;
  };
}

export type M42Slice8BManifestVerificationResult =
  | { readonly ok: true; readonly manifest: M42Slice8BManifestPayload; readonly digest: string }
  | { readonly ok: false; readonly reason: string };

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function sha256IntegrityDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function verifyM42Slice8BManifest(
  envelope: M42Slice8BManifestEnvelope,
  expected: {
    readonly candidate_sha: string;
    readonly starting_sha: string;
    readonly repository_full_name: string;
    readonly provider_repository_id: string;
  }
): M42Slice8BManifestVerificationResult {
  const digest = sha256IntegrityDigest(envelope.payload);
  if (digest !== envelope.payload_sha256) return { ok: false, reason: 'manifest_digest_mismatch' };

  const manifest = envelope.payload;
  if (manifest.schema_version !== M42_SLICE8B_MANIFEST_SCHEMA) {
    return { ok: false, reason: 'schema_version_mismatch' };
  }
  if (manifest.mode !== 'fake' && manifest.mode !== 'sandbox') {
    return { ok: false, reason: 'execution_mode_mismatch' };
  }
  if (manifest.candidate_sha !== expected.candidate_sha) {
    return { ok: false, reason: 'candidate_sha_mismatch' };
  }
  if (manifest.starting_sha !== expected.starting_sha) {
    return { ok: false, reason: 'starting_sha_mismatch' };
  }
  if (
    manifest.repository_full_name !== expected.repository_full_name ||
    manifest.provider_repository_id !== expected.provider_repository_id
  ) {
    return { ok: false, reason: 'repository_identity_mismatch' };
  }
  if (!SHA1_RE.test(manifest.candidate_sha) || !SHA1_RE.test(manifest.starting_sha)) {
    return { ok: false, reason: 'invalid_sha' };
  }
  if (
    !SHA256_RE.test(manifest.verifier_registry_digest) ||
    !SHA256_RE.test(manifest.action_policy_digest) ||
    !SHA256_RE.test(manifest.declared_rollback_state_digest)
  ) {
    return { ok: false, reason: 'invalid_digest' };
  }
  if (manifest.credential_principal_id.length === 0) {
    return { ok: false, reason: 'credential_principal_missing' };
  }
  if (
    manifest.expected_primary_actions.length !== M42_SLICE8B_PRIMARY_ACTIONS.length ||
    !M42_SLICE8B_PRIMARY_ACTIONS.every(
      (action, index) => manifest.expected_primary_actions[index] === action
    )
  ) {
    return { ok: false, reason: 'primary_action_set_mismatch' };
  }
  if (manifest.expected_unexpected_actions !== 0) {
    return { ok: false, reason: 'unexpected_actions_not_zero' };
  }
  if (manifest.max_window_minutes !== 60) {
    return { ok: false, reason: 'window_limit_mismatch' };
  }
  if (manifest.no_production_effect !== true) {
    return { ok: false, reason: 'production_effect_not_refused' };
  }
  for (const sibling of M42_SLICE8B_REQUIRED_SIBLING_WOS) {
    if (!SHA1_RE.test(manifest.sibling_merge_ancestor_shas[sibling] ?? '')) {
      return { ok: false, reason: `missing_sibling_merge_ancestor:${sibling}` };
    }
  }
  if (Date.parse(manifest.expires_at) <= Date.parse(manifest.issued_at)) {
    return { ok: false, reason: 'manifest_expiry_invalid' };
  }
  return { ok: true, manifest, digest };
}

export function assertNoLooseTargetOverrides(argv: readonly string[]): void {
  const allowed = new Set(['--manifest']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!allowed.has(key)) throw new Error(`loose_target_override_refused:${key}`);
    if (key === '--manifest' && !arg.includes('=')) index += 1;
  }
}
