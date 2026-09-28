import { describe, expect, test } from 'bun:test';
import fixtureJson from './fixtures/dynamic-lane/eligible-synthetic.json';
import {
  canonicalDynamicLaneJson,
  dynamicLaneSnapshotSchema,
  evaluateDynamicLane,
  type DynamicLaneSnapshot,
} from './dynamic-lane-admission';

const clone = (): DynamicLaneSnapshot =>
  dynamicLaneSnapshotSchema.parse(structuredClone(fixtureJson));

function withAcceptedExchange(
  input: DynamicLaneSnapshot,
  choice = 'codex-plan'
): DynamicLaneSnapshot {
  const first = evaluateDynamicLane(input);
  return {
    ...input,
    jevExchange: {
      version: 'jev-choice/v1',
      origin: 'synthetic_jev',
      snapshotHash: first.snapshotHash,
      requestHash: first.requestHash!,
      requestedModel: 'typesafe/jev-1.13',
      returnedModel: 'typesafe/jev-1.13',
      rubricVersion: 'rubric/v1',
      decidedAt: '2026-09-26T11:59:30.000Z',
      choice,
      abstain: false,
      tied: false,
      vendorConfidence: 0.9,
      distribution: {
        abstain: 0.05,
        'claude-plan': choice === 'claude-plan' ? 0.8 : 0.15,
        'codex-plan': choice === 'codex-plan' ? 0.8 : 0.15,
      },
      usage: null,
      latencyMs: null,
    },
  };
}

