import { createHash } from 'node:crypto';

export const INDEPENDENT_REVIEW_SCHEMA_VERSION = 'm42-independent-review-v1' as const;

const SHA1_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type IndependentReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED';

export interface ReviewAgentIdentity {
  readonly provider: string;
  readonly model: string;
}

export interface IndependentReviewFinding {
  readonly scope: string;
  readonly severity: 'blocker' | 'major' | 'minor' | 'note';
  readonly summary: string;
}

export interface IndependentReviewArtifact {
  readonly schema_version: typeof INDEPENDENT_REVIEW_SCHEMA_VERSION;
  readonly candidate_sha: string;
  readonly child_heads: Readonly<Record<string, string>>;
  readonly builder: ReviewAgentIdentity;
  readonly reviewer: ReviewAgentIdentity;
  readonly verdicts: {
    readonly parent: IndependentReviewVerdict;
    readonly children: Readonly<Record<string, IndependentReviewVerdict>>;
  };
  readonly raw_transcript_sha256: string;
  readonly reviewed_at: string;
  readonly findings: readonly IndependentReviewFinding[];
}

export interface ExpectedIndependentReview {
  readonly candidate_sha: string;
  readonly child_heads: Readonly<Record<string, string>>;
  readonly builder: ReviewAgentIdentity;
}

export interface IndependentReviewValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly artifact_sha256: string;
  readonly raw_transcript_sha256: string;
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export function assertCandidateIsCurrentHead(candidateSha: string, currentHead: string): void {
  if (!SHA1_RE.test(candidateSha) || candidateSha !== currentHead) {
    throw new Error('candidate must equal current git HEAD');
  }
}

export function assertBuilderMatchesManifest(
  requested: ReviewAgentIdentity,
  manifest: ReviewAgentIdentity
): void {
  if (requested.provider !== manifest.provider || requested.model !== manifest.model) {
    throw new Error('builder identity must match manifest');
  }
}

/**
 * Validate a reviewer-owned, content-addressed M-42 exact-head review artifact.
 * GitHub review rows may be retained as additional evidence, but are not required
 * by this validator. The raw transcript and expected heads are always checked.
 */
export function validateIndependentReviewEvidence(
  artifactInput: unknown,
  rawTranscript: string,
  expected: ExpectedIndependentReview
): IndependentReviewValidationResult {
  const errors: string[] = [];
  const artifact = record(artifactInput);
  const rawTranscriptDigest = sha256(rawTranscript);
  const artifactDigest = sha256(canonicalize(artifactInput));

  if (!artifact) {
    return {
      ok: false,
      errors: ['artifact must be a JSON object'],
      artifact_sha256: artifactDigest,
      raw_transcript_sha256: rawTranscriptDigest,
    };
  }

  if (rawTranscript.trim().length === 0) errors.push('raw transcript must not be empty');

  if (artifact.schema_version !== INDEPENDENT_REVIEW_SCHEMA_VERSION) {
    errors.push(`schema_version must equal ${INDEPENDENT_REVIEW_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(artifact.candidate_sha) || !SHA1_RE.test(artifact.candidate_sha)) {
    errors.push('candidate_sha must be a lowercase 40-character commit SHA');
  } else if (artifact.candidate_sha !== expected.candidate_sha) {
    errors.push('candidate_sha does not match the expected exact head');
  }

  const artifactChildren = record(artifact.child_heads);
  if (!artifactChildren) {
    errors.push('child_heads must be an object');
  } else {
    for (const [woId, expectedHead] of Object.entries(expected.child_heads)) {
      const actualHead = artifactChildren[woId];
      if (actualHead === undefined) errors.push(`missing child head: ${woId}`);
      else if (actualHead !== expectedHead) errors.push(`child head mismatch: ${woId}`);
    }
    for (const woId of Object.keys(artifactChildren)) {
      if (!(woId in expected.child_heads)) errors.push(`unexpected child head: ${woId}`);
    }
  }

  const builder = record(artifact.builder);
  const reviewer = record(artifact.reviewer);
  if (!builder || !nonEmptyString(builder.provider) || !nonEmptyString(builder.model)) {
    errors.push('builder provider and model are required');
  } else {
    if (builder.provider !== expected.builder.provider) errors.push('builder provider mismatch');
    if (builder.model !== expected.builder.model) errors.push('builder model mismatch');
  }
  if (!reviewer || !nonEmptyString(reviewer.provider) || !nonEmptyString(reviewer.model)) {
    errors.push('reviewer provider and model are required');
  } else {
    if (reviewer.provider === expected.builder.provider) {
      errors.push('reviewer provider must differ from builder provider');
    }
    if (reviewer.model === expected.builder.model) {
      errors.push('reviewer model must differ from builder model');
    }
  }

  const verdicts = record(artifact.verdicts);
  if (!verdicts) {
    errors.push('verdicts must be an object');
  } else {
    if (verdicts.parent !== 'APPROVED') errors.push('parent verdict must be APPROVED');
    const childVerdicts = record(verdicts.children);
    if (!childVerdicts) {
      errors.push('child verdicts must be an object');
    } else {
      for (const woId of Object.keys(expected.child_heads)) {
        if (childVerdicts[woId] !== 'APPROVED') {
          errors.push(`child verdict must be APPROVED: ${woId}`);
        }
      }
      for (const woId of Object.keys(childVerdicts)) {
        if (!(woId in expected.child_heads)) errors.push(`unexpected child verdict: ${woId}`);
      }
    }
  }

  if (
    !nonEmptyString(artifact.raw_transcript_sha256) ||
    !SHA256_RE.test(artifact.raw_transcript_sha256)
  ) {
    errors.push('raw_transcript_sha256 must be a sha256 digest');
  } else if (artifact.raw_transcript_sha256 !== rawTranscriptDigest) {
    errors.push('raw transcript digest mismatch');
  }

  if (
    !nonEmptyString(artifact.reviewed_at) ||
    Number.isNaN(Date.parse(artifact.reviewed_at)) ||
    new Date(artifact.reviewed_at).toISOString() !== artifact.reviewed_at
  ) {
    errors.push('reviewed_at must be an ISO-8601 UTC timestamp');
  } else if (Date.parse(artifact.reviewed_at) > Date.now()) {
    errors.push('reviewed_at must not be in the future');
  }

  if (!Array.isArray(artifact.findings)) {
    errors.push('findings must be an array');
  } else {
    for (const [index, findingInput] of artifact.findings.entries()) {
      const finding = record(findingInput);
      if (!finding || !nonEmptyString(finding.scope) || !nonEmptyString(finding.summary)) {
        errors.push(`finding ${index} must include scope, severity, and summary`);
        continue;
      }
      if (!['blocker', 'major', 'minor', 'note'].includes(String(finding.severity))) {
        errors.push(`finding ${index} has invalid severity`);
      }
      if (finding.scope !== 'parent' && !(finding.scope in expected.child_heads)) {
        errors.push(`finding ${index} has invalid scope`);
      }
    }
    if (
      verdicts?.parent === 'APPROVED' &&
      artifact.findings.some(finding => record(finding)?.severity === 'blocker')
    ) {
      errors.push('APPROVED artifact cannot contain blocker findings');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    artifact_sha256: artifactDigest,
    raw_transcript_sha256: rawTranscriptDigest,
  };
}
