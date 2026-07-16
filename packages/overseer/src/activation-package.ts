/**
 * M-42 Slice 8 unsigned activation/sandbox request packets and
 * governance-isolated artifact writer.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

export interface ActivationPackageInput {
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly capabilities: Readonly<{
    escalation: boolean;
    repair: boolean;
    branch: boolean;
    lifecycle: boolean;
    merge: boolean;
  }>;
  readonly emergency_stop: boolean;
  readonly allowlists: Readonly<{
    repositories: readonly string[];
    adapters: readonly string[];
  }>;
  readonly rollback: Readonly<{
    prior_staging_sha: string;
    evidence_retained: boolean;
  }>;
  readonly health: Readonly<{
    watcher_count: number;
    adapter_mode: string;
  }>;
  readonly numerical_caps: Readonly<{
    max_factory_commitments: number;
    max_fusion_usd: number;
  }>;
  readonly verifier_registry_digest: string;
  readonly missing_gate2_approvals: readonly string[];
  readonly missing_gate3_approvals: readonly string[];
  readonly operator_notice: string;
}

export interface UnsignedSandboxProofRequest {
  readonly schema_version: 'm42-sandbox-proof-request-v1';
  readonly signed: false;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly requires_dedicated_sandbox: true;
  readonly verifier_registry_digest: string;
  readonly numerical_caps: ActivationPackageInput['numerical_caps'];
  readonly rollback: ActivationPackageInput['rollback'];
  readonly zero_production_effect: true;
  readonly missing_gate2_approvals: readonly string[];
  readonly capabilities_remain_disabled: true;
  readonly emergency_stop: true;
}

export interface UnsignedActivationRequest {
  readonly schema_version: 'm42-deploy-activation-request-v1';
  readonly signed: false;
  readonly candidate_sha: string;
  readonly image_digest: string;
  readonly capabilities: ActivationPackageInput['capabilities'];
  readonly allowlists: ActivationPackageInput['allowlists'];
  readonly backup_and_rollback: ActivationPackageInput['rollback'];
  readonly health: ActivationPackageInput['health'];
  readonly operator_notice: string;
  readonly missing_gate3_approvals: readonly string[];
  readonly emergency_stop: boolean;
}

export interface ActivationArtifactBundle {
  readonly sandbox_proof_request: UnsignedSandboxProofRequest;
  readonly deploy_activation_request: UnsignedActivationRequest;
}

export interface WrittenActivationArtifacts {
  readonly sandbox_proof_request_path: string;
  readonly deploy_activation_request_path: string;
  readonly sandbox_proof_request_sha256: string;
  readonly deploy_activation_request_sha256: string;
}

/** Stable JSON stringify with sorted object keys (RFC 8785-lite). */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function buildUnsignedSandboxProofRequest(
  input: ActivationPackageInput
): UnsignedSandboxProofRequest {
  return {
    schema_version: 'm42-sandbox-proof-request-v1',
    signed: false,
    candidate_sha: input.candidate_sha,
    image_digest: input.image_digest,
    requires_dedicated_sandbox: true,
    verifier_registry_digest: input.verifier_registry_digest,
    numerical_caps: { ...input.numerical_caps },
    rollback: { ...input.rollback },
    zero_production_effect: true,
    missing_gate2_approvals: [...input.missing_gate2_approvals],
    capabilities_remain_disabled: true,
    emergency_stop: true,
  };
}

export function buildUnsignedActivationRequest(
  input: ActivationPackageInput
): UnsignedActivationRequest {
  return {
    schema_version: 'm42-deploy-activation-request-v1',
    signed: false,
    candidate_sha: input.candidate_sha,
    image_digest: input.image_digest,
    capabilities: { ...input.capabilities },
    allowlists: {
      repositories: [...input.allowlists.repositories],
      adapters: [...input.allowlists.adapters],
    },
    backup_and_rollback: { ...input.rollback },
    health: { ...input.health },
    operator_notice: input.operator_notice,
    missing_gate3_approvals: [...input.missing_gate3_approvals],
    emergency_stop: input.emergency_stop,
  };
}

