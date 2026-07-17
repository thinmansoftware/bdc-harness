import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  assertCandidateIsCurrentHead,
  validateIndependentReviewEvidence,
  type IndependentReviewArtifact,
} from '../independent-review-evidence.ts';
import { REQUIRED_M42_CHILD_WO_IDS } from '../integration-manifest.ts';

const CANDIDATE = 'c'.repeat(40);
const TRANSCRIPT = 'independent fable review transcript\n';
const TRANSCRIPT_DIGEST = `sha256:${createHash('sha256').update(TRANSCRIPT).digest('hex')}`;

const childHeads = Object.fromEntries(
  REQUIRED_M42_CHILD_WO_IDS.map((woId, index) => [woId, `${index + 1}`.repeat(40)])
);

function artifact(overrides: Partial<IndependentReviewArtifact> = {}): IndependentReviewArtifact {
  return {
    schema_version: 'm42-independent-review-v1',
    candidate_sha: CANDIDATE,
    child_heads: childHeads,
    builder: { provider: 'xai', model: 'grok-code-fast-1' },
    reviewer: { provider: 'anthropic', model: 'claude-opus-4-1' },
    verdicts: {
      parent: 'APPROVED',
      children: Object.fromEntries(REQUIRED_M42_CHILD_WO_IDS.map(woId => [woId, 'APPROVED'])),
    },
    raw_transcript_sha256: TRANSCRIPT_DIGEST,
    reviewed_at: '2026-07-16T12:00:00.000Z',
    findings: [],
    ...overrides,
  };
}

const expected = {
  candidate_sha: CANDIDATE,
  child_heads: childHeads,
  builder: { provider: 'xai', model: 'grok-code-fast-1' },
};

describe('independent review evidence', () => {
  test('accepts an exact-head, independently produced approval artifact', () => {
    const result = validateIndependentReviewEvidence(artifact(), TRANSCRIPT, expected);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.artifact_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('fails closed on candidate, child, transcript, verdict, or timestamp mismatch', () => {
    const bad = artifact({
      candidate_sha: 'd'.repeat(40),
      child_heads: { ...childHeads, [REQUIRED_M42_CHILD_WO_IDS[0]]: 'e'.repeat(40) },
      raw_transcript_sha256: `sha256:${'0'.repeat(64)}`,
      reviewed_at: 'not-a-timestamp',
      verdicts: {
        parent: 'CHANGES_REQUESTED',
        children: {
          ...Object.fromEntries(REQUIRED_M42_CHILD_WO_IDS.map(woId => [woId, 'APPROVED'])),
          [REQUIRED_M42_CHILD_WO_IDS[1]]: 'CHANGES_REQUESTED',
        },
      },
    });
    const result = validateIndependentReviewEvidence(bad, TRANSCRIPT, expected);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('candidate_sha');
    expect(result.errors.join('\n')).toContain('child head');
    expect(result.errors.join('\n')).toContain('raw transcript');
    expect(result.errors.join('\n')).toContain('parent verdict');
    expect(result.errors.join('\n')).toContain('child verdict');
    expect(result.errors.join('\n')).toContain('reviewed_at');
  });

  test('rejects self-review and incomplete or extra child coverage', () => {
    const children = { ...childHeads };
    delete children[REQUIRED_M42_CHILD_WO_IDS[0]];
    children['WO-UNEXPECTED'] = 'f'.repeat(40);
    const result = validateIndependentReviewEvidence(
      artifact({
        child_heads: children,
        reviewer: { provider: 'xai', model: 'grok-code-fast-1' },
      }),
      TRANSCRIPT,
      expected
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('reviewer provider');
    expect(result.errors.join('\n')).toContain('reviewer model');
    expect(result.errors.join('\n')).toContain('missing child head');
    expect(result.errors.join('\n')).toContain('unexpected child head');
  });

  test('rejects malformed artifact fields instead of throwing', () => {
    const result = validateIndependentReviewEvidence(
      { schema_version: 'wrong' } as unknown as IndependentReviewArtifact,
      TRANSCRIPT,
      expected
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('rejects empty transcript, future timestamp, invalid severity, and unknown finding scope', () => {
    const result = validateIndependentReviewEvidence(
      artifact({
        raw_transcript_sha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
        reviewed_at: '2099-01-01T00:00:00.000Z',
        findings: [
          { scope: 'WO-UNEXPECTED', severity: 'critical', summary: 'invalid' },
        ] as unknown as IndependentReviewArtifact['findings'],
      }),
      '',
      expected
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('transcript must not be empty');
    expect(result.errors.join('\n')).toContain('future');
    expect(result.errors.join('\n')).toContain('severity');
    expect(result.errors.join('\n')).toContain('scope');
  });

  test('candidate verifier rejects a caller SHA that is not the checked-out HEAD', () => {
    expect(() => assertCandidateIsCurrentHead(CANDIDATE, CANDIDATE)).not.toThrow();
    expect(() => assertCandidateIsCurrentHead(CANDIDATE, 'd'.repeat(40))).toThrow(
      'candidate must equal current git HEAD'
    );
  });
});
