/**
 * routing.test.ts -- War Council persona routing matrix tests.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01.
 *
 * Covers spec Test 1-4 (routing matrix selects the right personas per WO type)
 * and spec Test 7 (self-review guard).
 *
 * SCOPE NOTE (Test 7): the spec's literal Test 7 says "builder model equals
 * reviewer model and an alternate reviewer provider exists -> validation fails."
 * Fusion has no builder-model concept today, so assertReviewerDiversity() is a
 * narrower v1 proxy: it fails when a selection collapses to a single shared model
 * (no cross-model review is possible at all). These tests exercise that proxy, not
 * the literal builder-vs-reviewer comparison. See routing.ts note 3.
 */

import { describe, it, expect } from 'bun:test';
import {
  selectReviewers,
  assertReviewerDiversity,
  requiredReviewerIds,
  MODE_MATRIX,
  PERSONA_LABEL_TO_REVIEWER_ID,
  DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID,
} from '../routing.js';
import type { ReviewerConfig } from '../types.js';

// Mirror of the production roster in fusion.config.json (8 personas).
const ROSTER: ReviewerConfig[] = [
  {
    id: 'architect',
    modelId: 'anthropic/claude-opus-4-5',
    role: 'architecture-adversarial',
    promptTemplate: 'reviewer-architecture.txt',
  },
  {
    id: 'systems',
    modelId: 'z-ai/glm-5.2',
    role: 'implementation-systems',
    promptTemplate: 'reviewer-implementation.txt',
  },
  {
    id: 'product-advocate',
    modelId: 'anthropic/claude-opus-4-5',
    role: 'product-user-advocate',
    promptTemplate: 'reviewer-product-advocate.txt',
  },
  {
    id: 'contrarian',
    modelId: 'z-ai/glm-5.2',
    role: 'contrarian-kill-switch',
    promptTemplate: 'reviewer-contrarian.txt',
  },
  {
    id: 'prior-art-scout',
    modelId: 'anthropic/claude-opus-4-5',
    role: 'prior-art-scout',
    promptTemplate: 'reviewer-prior-art-scout.txt',
  },
  {
    id: 'buyer-critic',
    modelId: 'z-ai/glm-5.2',
    role: 'buyer-money-critic',
    promptTemplate: 'reviewer-buyer-critic.txt',
  },
  {
    id: 'operator-friction',
    modelId: 'anthropic/claude-opus-4-5',
    role: 'operator-friction-critic',
    promptTemplate: 'reviewer-operator-friction.txt',
  },
  {
    id: 'security-tenant-pii',
    modelId: 'z-ai/glm-5.2',
    role: 'security-tenant-pii-critic',
    promptTemplate: 'reviewer-security-tenant-pii.txt',
  },
];

function ids(reviewers: ReviewerConfig[]): string[] {
  return reviewers.map(r => r.id).sort();
}

describe('routing matrix -- spec Test 1: UX / app feature', () => {
  it('selects Architect, Product Advocate, Buyer Critic, and Adversarial (systems)', () => {
    const selected = selectReviewers(ROSTER, 'ux-app-feature');
    const selectedIds = ids(selected);
    // Architect + Product/User Advocate + Buyer/Money Critic + Adversarial Reviewer (-> systems).
    // Synthesizer is symbolic-only (always-on Round 3), so it is not a Round-1 reviewer id.
    expect(selectedIds).toEqual(
      ['architect', 'buyer-critic', 'product-advocate', 'systems'].sort()
    );
  });

  it('does NOT select Prior-Art Scout for UX / app feature', () => {
    const selected = selectReviewers(ROSTER, 'ux-app-feature');
    expect(selected.map(r => r.id)).not.toContain('prior-art-scout');
  });
});

