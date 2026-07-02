/**
 * routing.ts -- War Council persona routing matrix for Cauldron Fusion.
 *
 * WO-HARNESS-WAR-COUNCIL-PERSONA-ROSTER-01.
 *
 * This module maps a WO type onto the set of reviewer personas that should run
 * for that WO type (spec section 8, "Mode Matrix"), and filters the configured
 * reviewer roster down to that set.
 *
 * ADVISORY ONLY: routing selects which reviewers are asked. It grants no deploy,
 * merge, or approval power. Selection never suppresses a reviewer's findings.
 *
 * DESIGN NOTES / FLAGGED AMBIGUITIES (see WO plan; confirm with General/John):
 *
 *  1. Persona-label -> reviewer id. The Mode Matrix uses human-readable labels
 *     ("Architect", "Adversarial Reviewer", ...). Those labels are resolved to
 *     concrete Fusion reviewer.id strings via PERSONA_LABEL_TO_REVIEWER_ID below.
 *     "Adversarial Reviewer" is mapped to the existing `systems` reviewer
 *     (role: implementation-systems) by inference -- it is the closest existing
 *     analog to the main DAG's codex-adversarial-reviewer. This is an ASSUMPTION,
 *     isolated to one constant so it is a one-line change if wrong.
 *
 *  2. Some Mode Matrix seats are satisfied elsewhere in the pipeline, NOT inside
 *     Fusion: "Doctrine Reviewer" (.archon/agents/claude-doctrine-reviewer.md) and
 *     "CI Validator" (.archon/agents/captain-ci-validator.md), plus "Synthesizer"
 *     (Fusion's Round-3 synthesizer always runs, it is not a Round-1 reviewer).
 *     These labels map to SYMBOLIC_ONLY_LABELS: they are recorded in the matrix
 *     for documentation completeness but resolve to NO Fusion reviewer id and are
 *     filtered out of the reviewer call path. selectReviewers() only ever returns
 *     reviewers that actually exist in the passed-in config roster.
 *
 *  3. assertReviewerDiversity() is a v1-scoped proxy for spec Test 7. The literal
 *     spec check ("builder model equals reviewer model and an alternate reviewer
 *     provider exists -> fail") needs a "builder model" concept that Fusion's data
 *     model does not have today (types.ts has no builderModelId). Implementing the
 *     literal check is a scope expansion (new plumbing through FusionInputs / CLI).
 *     The v1 guard instead fails closed when a selection collapses to a single
 *     shared modelId (no cross-model review is possible at all). Full builder-vs-
 *     reviewer self-review detection is a candidate follow-up WO.
 */

import type { ReviewerConfig } from './types.js';

// ---------------------------------------------------------------------------
// WO types (spec section 8 Mode Matrix rows)
// ---------------------------------------------------------------------------

export const WO_TYPES = [
  'architecture-doctrine',
  'harness-automation',
  'ux-app-feature',
  'revenue-pricing-entitlement',
  'data-billing-inventory',
  'small-mechanical-bugfix',
  'documentation-only',
  'emergency-repair',
] as const;

export type WoType = (typeof WO_TYPES)[number];