describe('dynamic lane offline admission scenarios', () => {
  test('1: every AI role deterministically accepts an eligible Jev choice', () => {
    for (const role of [
      'understand',
      'plan',
      'build',
      'independent_review',
      'verify',
      'evidence_return',
    ] as const) {
      const input = clone();
      input.aiRole = role;
      input.roleObjective!.role = role;
      input.candidateProfiles!.forEach(profile => profile.applicableRoles.push(role));
      if (role === 'independent_review') {
        input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
      }
      const ready = withAcceptedExchange(input);
      const a = canonicalDynamicLaneJson(evaluateDynamicLane(ready));
      const b = canonicalDynamicLaneJson(evaluateDynamicLane(ready));
      expect(a).toBe(b);
      expect(JSON.parse(a).decision).toBe('propose');
      expect(JSON.parse(a).postExecutionReview).toBe('unissued');
    }
  });

  test.each([
    ['cancelled', true],
    ['paused', true],
    ['dependenciesComplete', false],
  ] as const)('2: %s prevents a proposal', (field, value) => {
    const input = clone();
    Object.assign(input, { [field]: value });
    expect(evaluateDynamicLane(withAcceptedExchange(input)).proposedBinding).toBeNull();
  });

  test('3: authority and capacity evidence fail closed', () => {
    const missing = clone();
    missing.authority = null;
    expect(evaluateDynamicLane(missing).candidateRejections['codex-plan']).toContain(
      'authority_missing'
    );
    const stale = clone();
    stale.accounts[0]!.observedAt = '2026-09-26T10:00:00.000Z';
    expect(evaluateDynamicLane(stale).eligibleCandidateIds).toEqual([]);
  });

  test('4: run, shared-account, router, worker, and Jev budgets are charged correctly', () => {
    const input = clone();
    input.budget.limit = 3;
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    const shared = clone();
    shared.candidates[0]!.workerAccountId = 'jev';
    shared.accounts[0]!.limit = 4;
    expect(evaluateDynamicLane(shared).candidateRejections['codex-plan']).toContain(
      'account_budget_exhausted:jev'
    );
    const exhaustedJev = clone();
    exhaustedJev.accounts[0]!.capacity = 'exhausted';
    expect(evaluateDynamicLane(exhaustedJev).eligibleCandidateIds).toEqual([]);
    const invalid = structuredClone(fixtureJson) as Record<string, unknown>;
    (invalid.budget as Record<string, unknown>).limit = -1;
    expect(dynamicLaneSnapshotSchema.safeParse(invalid).success).toBe(false);
    (invalid.budget as Record<string, unknown>).limit = Number.NaN;
    expect(dynamicLaneSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  test('5: total provider attempt ceiling is neither reset nor incremented', () => {
    const input = clone();
    const before = canonicalDynamicLaneJson(input.providerAttempts);
    input.providerAttemptCeiling = 0;
    expect(evaluateDynamicLane(input).eligibleCandidateIds).toEqual([]);
    expect(canonicalDynamicLaneJson(input.providerAttempts)).toBe(before);
  });

  test('6: writer and cancellation acknowledgement gates fail closed', () => {
    const input = clone();
    input.activeWriter = true;
    input.cancellationAcknowledged = false;
    const reasons = evaluateDynamicLane(input).candidateRejections['codex-plan']!;
    expect(reasons).toContain('active_writer');
    expect(reasons).toContain('cancellation_unacknowledged');
  });

  test('7: independent review enforces identity, family, and artifact constraints', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(p => p.applicableRoles.push('independent_review'));
    input.contributingFamilies = [
      {
        family: 'openai',
        evidenceRef: 'fixture:served',
        availableAt: '2026-09-26T11:00:00.000Z',
      },
    ];
    input.currentArtifactHash = 'sha256:a';
    input.reviewTargetHash = 'sha256:b';
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('review_family_overlap');
    expect(out.candidateRejections['codex-plan']).toContain('review_artifact_mismatch');
    expect(out.postExecutionReview).toBe('unissued');
  });

  test('7a: duplicate candidate IDs fail structural validation', () => {
    const input = structuredClone(fixtureJson);
    input.candidates.push(structuredClone(input.candidates[0]!));
    expect(dynamicLaneSnapshotSchema.safeParse(input).success).toBe(false);
  });

  test('7b: independent review requires candidate-to-family mapping evidence', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(profile => profile.applicableRoles.push('independent_review'));
    input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
    input.candidates[0]!.familyMappingEvidence = null;

    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain(
      'reviewer_family_mapping_evidence_missing'
    );
    expect(out.eligibleCandidateIds).not.toContain('codex-plan');
  });

  test('7c: independent review rejects future contributing-family evidence', () => {
    const input = clone();
    input.aiRole = 'independent_review';
    input.roleObjective!.role = 'independent_review';
    input.candidateProfiles!.forEach(profile => profile.applicableRoles.push('independent_review'));
    input.currentArtifactHash = input.reviewTargetHash = 'sha256:artifact';
    input.contributingFamilies = [
      {
        family: 'anthropic',
        evidenceRef: 'fixture:future-served-identity',
        availableAt: '2026-09-26T13:00:00.000Z',
      },
    ];

    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain(
      'future_contributor_family_mapping'
    );
    expect(out.eligibleCandidateIds).not.toContain('codex-plan');
  });

  test('8: operator binding and capability requirements override advice', () => {
    const input = clone();
    input.modelResolution.operatorBinding = { provider: 'claude', model: 'claude-synthetic' };
    input.candidates[1]!.capabilities = [];
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('operator_binding_mismatch');
    expect(out.candidateRejections['claude-plan']).toContain('capability_mismatch');
  });

  test('9: missing, mismatched, stale, tied, low-confidence, excluded, and abstaining Jev output waits', () => {
    expect(evaluateDynamicLane(clone()).jevDisposition).toBe('missing_exchange');
    const malformed = clone();
    (malformed as unknown as { jevExchange: unknown }).jevExchange = { choice: 7 };
    expect(evaluateDynamicLane(malformed).jevDisposition).toBe('malformed_exchange');
    for (const mutate of [
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.snapshotHash = 'wrong';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.decidedAt = '2026-09-26T10:00:00.000Z';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.tied = true;
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.vendorConfidence = 0;
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.choice = 'excluded';
      },
      (x: DynamicLaneSnapshot) => {
        x.jevExchange!.abstain = true;
      },
    ]) {
      const input = withAcceptedExchange(clone());
      mutate(input);
      expect(evaluateDynamicLane(input).proposedBinding).toBeNull();
    }
  });

  test('10: availability failure and elapsed reset require fresh capacity and never retry', () => {
    const input = clone();
    input.accounts[1]!.capacity = 'unavailable';
    input.accounts[1]!.resetAt = '2026-09-26T11:00:00.000Z';
    const out = evaluateDynamicLane(input);
    expect(out.candidateRejections['codex-plan']).toContain('capacity_unavailable:codex');
    expect(out.candidateRejections['codex-plan'].join(',')).not.toContain('coding');
    expect(input.providerAttempts).toEqual([]);
  });

  test('11: unknown/future/expired evidence abstains while malformed envelopes fail validation', () => {
    const future = clone();
    future.decisionEvidence!.items[0]!.availableAt = '2026-09-26T13:00:00.000Z';
    expect(evaluateDynamicLane(future).requestHash).toBeNull();
    const expired = clone();
    expired.accounts[0]!.expiresAt = expired.evaluationTime;
    expect(evaluateDynamicLane(expired).eligibleCandidateIds).toEqual([]);
    expect(dynamicLaneSnapshotSchema.safeParse({ schemaVersion: 'bad' }).success).toBe(false);
  });

  test('12: semantic evidence and profile omissions abstain before request construction', () => {
    for (const mutate of [
      (x: DynamicLaneSnapshot) => {
        x.taskBrief = null;
      },
      (x: DynamicLaneSnapshot) => {
        x.roleObjective!.text = ' ';
      },
      (x: DynamicLaneSnapshot) => {
        x.roleObjective!.acceptanceCriteria = [];
      },
      (x: DynamicLaneSnapshot) => {
        x.decisionEvidence = null;
      },
      (x: DynamicLaneSnapshot) => {
        x.candidateProfiles = [];
      },
      (x: DynamicLaneSnapshot) => {
        x.decisionEvidence!.items[0]!.kind = 'later_outcome';
      },
    ]) {
      const input = clone();
      mutate(input);
      expect(evaluateDynamicLane(input).requestHash).toBeNull();
    }
    const intake = clone();
    intake.aiRole = 'understand';
    intake.roleObjective!.role = 'understand';
    intake.candidateProfiles!.forEach(p => p.applicableRoles.push('understand'));
    intake.decisionEvidence = {
      version: 'decision-evidence/v1',
      availability: 'no_prior_artifact',
      items: [],
      noPriorArtifactReason: 'Initial intake.',
    };
    expect(evaluateDynamicLane(intake).eligibleCandidateIds.length).toBeGreaterThan(0);
  });
});