describe('routing matrix -- spec Test 2: harness automation includes Operator Friction', () => {
  it('selects Operator Friction Critic for harness-automation', () => {
    const selected = selectReviewers(ROSTER, 'harness-automation');
    expect(selected.map(r => r.id)).toContain('operator-friction');
  });

  it('selects the full harness set (architect, operator-friction, systems, prior-art-scout)', () => {
    const selected = selectReviewers(ROSTER, 'harness-automation');
    expect(ids(selected)).toEqual(
      ['architect', 'operator-friction', 'systems', 'prior-art-scout'].sort()
    );
  });
});

describe('routing matrix -- spec Test 3: data/billing/inventory includes Security critic', () => {
  it('selects Security/Tenant/PII Critic for data-billing-inventory', () => {
    const selected = selectReviewers(ROSTER, 'data-billing-inventory');
    expect(selected.map(r => r.id)).toContain('security-tenant-pii');
  });

  it('Security/Tenant/PII Critic is blocking-capable (required, not optional)', () => {
    // Blocking-capable == appears in the REQUIRED set for this WO type, not optional.
    const entry = MODE_MATRIX['data-billing-inventory'];
    expect(entry.required).toContain('Security/Tenant/PII Critic');
    expect(entry.optional).not.toContain('Security/Tenant/PII Critic');
  });
});

describe('routing matrix -- spec Test 4: small mechanical bugfix does not over-review', () => {
  it('selects only the Adversarial Reviewer (systems) among configured Fusion reviewers', () => {
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix');
    // Required labels are Adversarial Reviewer + CI Validator; CI Validator is symbolic-only
    // (satisfied outside Fusion), so only `systems` resolves to a Round-1 reviewer.
    expect(selected.map(r => r.id)).toEqual(['systems']);
  });

  it('does NOT select the full panel for a small mechanical bugfix', () => {
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix');
    expect(selected.length).toBeLessThan(ROSTER.length);
    for (const heavy of ['architect', 'product-advocate', 'buyer-critic', 'prior-art-scout']) {
      expect(selected.map(r => r.id)).not.toContain(heavy);
    }
  });
});

describe('routing matrix -- symbolic-only seats resolve to no Fusion reviewer', () => {
  it('PERSONA_LABEL_TO_REVIEWER_ID is an alias for the default mapping', () => {
    // Backward-compatible alias: the deprecated export must point at the same
    // default map so downstream imports do not silently diverge.
    expect(PERSONA_LABEL_TO_REVIEWER_ID).toBe(DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID);
  });

  it('maps Doctrine Reviewer, CI Validator, and Synthesizer to null', () => {
    expect(PERSONA_LABEL_TO_REVIEWER_ID['Doctrine Reviewer']).toBeNull();
    expect(PERSONA_LABEL_TO_REVIEWER_ID['CI Validator']).toBeNull();
    expect(PERSONA_LABEL_TO_REVIEWER_ID['Synthesizer']).toBeNull();
  });

  it('documentation-only requires Prior-Art Scout but drops symbolic Doctrine Reviewer from ids', () => {
    const idList = requiredReviewerIds('documentation-only');
    expect(idList).toContain('prior-art-scout');
    // Doctrine Reviewer is symbolic-only -> not in the resolved Round-1 id set.
    expect(idList).not.toContain('doctrine-reviewer');
  });
});

describe('routing -- spec Test 7 (v1-scoped self-review guard)', () => {
  it('throws when every selected reviewer shares the same model', () => {
    const sameModel: ReviewerConfig[] = [
      { id: 'a', modelId: 'anthropic/claude-opus-4-5', role: 'r', promptTemplate: 't' },
      { id: 'b', modelId: 'anthropic/claude-opus-4-5', role: 'r', promptTemplate: 't' },
    ];
    expect(() => assertReviewerDiversity(sameModel)).toThrow(/self-review guard/i);
  });

  it('passes when at least two distinct reviewer models are present', () => {
    const selected = selectReviewers(ROSTER, 'harness-automation');
    // Roster alternates two models, so any multi-persona selection is diverse.
    expect(selected.length).toBeGreaterThanOrEqual(2);
    expect(() => assertReviewerDiversity(selected)).not.toThrow();
  });

  it('allows a single-reviewer selection through (no second model to conflict with)', () => {
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix');
    expect(selected.length).toBe(1);
    expect(() => assertReviewerDiversity(selected)).not.toThrow();
  });
});