export function isWoType(value: string): value is WoType {
  return (WO_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Persona label -> Fusion reviewer id
// ---------------------------------------------------------------------------

/**
 * Labels that intentionally resolve to NO Fusion reviewer id. These seats are
 * satisfied elsewhere in the BDC review pipeline (main DAG personas) or are the
 * Round-3 synthesizer, which always runs and is not a Round-1 reviewer. They are
 * listed in the Mode Matrix for completeness and filtered out of the call path.
 */
export const SYMBOLIC_ONLY_LABELS = ['Doctrine Reviewer', 'CI Validator', 'Synthesizer'] as const;

/**
 * Maps a Mode-Matrix persona label to a concrete Fusion reviewer.id. Labels that
 * appear in SYMBOLIC_ONLY_LABELS are mapped to null on purpose (see note 2 above).
 *
 * ASSUMPTION (confirm with General/John): "Adversarial Reviewer" -> "systems".
 */
export const PERSONA_LABEL_TO_REVIEWER_ID: Record<string, string | null> = {
  Architect: 'architect',
  'Adversarial Reviewer': 'systems',
  'Product/User Advocate': 'product-advocate',
  'Contrarian / Kill-Switch Critic': 'contrarian',
  'Prior-Art Scout': 'prior-art-scout',
  'Buyer / Money Critic': 'buyer-critic',
  'Operator Friction Critic': 'operator-friction',
  'Security/Tenant/PII Critic': 'security-tenant-pii',
  // Symbolic-only seats -- satisfied outside Fusion or by the always-on synthesizer.
  'Doctrine Reviewer': null,
  'CI Validator': null,
  Synthesizer: null,
};

// ---------------------------------------------------------------------------
// Mode matrix (spec section 8)
// ---------------------------------------------------------------------------

export interface ModeMatrixEntry {
  required: string[];
  optional: string[];
}

/**
 * MODE_MATRIX -- WO type -> required/optional persona labels (spec section 8).
 * Values are labels (keys of PERSONA_LABEL_TO_REVIEWER_ID), NOT reviewer ids.
 */
export const MODE_MATRIX: Record<WoType, ModeMatrixEntry> = {
  'architecture-doctrine': {
    required: ['Architect', 'Contrarian / Kill-Switch Critic', 'Prior-Art Scout', 'Synthesizer'],
    optional: ['Buyer / Money Critic'],
  },
  'harness-automation': {
    required: [
      'Architect',
      'Operator Friction Critic',
      'Adversarial Reviewer',
      'Prior-Art Scout',
      'Synthesizer',
    ],
    optional: ['Security/Tenant/PII Critic'],
  },
  'ux-app-feature': {
    required: [
      'Architect',
      'Product/User Advocate',
      'Buyer / Money Critic',
      'Adversarial Reviewer',
      'Synthesizer',
    ],
    optional: ['Security/Tenant/PII Critic'],
  },
  'revenue-pricing-entitlement': {
    required: [
      'Architect',
      'Buyer / Money Critic',
      'Security/Tenant/PII Critic',
      'Contrarian / Kill-Switch Critic',
      'Synthesizer',
    ],
    optional: ['Doctrine Reviewer'],
  },
  'data-billing-inventory': {
    required: [
      'Architect',
      'Security/Tenant/PII Critic',
      'Adversarial Reviewer',
      'Doctrine Reviewer',
      'Synthesizer',
    ],
    optional: ['Operator Friction Critic'],
  },
  'small-mechanical-bugfix': {
    required: ['Adversarial Reviewer', 'CI Validator'],
    optional: ['Synthesizer'],
  },
  'documentation-only': {
    required: ['Doctrine Reviewer', 'Prior-Art Scout'],
    optional: ['Synthesizer'],
  },
  'emergency-repair': {
    // Security/Tenant/PII Critic is added only when data/billing is involved; in the
    // base matrix it is a required-conditional seat. v1 keeps it required here so the
    // stricter set is used when in doubt (spec section 8 routing rule).
    required: ['Adversarial Reviewer', 'Security/Tenant/PII Critic', 'Synthesizer'],
    optional: ['Operator Friction Critic'],
  },
};

// ---------------------------------------------------------------------------
// Reviewer selection
// ---------------------------------------------------------------------------

/**
 * requiredReviewerIds -- resolve a WO type's required persona labels to the
 * concrete Fusion reviewer ids that actually run in Round 1. Symbolic-only labels
 * (Doctrine Reviewer / CI Validator / Synthesizer) resolve to null and are dropped.
 */
export function requiredReviewerIds(woType: WoType): string[] {
  const entry = MODE_MATRIX[woType];
  const ids: string[] = [];
  for (const label of entry.required) {
    const id = PERSONA_LABEL_TO_REVIEWER_ID[label];
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * selectReviewers -- filter the configured reviewer roster down to the personas
 * required for the given WO type.
 *
 * Only reviewers present in BOTH the required-id set AND the passed-in roster are
 * returned (a required persona that is not configured is silently absent -- the
 * synthesizer's missing-reviewer handling is not triggered because it was never a
 * configured seat for this run). Order follows the configured roster order for
 * deterministic output.
 */
export function selectReviewers(reviewers: ReviewerConfig[], woType: WoType): ReviewerConfig[] {
  const wanted = new Set(requiredReviewerIds(woType));
  return reviewers.filter(r => wanted.has(r.id));
}

/**
 * assertReviewerDiversity -- v1-scoped self-review guard (proxy for spec Test 7).
 *
 * Throws if the selection cannot support any cross-model review at all, i.e. every
 * selected reviewer shares the same modelId. See note 3 at the top of this file:
 * this is a narrower check than the spec's literal builder-model-vs-reviewer-model
 * comparison, which needs a builder-model concept Fusion does not have yet.
 *
 * A single-reviewer or empty selection cannot be a self-review conflict, so it is
 * allowed through (there is no second model to compare against).
 */
export function assertReviewerDiversity(reviewers: ReviewerConfig[]): void {
  if (reviewers.length < 2) return;
  const distinctModels = new Set(reviewers.map(r => r.modelId));
  if (distinctModels.size < 2) {
    const shared = reviewers[0]?.modelId ?? 'unknown';
    throw new Error(
      'Fusion routing: all ' +
        reviewers.length.toString() +
        ' selected reviewers share the same model (' +
        shared +
        '). Cross-model review is impossible -- self-review guard failed. ' +
        'Assign at least two distinct reviewer models in fusion.config.json.'
    );
  }
}
