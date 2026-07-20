/**
 * Policy-registry identity verifier (M-42 Slice 7).
 *
 * Independently recomputes, from the exact registry file bytes:
 *   1. every entry tuple digest (non-self-referential, domain + JCS + SHA-256),
 *   2. the Git blob OID for the declared object format, and
 *   3. the raw-file SHA-256,
 * then compares each against the manifest evidence object. It prints exactly
 * `POLICY_IDENTITIES=valid` on full agreement and nothing else on success.
 *
 * The Git blob OID and raw-file SHA-256 are file-level identities kept separate
 * from the per-entry tuple digest; none of the three aliases the others.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import {
  computePolicyTupleDigest,
  loadOverseerActionPolicyRegistry,
  POLICY_TUPLE_ALGORITHM,
} from './policy-registry';

const HEX64_RE = /^[0-9a-f]{64}$/;
export type GitObjectFormat = 'sha1' | 'sha256';

/**
 * Tuple digests explicitly authorized to appear in the SHIPPED (production)
 * policy registry. Add an entry here ONLY when a recorded Board motion (or
 * John's direct authorization) approves that exact tuple -- this list is the
 * enforcement point for "the registry may only contain what was authorized."
 *
 * - bluedevilcollectibles/bdc-harness, base dev, MERGE only, staging effect,
 *   credential_principal "overseer-merge-manager-v1". Authorized: John,
 *   2026-07-20 ("put it in place with merge manager"), pilot scope --
 *   staging-effect merge authority on bdc-harness only, as the first real
 *   Overseer merge-capability grant. See M-42 completion-evidence table,
 *   docs/board/motions/M-20260714-42-overseer-operational-merge-steward.md.
 */
export const SHIPPED_POLICY_AUTHORIZED_DIGESTS: ReadonlySet<string> = new Set([
  '34f7ba1e17c3821d46ee834564ac6b8d2f910e32349ab68b9d1a2e42e4179c93',
]);

export interface PolicyIdentityEvidence {
  readonly registry_path: string;
  readonly policy_tuple_algorithm: string;
  readonly policy_tuple_digests: readonly string[];
  readonly git_object_format: GitObjectFormat;
  readonly git_blob_oid: string;
  readonly registry_file_sha256: string;
  readonly proposal_policy_tuple_digest?: string;
  readonly receipt_policy_tuple_digest?: string;
}

export interface VerifyPolicyRegistryIdentitiesInput {
  /** Exact raw registry file bytes. */
  readonly registryBytes: Buffer;
  /** The manifest evidence object (manifest[manifestKey]). */
  readonly evidence: unknown;
  readonly manifestKey: 'shipped_policy_evidence' | 'fake_policy_evidence';
  /** Live-detected Git object format for a cross-check (from `git`, when available). */
  readonly detectedGitObjectFormat?: GitObjectFormat;
}

export interface VerifyResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/** Compute the Git blob OID for the given content and object format. */
export function gitBlobOid(bytes: Buffer, format: GitObjectFormat): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  const algorithm = format === 'sha1' ? 'sha1' : 'sha256';
  return createHash(algorithm)
    .update(Buffer.concat([header, bytes]))
    .digest('hex');
}

