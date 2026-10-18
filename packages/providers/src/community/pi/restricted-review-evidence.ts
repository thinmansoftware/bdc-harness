// Pure candidate only: trusted controller custody and atomic consumption remain required.
import { createHash } from 'node:crypto';
import {
  parseReviewVerdict,
  validateRestrictedReviewArtifacts,
  REVIEW_DIGEST,
} from './restricted-review-policy';
import { buildRestrictedReviewWire } from './restricted-review-wire';

export interface ReviewBinding {
  runId: string;
  nodeId: string;
  attempt: number;
  baseCommit: string;
  headCommit: string;
  sourceTree: string;
  authorityHash: string;
  policyHash: string;
  builderImage: string;
  testImage: string;
  reviewerImage: string;
  reviewerSource: string;
  reviewerModelDigest: string;
  reviewerSchemaHash: string;
  workerAttemptId: string;
  snapshotManifestHash: string;
}

export interface TrustedCheck {
  id: string;
  commandHash: string;
  sourceTree: string;
  image: string;
  exitCode: number;
  termination: 'completed' | 'timeout' | 'aborted';
  truncated: boolean;
  skipped: number;
  assertions: number;
  output: string;
  outputHash: string;
}

export interface ReviewEnvelope {
  binding: ReviewBinding;
  packageHash: string;
  events: {
    type: string;
    normalCompletion?: boolean;
    isError?: boolean;
    verdictText?: string;
  }[];
}

const bindingKeys = [
  'runId',
  'nodeId',
  'attempt',
  'baseCommit',
  'headCommit',
  'sourceTree',
  'authorityHash',
  'policyHash',
  'builderImage',
  'testImage',
  'reviewerImage',
  'reviewerSource',
  'reviewerModelDigest',
  'reviewerSchemaHash',
  'workerAttemptId',
  'snapshotManifestHash',
] as const;

export function evidenceHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireBinding(actual: ReviewBinding, expected: ReviewBinding): void {
  for (const value of [actual, expected]) {
    if (Object.keys(value).sort().join(',') !== [...bindingKeys].sort().join(','))
      throw new Error('binding fields mismatch');
    for (const key of bindingKeys) {
      const item = value[key];
      if (key === 'attempt') {
        if (!Number.isSafeInteger(item) || Number(item) < 1) throw new Error('invalid attempt');
      } else if (['runId', 'nodeId', 'workerAttemptId'].includes(key)) {
        if (typeof item !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(item))
          throw new Error('invalid identity');
      } else {
        // Authority/policy use the existing controller's canonical prefixed digest.
        const pattern =
          key.endsWith('Image') || key === 'authorityHash' || key === 'policyHash'
            ? /^sha256:[a-f0-9]{64}$/
            : ['baseCommit', 'headCommit', 'sourceTree', 'reviewerSource'].includes(key)
              ? /^[a-f0-9]{40}$/
              : /^[a-f0-9]{64}$/;
        if (typeof item !== 'string' || !pattern.test(item))
          throw new Error('invalid source identity');
      }
    }
  }
  if (bindingKeys.some(key => actual[key] !== expected[key]))
    throw new Error('stale or foreign binding');
}

export function validateReviewEvidence(input: {
  binding: ReviewBinding;
  expectedBinding: ReviewBinding;
  packageText: string;
  serializedSdkRequest: string;
  requiredChecks: readonly { id: string; commandHash: string }[];
  checks: readonly TrustedCheck[];
  envelope: ReviewEnvelope;
}): { packageHash: string; bindingHash: string; wireBytes: number; verdict: 'APPROVED' } {
  requireBinding(input.binding, input.expectedBinding);
  requireBinding(input.envelope.binding, input.expectedBinding);
  validateRestrictedReviewArtifacts(input.packageText);
  const wire = buildRestrictedReviewWire(input.serializedSdkRequest, input.packageText);
  if (
    input.binding.reviewerSchemaHash !== wire.schemaHash ||
    input.binding.reviewerModelDigest !== REVIEW_DIGEST
  )
    throw new Error('reviewer schema or model identity mismatch');
  const packageHash = evidenceHash(input.packageText);
  if (input.envelope.packageHash !== packageHash) throw new Error('review package hash mismatch');
  const required = new Map(input.requiredChecks.map(check => [check.id, check.commandHash]));
  if (
    !required.size ||
    required.size !== input.requiredChecks.length ||
    input.checks.length !== required.size
  )
    throw new Error('required checks missing or duplicated');
  const seen = new Set<string>();
  for (const check of input.checks) {
    if (
      !required.has(check.id) ||
      seen.has(check.id) ||
      !/^[a-f0-9]{64}$/.test(check.commandHash) ||
      required.get(check.id) !== check.commandHash ||
      check.sourceTree !== input.binding.sourceTree ||
      check.image !== input.binding.testImage ||
      check.exitCode !== 0 ||
      check.termination !== 'completed' ||
      typeof check.truncated !== 'boolean' ||
      check.truncated ||
      check.skipped !== 0 ||
      !Number.isSafeInteger(check.assertions) ||
      check.assertions < 1 ||
      !check.output.trim() ||
      evidenceHash(check.output) !== check.outputHash
    )
      throw new Error('trusted test receipt rejected');
    seen.add(check.id);
  }
  const artifacts = JSON.parse(input.packageText).artifacts as {
    id: string;
    content: string;
  }[];
  // The reviewer must receive the exact complete trusted receipts, not a model summary.
  if (artifacts.find(item => item.id === 'tests')?.content !== JSON.stringify(input.checks))
    throw new Error('reviewed tests differ from trusted receipts');
  if (input.envelope.events.length !== 1) throw new Error('duplicate or unexpected review event');
  const terminal = input.envelope.events[0];
  if (
    terminal?.type !== 'result' ||
    terminal.normalCompletion !== true ||
    terminal.isError !== false ||
    typeof terminal.verdictText !== 'string' ||
    Object.keys(terminal).sort().join(',') !== 'isError,normalCompletion,type,verdictText'
  )
    throw new Error('invalid review terminal');
  if (parseReviewVerdict(terminal.verdictText).verdict !== 'APPROVED')
    throw new Error('review rejected');
  // This is a validated candidate, not authorization for a side effect or replay.
  return {
    packageHash,
    bindingHash: evidenceHash(JSON.stringify(bindingKeys.map(key => input.binding[key]))),
    wireBytes: wire.bytes,
    verdict: 'APPROVED',
  };
}
