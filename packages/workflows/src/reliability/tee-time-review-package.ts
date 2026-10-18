// Pure package candidate. Caller record/Git/test/serializer custody is not proven here.
import { buildRunAuthority } from './run-authority';
import type { RunAuthorityRecord } from './types';
import {
  assertTeeTimeAuthority,
  assertTeeTimeRunPolicy,
  policyDigest,
  TEE_TIME_REPOSITORY,
  TEE_TIME_WORKFLOW,
} from '@archon/paths/tee-time-policy';
import {
  evidenceHash,
  requireBinding,
  validateTrustedReviewChecks,
  type ReviewBinding,
  type TrustedCheck,
} from '../../../providers/src/community/pi/restricted-review-evidence';
import {
  REVIEW_DIGEST,
  validateRestrictedReviewArtifacts,
} from '../../../providers/src/community/pi/restricted-review-policy';
import { buildRestrictedReviewWire } from '../../../providers/src/community/pi/restricted-review-wire';

export interface TeeTimeReviewPackageInput {
  authority: RunAuthorityRecord;
  run: { id: string; codebase_id: string | null; metadata?: { execution_policy?: unknown } | null };
  reviewedWorkflow: { name: string; [key: string]: unknown };
  expectedPolicy: { hash: string; codebaseId: string; workflowDigest: string; woId: string };
  specBytes: Uint8Array;
  binding: ReviewBinding;
  git: {
    baseCommit: string;
    parentCommit: string;
    headCommit: string;
    sourceTree: string;
    snapshotManifestHash: string;
    builderImage: string;
    diffText: string;
    complete: boolean;
    binary: boolean;
  };
  requiredChecks: readonly { id: string; commandHash: string }[];
  checks: readonly TrustedCheck[];
  // Synchronous serialization only. Installed-SDK provenance is an adapter obligation.
  serializeRequest: (packageText: string) => string;
}

function exactText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('complete text required');
  if (
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      new TextEncoder().encode(value)
    ) !== value
  )
    throw new Error('text encoding would replace characters');
  return value;
}

export function assembleTeeTimeReviewPackage(input: TeeTimeReviewPackageInput): Readonly<{
  binding: Readonly<ReviewBinding>;
  packageText: string;
  packageHash: string;
  wireBody: string;
  wireBytes: number;
  schemaHash: string;
}> {
  const { authority, run, expectedPolicy, git } = input;
  const spec = exactText(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.specBytes)
  );
  const rebuilt = buildRunAuthority({ ...authority, specBytes: input.specBytes });
  assertTeeTimeAuthority(expectedPolicy, authority);
  assertTeeTimeRunPolicy(run.metadata?.execution_policy, expectedPolicy);
  if (
    rebuilt.specHash !== authority.specHash ||
    authority.workflowName !== TEE_TIME_WORKFLOW ||
    !new Set([
      `https://github.com/${TEE_TIME_REPOSITORY}`,
      `https://github.com/${TEE_TIME_REPOSITORY}.git`,
      `git@github.com:${TEE_TIME_REPOSITORY}`,
      `git@github.com:${TEE_TIME_REPOSITORY}.git`,
    ]).has(authority.canonicalRemote) ||
    !/^WO-TEETIME-FOUNDATION-[0-9]+$/.test(authority.woId) ||
    authority.runId !== run.id ||
    authority.codebaseId !== run.codebase_id ||
    authority.workflowName !== input.reviewedWorkflow.name ||
    expectedPolicy.codebaseId !== run.codebase_id ||
    expectedPolicy.workflowDigest !== policyDigest(input.reviewedWorkflow)
  )
    throw new Error('run authority, policy, workflow or exact spec differs');
  // A copy prevents the serializer callback or caller mutations changing the result.
  const binding = Object.freeze({ ...input.binding });
  requireBinding(binding, binding);
  if (
    binding.runId !== run.id ||
    binding.authorityHash !== policyDigest(authority) ||
    binding.policyHash !== expectedPolicy.hash ||
    binding.baseCommit !== authority.baseSha ||
    git.baseCommit !== authority.baseSha ||
    git.parentCommit !== authority.baseSha ||
    git.headCommit !== binding.headCommit ||
    git.sourceTree !== binding.sourceTree ||
    git.snapshotManifestHash !== binding.snapshotManifestHash ||
    git.builderImage !== binding.builderImage ||
    typeof git.complete !== 'boolean' ||
    !git.complete ||
    typeof git.binary !== 'boolean' ||
    git.binary ||
    binding.reviewerModelDigest !== REVIEW_DIGEST
  )
    throw new Error('review source or binding mismatch');
  // These are controller assertions, not proof of complete diff generation or head existence.
  const diff = exactText(git.diffText);
  for (const check of input.checks) exactText(check.output);
  validateTrustedReviewChecks(binding, input.requiredChecks, input.checks);
  const tests = JSON.stringify(input.checks);
  const packageText = JSON.stringify({
    complete: true,
    artifacts: [
      ['spec', spec],
      ['diff', diff],
      ['tests', tests],
    ].map(([id, content]) => ({ id, content, sha256: evidenceHash(content) })),
  });
  validateRestrictedReviewArtifacts(packageText);
  const request = input.serializeRequest(packageText);
  if (typeof request !== 'string')
    throw new Error('synchronous serialized request string required');
  const wire = buildRestrictedReviewWire(request, packageText);
  if (binding.reviewerSchemaHash !== wire.schemaHash) throw new Error('reviewer schema differs');
  return Object.freeze({
    binding,
    packageText,
    packageHash: evidenceHash(packageText),
    wireBody: wire.body,
    wireBytes: wire.bytes,
    schemaHash: wire.schemaHash,
  });
}
