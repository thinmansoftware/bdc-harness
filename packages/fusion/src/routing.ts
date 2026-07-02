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
 * DESIGN NOTES:
 *
 *  1. Persona-label -> reviewer id resolution is OPERATOR-DRIVEN via
 *     fusion.config.json (personaMapping field). The exported default map here
 *     (DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID) exists only as a documented
 *     fallback for callers that do not pass an override; production runs always
 *     load their mapping from config. Placing the mapping in config makes it an
 *     explicit operator commit -- reviewing fusion.config.json is reviewing the
 *     routing choice. See docs/personas/war-council-roster.md for the rationale.
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
 *  3. Self-review guard (assertReviewerDiversity) accepts an optional
 *     builderModelId. When provided, ANY selected reviewer that shares the
 *     builder's model triggers a fail-closed error -- including single-reviewer
 *     selections (which the v1 diversity-only check could not detect). When the
 *     builder model is unknown, the guard falls back to the diversity-only proxy
 *     (a selection that collapses to one shared model fails, but a single
 *     reviewer passes because there is no second model to compare against).
 *
 *  4. emergency-repair is split into two WO types to encode spec section 8's
 *     conditional literally: `emergency-repair` (base, no Security seat) and
 *     `emergency-repair-data` (adds Security/Tenant/PII when data/billing is
 *     involved). Callers pick the type that matches the incident; there is no
 *     silent stricter-when-in-doubt override.
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
  'emergency-repair-data',
] as const;

export type WoType = (typeof WO_TYPES)[number];

export function isWoType(value: string): value is WoType {
  return (WO_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Persona label -> Fusion reviewer id
// ---------------------------------------------------------------------------

export type PersonaMapping = Record<string, string | null>;

/**
 * Labels that intentionally resolve to NO Fusion reviewer id. These seats are
 * satisfied elsewhere in the BDC review pipeline (main DAG personas) or are the
 * Round-3 synthesizer, which always runs and is not a Round-1 reviewer. They are
 * listed in the Mode Matrix for completeness and filtered out of the call path.
 */
export const SYMBOLIC_ONLY_LABELS = ['Doctrine Reviewer', 'CI Validator', 'Synthesizer'] as const;

/**
 * DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID -- code-level fallback mapping.
 *
 * This is the mapping used when a caller does not pass an explicit personaMapping
 * (e.g., unit tests exercising selectReviewers directly). Production CLI runs
 * always load personaMapping from fusion.config.json; the operator's copy of that
 * file is the source of truth for the "Adversarial Reviewer" -> reviewer.id choice
 * and reviewing it is reviewing the routing decision (see note 1 at file top).
 *
 * Labels in SYMBOLIC_ONLY_LABELS are mapped to null on purpose (see note 2).
 */
export const DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID: PersonaMapping = {
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

/**
 * DEPRECATED alias for backward-compatible test imports.
 * New code should import DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID or pass an
 * explicit personaMapping loaded from fusion.config.json.
 */
export const PERSONA_LABEL_TO_REVIEWER_ID: PersonaMapping = DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID;

// ---------------------------------------------------------------------------
// Mode matrix (spec section 8)
// ---------------------------------------------------------------------------

export interface ModeMatrixEntry {
  required: string[];
  optional: string[];
}

/**
 * MODE_MATRIX -- WO type -> required/optional persona labels (spec section 8).
 * Values are labels (keys of the active PersonaMapping), NOT reviewer ids.
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
    // Base emergency-repair: spec section 8 says Security/Tenant/PII is added
    // ONLY when data/billing is involved. Callers who know data is touched
    // should pick 'emergency-repair-data' instead. Security is documented as
    // optional here so operators know it exists as a follow-up hook.
    required: ['Adversarial Reviewer', 'Synthesizer'],
    optional: ['Operator Friction Critic', 'Security/Tenant/PII Critic'],
  },
  'emergency-repair-data': {
    // Data/billing variant of emergency-repair. Encodes spec section 8's
    // conditional literally: Security/Tenant/PII is REQUIRED when the incident
    // touches data or billing surfaces.
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
 *
 * The optional personaMapping argument overrides the code-level default map.
 * Production callers should pass the mapping loaded from fusion.config.json.
 */
export function requiredReviewerIds(woType: WoType, personaMapping?: PersonaMapping): string[] {
  const mapping = personaMapping ?? DEFAULT_PERSONA_LABEL_TO_REVIEWER_ID;
  const entry = MODE_MATRIX[woType];
  const ids: string[] = [];
  for (const label of entry.required) {
    const id = mapping[label];
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
 *
 * The optional personaMapping argument overrides the code-level default map.
 * Production callers should pass the mapping loaded from fusion.config.json.
 */
export function selectReviewers(
  reviewers: ReviewerConfig[],
  woType: WoType,
  personaMapping?: PersonaMapping
): ReviewerConfig[] {
  const wanted = new Set(requiredReviewerIds(woType, personaMapping));
  return reviewers.filter(r => wanted.has(r.id));
}

/**
 * assertReviewerDiversity -- self-review guard (spec Test 7).
 *
 * Two-tier check:
 *
 *  A. If builderModelId is supplied, any selected reviewer whose modelId equals
 *     the builder's modelId triggers a fail-closed error. This closes the
 *     single-reviewer self-review gap (e.g. small-mechanical-bugfix -> systems
 *     when the builder ran the same model as `systems`).
 *
 *  B. If builderModelId is not supplied, fall back to the v1 diversity-only proxy:
 *     a selection collapsing to one shared model fails; a single-reviewer
 *     selection passes (there is no second model to compare against, and no
 *     builder model to check).
 *
 * Callers that know the builder's model SHOULD pass it. The Fusion CLI accepts
 * --builder-model to thread it through. When absent, tier B still catches the
 * common "all reviewers share one model" degenerate case.
 */
export function assertReviewerDiversity(
  reviewers: ReviewerConfig[],
  builderModelId?: string
): void {
  // Tier A: builder-model-aware check.
  if (builderModelId !== undefined && builderModelId.length > 0) {
    const conflict = reviewers.find(r => r.modelId === builderModelId);
    if (conflict) {
      throw new Error(
        'Fusion routing: reviewer "' +
          conflict.id +
          '" shares the builder model (' +
          builderModelId +
          '). Builder cannot be its own reviewer -- self-review guard failed. ' +
          'Assign a reviewer with a different modelId in fusion.config.json ' +
          'or select a WO type that includes a distinct persona.'
      );
    }
    // Builder is known and no reviewer matches it -- guard passes even for
    // single-reviewer selections.
    return;
  }

  // Tier B: diversity-only proxy (no builder model provided).
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
