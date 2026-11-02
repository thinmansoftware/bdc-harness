import { describe, expect, test } from 'bun:test';
import {
  buildOverseerParentManifest,
  reduceParentEvidence,
  type ChildEvidenceRecord,
  type ParentEvidenceInput,
} from '../integration-manifest.ts';

const ZERO64 = '0'.repeat(64);
const HEX40_A = 'a'.repeat(40);
const HEX40_B = 'b'.repeat(40);
const HEX40_C = 'c'.repeat(40);

const REQUIRED_CHILD_IDS = [
  'WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01',
  'WO-HARNESS-OVERSEER-M31-SUBSTRATE-01',
  'WO-HARNESS-OVERSEER-ESCALATION-BRIEFING-01',
  'WO-HARNESS-OVERSEER-M31-CONTRACT-V2-01',
  'WO-HARNESS-OVERSEER-CONTROL-PLANE-01',
  'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01',
  'WO-HARNESS-OVERSEER-REFRESH-REBASE-01',
  'WO-HARNESS-OVERSEER-LIFECYCLE-SALVAGE-01',
  'WO-HARNESS-OVERSEER-QUALIFIED-MERGE-01',
] as const;

function child(
  wo_id: (typeof REQUIRED_CHILD_IDS)[number],
  overrides: Partial<ChildEvidenceRecord> = {}
): ChildEvidenceRecord {
  return {
    wo_id,
    base_sha: HEX40_A,
    pr_head: HEX40_B,
    reviewed_head: HEX40_B,
    merge_sha: HEX40_C,
    pr_number: 1,
    review: { state: 'satisfied', reviewer_login: 'reviewer-x', commit_id: HEX40_B },
    ...overrides,
  };
}

function completeChildren(
  reviewState: 'satisfied' | 'unsatisfied' | 'indeterminate' = 'satisfied'
): ChildEvidenceRecord[] {
  return REQUIRED_CHILD_IDS.map((id, i) =>
    child(id, {
      pr_number: 400 + i,
      review:
        reviewState === 'satisfied'
          ? { state: 'satisfied', reviewer_login: `reviewer-${i}`, commit_id: HEX40_B }
          : { state: reviewState },
    })
  );
}

function baseInput(overrides: Partial<ParentEvidenceInput> = {}): ParentEvidenceInput {
  return {
    children: completeChildren(),
    migrations: {
      '029': ['029_board_authority_foundation.sql', '029_known_bad_bindings.sql'],
      '035': ['035_overseer_escalation_briefing.sql'],
      '036': ['036_overseer_m31_target_contract_v2.sql'],
      '037': ['037_overseer_control_plane.sql'],
    },
    contract_blobs: {
      m31_v1: ZERO64.slice(0, 40),
      m31_v2: ZERO64.slice(0, 40),
    },
    candidate_sha: HEX40_C,
    image_digest: `sha256:${ZERO64}`,
    ...overrides,
  };
}

