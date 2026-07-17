import {
  OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION,
  computeVerifierRegistryDigest,
  registerVerifierRegistry,
  type OverseerVerifierEntryInput,
  type OverseerVerifierRegistry,
} from '@archon/core/db/overseer-control-plane';
import type { FusionComponentModelV1 } from './types.js';
import { sha256Digest } from './receipts.js';

export interface FusionVerifierRegistryFixture {
  schema_version: typeof OVERSEER_VERIFIER_REGISTRY_SCHEMA_VERSION;
  source_artifact_path: string;
  source_git_blob: string;
  entries: OverseerVerifierEntryInput[];
  m28_blind_calibration: {
    artifact: string;
    expected_digest: string;
  };
}

export function fusionVerifierRegistryDigest(
  entries: readonly OverseerVerifierEntryInput[]
): string {
  return computeVerifierRegistryDigest(entries);
}

export async function registerFrozenFusionVerifierRegistry(
  fixture: FusionVerifierRegistryFixture
): Promise<OverseerVerifierRegistry> {
  const registryDigest = fusionVerifierRegistryDigest(fixture.entries);
  const result = await registerVerifierRegistry({
    schema_version: fixture.schema_version,
    registry_digest: registryDigest,
    entries: fixture.entries,
    source_artifact_path: fixture.source_artifact_path,
    source_git_blob: fixture.source_git_blob,
  });
  if (!result.ok) throw new Error(`fusion_registry_registration_failed:${result.code}`);
  return result.value;
}

export function validateFusionComponentModels(
  registry: OverseerVerifierRegistry,
  componentModels: readonly FusionComponentModelV1[]
): boolean {
  if (componentModels.length === 0) return false;
  return componentModels.every(component =>
    registry.entries.some(
      entry =>
        entry.enabled &&
        entry.verifier_id === component.verifier_id &&
        entry.provider === component.provider &&
        entry.model_family === component.model_family &&
        entry.roles.includes('FUSION')
    )
  );
}

export function runM28BlindCalibration(fixture: FusionVerifierRegistryFixture): {
  ok: boolean;
  artifact_digest: string;
} {
  const registryDigest = fusionVerifierRegistryDigest(fixture.entries);
  const artifactDigest = sha256Digest(
    JSON.stringify({
      artifact: fixture.m28_blind_calibration.artifact,
      registry_digest: registryDigest,
    })
  );
  return {
    ok: artifactDigest === fixture.m28_blind_calibration.expected_digest,
    artifact_digest: artifactDigest,
  };
}