function sortedCopy(values: readonly string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function verifyPolicyRegistryIdentities(
  input: VerifyPolicyRegistryIdentitiesInput
): VerifyResult {
  const reasons: string[] = [];
  const evidence = input.evidence as Record<string, unknown> | null;

  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, reasons: ['evidence_not_object'] };
  }

  if (evidence.policy_tuple_algorithm !== POLICY_TUPLE_ALGORITHM) {
    reasons.push('policy_tuple_algorithm_mismatch');
  }
  if (evidence.git_object_format !== 'sha1' && evidence.git_object_format !== 'sha256') {
    return { valid: false, reasons: [...reasons, 'git_object_format_invalid'] };
  }
  const declaredFormat = evidence.git_object_format;
  if (
    input.detectedGitObjectFormat !== undefined &&
    input.detectedGitObjectFormat !== declaredFormat
  ) {
    reasons.push('git_object_format_disagrees_with_repo');
  }

  // Recompute the two file-level identities from the exact bytes.
  const actualFileSha256 = createHash('sha256').update(input.registryBytes).digest('hex');
  if (evidence.registry_file_sha256 !== actualFileSha256) {
    reasons.push('registry_file_sha256_mismatch');
  }
  const actualBlobOid = gitBlobOid(input.registryBytes, declaredFormat);
  if (evidence.git_blob_oid !== actualBlobOid) {
    reasons.push('git_blob_oid_mismatch');
  }

  // Recompute every entry tuple digest independently and compare, sorted.
  let recomputedDigests: string[] = [];
  try {
    const registry = loadOverseerActionPolicyRegistry({
      text: input.registryBytes.toString('utf8'),
    });
    recomputedDigests = sortedCopy(
      registry.entries.map(entry =>
        computePolicyTupleDigest({
          owner: entry.owner,
          repository: entry.repository,
          base_branch: entry.base_branch,
          resulting_deployment_effect: entry.resulting_deployment_effect,
          allowed_action_kinds: entry.allowed_action_kinds,
          credential_principal: entry.credential_principal,
        })
      )
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    return { valid: false, reasons: [...reasons, `registry_load_failed:${reason}`] };
  }

  const manifestDigests = evidence.policy_tuple_digests;
  if (!Array.isArray(manifestDigests) || !manifestDigests.every(d => typeof d === 'string')) {
    reasons.push('policy_tuple_digests_invalid');
  } else {
    const manifestSorted = sortedCopy(manifestDigests);
    if (!arraysEqual(manifestSorted, manifestDigests)) {
      reasons.push('policy_tuple_digests_unsorted');
    }
    if (!arraysEqual(manifestSorted, recomputedDigests)) {
      reasons.push('policy_tuple_digests_mismatch');
    }
    if (manifestDigests.some(d => !HEX64_RE.test(d))) {
      reasons.push('policy_tuple_digest_malformed');
    }
  }

  if (input.manifestKey === 'fake_policy_evidence') {
    if (recomputedDigests.length !== 1) {
      reasons.push('fake_policy_expected_single_tuple');
    } else {
      const sole = recomputedDigests[0];
      if (evidence.proposal_policy_tuple_digest !== sole) {
        reasons.push('proposal_policy_tuple_digest_mismatch');
      }
      if (evidence.receipt_policy_tuple_digest !== sole) {
        reasons.push('receipt_policy_tuple_digest_mismatch');
      }
    }
  } else {
    if ('proposal_policy_tuple_digest' in evidence || 'receipt_policy_tuple_digest' in evidence) {
      reasons.push('shipped_policy_unexpected_fake_fields');
    }
    // The shipped registry may only ever contain tuples explicitly authorized
    // by a recorded Board motion (see SHIPPED_POLICY_AUTHORIZED_DIGESTS below).
    // This is NOT "must be empty" -- it is "must exactly match what was
    // authorized," which is empty until the first authorization lands and
    // stays exact thereafter. Any unauthorized addition, removal, or
    // modification fails closed here.
    const unauthorized = recomputedDigests.filter(d => !SHIPPED_POLICY_AUTHORIZED_DIGESTS.has(d));
    const missingAuthorized = [...SHIPPED_POLICY_AUTHORIZED_DIGESTS].filter(
      d => !recomputedDigests.includes(d)
    );
    if (unauthorized.length > 0) {
      reasons.push('shipped_policy_unauthorized_tuple');
    }
    if (missingAuthorized.length > 0) {
      reasons.push('shipped_policy_missing_authorized_tuple');
    }
  }

  return { valid: reasons.length === 0, reasons };
}

function detectGitObjectFormat(registryPath: string): GitObjectFormat | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--show-object-format'], {
      cwd: dirname(registryPath),
      encoding: 'utf8',
    }).trim();
    return output === 'sha256' ? 'sha256' : output === 'sha1' ? 'sha1' : undefined;
  } catch {
    return undefined;
  }
}

interface CliArgs {
  readonly registry: string;
  readonly manifest: string;
  readonly manifestKey: 'shipped_policy_evidence' | 'fake_policy_evidence';
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let registry: string | undefined;
  let manifest: string | undefined;
  let manifestKey: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--registry') {
      registry = value;
      index += 1;
    } else if (flag === '--manifest') {
      manifest = value;
      index += 1;
    } else if (flag === '--manifest-key') {
      manifestKey = value;
      index += 1;
    }
  }
  if (!registry) throw new Error('missing_required_flag:--registry');
  if (!manifest) throw new Error('missing_required_flag:--manifest');
  if (manifestKey !== 'shipped_policy_evidence' && manifestKey !== 'fake_policy_evidence') {
    throw new Error('missing_or_invalid_flag:--manifest-key');
  }
  return { registry, manifest, manifestKey };
}

export function runPolicyRegistryVerifyCli(argv: readonly string[]): number {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`POLICY_IDENTITIES=invalid ${(error as Error).message}\n`);
    return 1;
  }

  let registryBytes: Buffer;
  try {
    registryBytes = readFileSync(args.registry);
  } catch {
    process.stderr.write('POLICY_IDENTITIES=invalid registry_unreadable\n');
    return 1;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch {
    process.stderr.write('POLICY_IDENTITIES=invalid manifest_unreadable\n');
    return 1;
  }
  if (manifest === null || typeof manifest !== 'object') {
    process.stderr.write('POLICY_IDENTITIES=invalid manifest_not_object\n');
    return 1;
  }

  const evidence = (manifest as Record<string, unknown>)[args.manifestKey];
  const result = verifyPolicyRegistryIdentities({
    registryBytes,
    evidence,
    manifestKey: args.manifestKey,
    detectedGitObjectFormat: detectGitObjectFormat(args.registry),
  });

  if (!result.valid) {
    process.stderr.write(`POLICY_IDENTITIES=invalid ${result.reasons.join(',')}\n`);
    return 1;
  }
  process.stdout.write('POLICY_IDENTITIES=valid\n');
  return 0;
}

if (import.meta.main) {
  process.exit(runPolicyRegistryVerifyCli(process.argv.slice(2)));
}