describe('routing matrix -- emergency-repair split (spec section 8 conditional)', () => {
  it('base emergency-repair does NOT require Security/Tenant/PII (spec base case)', () => {
    const entry = MODE_MATRIX['emergency-repair'];
    expect(entry.required).not.toContain('Security/Tenant/PII Critic');
    expect(entry.optional).toContain('Security/Tenant/PII Critic');
  });

  it('emergency-repair-data REQUIRES Security/Tenant/PII (spec data/billing conditional)', () => {
    const entry = MODE_MATRIX['emergency-repair-data'];
    expect(entry.required).toContain('Security/Tenant/PII Critic');
  });

  it('base emergency-repair selects only adversarial analog (systems), no Security', () => {
    const selected = selectReviewers(ROSTER, 'emergency-repair');
    expect(selected.map(r => r.id).sort()).toEqual(['systems']);
    expect(selected.map(r => r.id)).not.toContain('security-tenant-pii');
  });

  it('emergency-repair-data selects systems AND security-tenant-pii', () => {
    const selected = selectReviewers(ROSTER, 'emergency-repair-data');
    expect(selected.map(r => r.id).sort()).toEqual(['security-tenant-pii', 'systems']);
  });
});

describe('routing -- builder-model self-review guard (closes single-reviewer gap)', () => {
  it('throws when a single reviewer shares the builder model', () => {
    // small-mechanical-bugfix -> just `systems` (modelId z-ai/glm-5.2). If the
    // builder ran the same model, that is a self-review even with 1 reviewer.
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix');
    expect(selected).toHaveLength(1);
    expect(() => assertReviewerDiversity(selected, 'z-ai/glm-5.2')).toThrow(/self-review guard/i);
  });

  it('throws when ANY reviewer in a multi-reviewer set shares the builder model', () => {
    const selected = selectReviewers(ROSTER, 'harness-automation');
    // `systems` uses z-ai/glm-5.2; picking that as the builder model must fail.
    expect(() => assertReviewerDiversity(selected, 'z-ai/glm-5.2')).toThrow(/self-review guard/i);
  });

  it('passes when the builder model does not match any selected reviewer', () => {
    const selected = selectReviewers(ROSTER, 'harness-automation');
    expect(() => assertReviewerDiversity(selected, 'openai/gpt-not-in-roster')).not.toThrow();
  });

  it('single-reviewer selection still passes when no builder model is provided (Tier B fallback)', () => {
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix');
    expect(selected).toHaveLength(1);
    expect(() => assertReviewerDiversity(selected)).not.toThrow();
  });
});

describe('routing -- persona mapping is config-overridable (removes hardcoded assumption)', () => {
  it('honors an operator-supplied personaMapping override', () => {
    // Operator remaps "Adversarial Reviewer" onto a different reviewer id.
    const override = {
      ...PERSONA_LABEL_TO_REVIEWER_ID,
      'Adversarial Reviewer': 'contrarian',
    };
    const ids = requiredReviewerIds('small-mechanical-bugfix', override);
    expect(ids).toEqual(['contrarian']);
  });

  it('falls back to DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID when no override is passed', () => {
    const ids = requiredReviewerIds('small-mechanical-bugfix');
    expect(ids).toEqual(['systems']);
  });

  it('selectReviewers routes through the override end-to-end', () => {
    const override = {
      ...PERSONA_LABEL_TO_REVIEWER_ID,
      'Adversarial Reviewer': 'contrarian',
    };
    const selected = selectReviewers(ROSTER, 'small-mechanical-bugfix', override);
    expect(selected.map(r => r.id)).toEqual(['contrarian']);
  });
});