describe('integration-manifest parent evidence', () => {
  test('missing review evidence remains unsatisfied', () => {
    const children = completeChildren('unsatisfied');
    // Historical S1/S2: force unsatisfied even if other fields look complete.
    children[0] = child('WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01', {
      pr_number: 461,
      pr_head: 'a1ac6be240240e5e363ebab64014d13387fbaaa8',
      reviewed_head: 'a1ac6be240240e5e363ebab64014d13387fbaaa8',
      merge_sha: 'ac94ba522dd51c3c7530b979ea8a4508fa86fa88',
      review: { state: 'unsatisfied' },
    });
    children[1] = child('WO-HARNESS-OVERSEER-M31-SUBSTRATE-01', {
      pr_number: 458,
      pr_head: 'fa6240786cdfef4274dafd7a54e9fdf2c5751138',
      reviewed_head: 'fa6240786cdfef4274dafd7a54e9fdf2c5751138',
      merge_sha: 'fad167902f213ed09a48e3bcea5f69602bf3a32c',
      review: { state: 'unsatisfied' },
    });

    const reduced = reduceParentEvidence({ children });
    expect(reduced.slices.s1.review.state).toBe('unsatisfied');
    expect(reduced.slices.s2.review.state).toBe('unsatisfied');
    expect(reduced.overall).toBe('unsatisfied');

    const built = buildOverseerParentManifest(baseInput({ children }));
    expect(built.status).toBe('BLOCKED');
    expect(built.readiness_packet).toBeNull();
    expect(built.slices.s1.review.state).toBe('unsatisfied');
    expect(built.slices.s2.review.state).toBe('unsatisfied');
  });

  test('missing child evidence returns BLOCKED with no readiness packet', () => {
    const children = completeChildren().filter(
      c => c.wo_id !== 'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01'
    );
    const built = buildOverseerParentManifest(baseInput({ children }));
    expect(built.status).toBe('BLOCKED');
    expect(built.readiness_packet).toBeNull();
    expect(built.blockers.some(b => b.includes('WO-HARNESS-OVERSEER-REPAIR-REFIRE-01'))).toBe(true);
  });

  test('duplicate child id is rejected', () => {
    const children = [...completeChildren(), completeChildren()[0]!];
    const built = buildOverseerParentManifest(baseInput({ children }));
    expect(built.status).toBe('BLOCKED');
    expect(built.blockers.some(b => b.includes('duplicate'))).toBe(true);
  });

  test('reviewed_head must equal pr_head', () => {
    const children = completeChildren();
    children[4] = child('WO-HARNESS-OVERSEER-CONTROL-PLANE-01', {
      pr_head: HEX40_B,
      reviewed_head: HEX40_A,
      merge_sha: HEX40_C,
    });
    const built = buildOverseerParentManifest(baseInput({ children }));
    expect(built.status).toBe('BLOCKED');
    expect(built.blockers.some(b => b.includes('reviewed_head'))).toBe(true);
  });

  test('empty or invalid sha fields fail closed', () => {
    const children = completeChildren();
    children[5] = child('WO-HARNESS-OVERSEER-REPAIR-REFIRE-01', {
      base_sha: '',
      pr_head: 'not-a-sha',
      reviewed_head: 'not-a-sha',
      merge_sha: 'zzzz',
    });
    const built = buildOverseerParentManifest(baseInput({ children }));
    expect(built.status).toBe('BLOCKED');
  });

  test('wave2 migration prefixes must be unique single files; 029 baseline held at two', () => {
    const bad = buildOverseerParentManifest(
      baseInput({
        migrations: {
          '029': ['029_board_authority_foundation.sql', '029_known_bad_bindings.sql'],
          '035': ['035_a.sql', '035_b.sql'],
          '036': ['036_overseer_m31_target_contract_v2.sql'],
          '037': ['037_overseer_control_plane.sql'],
        },
      })
    );
    expect(bad.status).toBe('BLOCKED');
    expect(bad.blockers.some(b => b.includes('035'))).toBe(true);

    const good = buildOverseerParentManifest(baseInput());
    // Good migrations alone are not enough if reviews unsatisfied elsewhere;
    // force satisfied reviews for this check.
    expect(good.migrations_ok).toBe(true);
  });

  test('complete satisfied children produce READY_FOR_SANDBOX_PROOF_REQUEST readiness', () => {
    const built = buildOverseerParentManifest(baseInput());
    expect(built.status).toBe('READY_FOR_SANDBOX_PROOF_REQUEST');
    expect(built.readiness_packet).not.toBeNull();
    expect(built.readiness_packet?.candidate_sha).toBe(HEX40_C);
    expect(built.readiness_packet?.image_digest).toBe(`sha256:${ZERO64}`);
    expect(built.children).toHaveLength(REQUIRED_CHILD_IDS.length);
  });

  test('does not fabricate retroactive S1/S2 approvals from merge alone', () => {
    const children = completeChildren();
    children[0] = child('WO-HARNESS-OVERSEER-SAFETY-GATES-STAGING-01', {
      merge_sha: 'ac94ba522dd51c3c7530b979ea8a4508fa86fa88',
      pr_head: 'a1ac6be240240e5e363ebab64014d13387fbaaa8',
      reviewed_head: 'a1ac6be240240e5e363ebab64014d13387fbaaa8',
      review: { state: 'unsatisfied' },
    });
    const reduced = reduceParentEvidence({ children });
    expect(reduced.slices.s1.review.state).toBe('unsatisfied');
    expect(reduced.slices.s1.review.state).not.toBe('satisfied');
  });
});