const FORBIDDEN_PATH_MARKERS = [
  `${sep}docs${sep}board`,
  `${sep}.github`,
  `${sep}packages${sep}`,
  `${sep}migrations${sep}`,
  `${sep}scripts${sep}`,
  `${sep}src${sep}`,
];

function assertNonGovernanceOutputDirectory(outputDirectory: string): string {
  const resolved = resolve(outputDirectory);
  const normalized = normalize(resolved).toLowerCase();
  const repoRoot = resolve(process.cwd()).toLowerCase();

  for (const marker of FORBIDDEN_PATH_MARKERS) {
    if (normalized.includes(marker.toLowerCase())) {
      throw new Error(
        `activation_artifact_path_rejected: path under forbidden governance/source tree (${marker})`
      );
    }
  }

  // Reject direct writes into the repository source tree root children.
  if (normalized.startsWith(repoRoot + sep) || normalized === repoRoot) {
    const rel = normalized.slice(repoRoot.length).replace(/^[/\\]/, '');
    const first = rel.split(/[/\\]/)[0] ?? '';
    const forbiddenRoots = new Set([
      'docs',
      '.github',
      'packages',
      'migrations',
      'scripts',
      'src',
      'deploy',
      'config',
      'harness',
    ]);
    if (forbiddenRoots.has(first)) {
      throw new Error(
        `activation_artifact_path_rejected: refuses repository source tree path '${first}'`
      );
    }
  }

  if (!isAbsolute(resolved) && !outputDirectory.includes('artifacts')) {
    // relative paths under artifacts/ are allowed when resolved under cwd
  }

  // Explicit allow for artifacts/overseer paths under the repo (staging proof output).
  if (normalized.startsWith(repoRoot + sep)) {
    const rel = normalized.slice(repoRoot.length).replace(/^[/\\]/, '');
    if (!rel.startsWith('artifacts') && !rel.includes(`${sep}tmp`) && !rel.includes('staging-')) {
      // Allow tmp-style and artifacts only under repo
      if (!rel.startsWith('staging-data') && !rel.startsWith('staging-m42')) {
        // still reject unknown repo-relative roots
        const first = rel.split(/[/\\]/)[0] ?? '';
        if (
          first &&
          first !== 'artifacts' &&
          first !== 'staging-data' &&
          first !== 'staging-m42-data'
        ) {
          throw new Error(
            `activation_artifact_path_rejected: refuses non-artifact repo path '${first}'`
          );
        }
      }
    }
  }

  return resolved;
}

/**
 * Write unsigned canonical JSON packets plus SHA-256 digests to a
 * caller-supplied directory. Rejects docs/board, .github, and source trees.
 */
export function writeNonGovernanceActivationArtifacts(
  input: ActivationArtifactBundle,
  outputDirectory: string
): WrittenActivationArtifacts {
  const dir = assertNonGovernanceOutputDirectory(outputDirectory);
  mkdirSync(dir, { recursive: true });

  const sandboxBody = canonicalJsonStringify(input.sandbox_proof_request);
  const deployBody = canonicalJsonStringify(input.deploy_activation_request);
  const sandboxPath = join(dir, 'sandbox-proof-request.json');
  const deployPath = join(dir, 'deploy-activation-request.json');

  writeFileSync(sandboxPath, sandboxBody + '\n', 'utf8');
  writeFileSync(deployPath, deployBody + '\n', 'utf8');

  return {
    sandbox_proof_request_path: sandboxPath,
    deploy_activation_request_path: deployPath,
    sandbox_proof_request_sha256: createHash('sha256').update(sandboxBody).digest('hex'),
    deploy_activation_request_sha256: createHash('sha256').update(deployBody).digest('hex'),
  };
}
