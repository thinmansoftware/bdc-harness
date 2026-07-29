/**
 * M-15 authority tiers -- the one law of the kingdom (Motion M-99 binding term 4).
 *
 * The verdict PROPOSES a tier; this module independently maps the action's
 * REQUIRED tier from code; the STRICTER of the two wins. Tiers gate EXECUTION
 * only -- consultation (judging, verdict rows) is never gated by anything here.
 *
 * v1-of-v2 executes Tier 0 only (binding term 3). Everything above Tier 0 is
 * refused with a recorded refusal, and unknown action kinds fail closed to the
 * strictest tier rather than defaulting open.
 */

export const TIER0_ACTIONS = [
  'verdict_write',
  'comment_findings',
  'flag_merge_ready',
  'escalate_with_evidence',
] as const;

export type Tier0Action = (typeof TIER0_ACTIONS)[number];

/** Highest tier: production-effect switches. Never autonomous; John only. */
export const MAX_TIER = 3;

const REQUIRED_TIER_BY_ACTION: Record<string, number> = {
  // 'none' executes nothing; it exists so an actionless verdict does not record
  // a misleading fail-closed MAX_TIER on its row.
  none: 0,
  verdict_write: 0,
  comment_findings: 0,
  flag_merge_ready: 0,
  escalate_with_evidence: 0,
  // Everything below exists so a model proposing it maps to a refusal, not a gap.
  merge: 1,
  repair_refire: 1,
  refresh_rebase: 1,
  branch_refresh: 1,
  lifecycle: 1,
  capability_flip: MAX_TIER,
  production_deploy: MAX_TIER,
};

/**
 * Code-side tier for an action kind. Unknown kinds fail CLOSED to MAX_TIER --
 * a model inventing a new action name must never discover an open door.
 */
export function requiredTierForAction(action: string): number {
  return REQUIRED_TIER_BY_ACTION[action] ?? MAX_TIER;
}

/** Stricter-of-two: the model can raise caution, never lower the code's floor. */
export function effectiveTier(proposedTier: number | undefined, requiredTier: number): number {
  const proposed = typeof proposedTier === 'number' && proposedTier >= 0 ? proposedTier : 0;
  return Math.max(proposed, requiredTier);
}

export function isTier0Action(action: string): action is Tier0Action {
  return (TIER0_ACTIONS as readonly string[]).includes(action);
}

export interface TierRuling {
  action: string;
  proposedTier: number | undefined;
  requiredTier: number;
  effectiveTier: number;
  /** True only when the action is a known Tier 0 action AND the effective tier is 0. */
  executableInV1: boolean;
}

export function ruleOnAction(action: string, proposedTier?: number): TierRuling {
  const required = requiredTierForAction(action);
  const effective = effectiveTier(proposedTier, required);
  return {
    action,
    proposedTier,
    requiredTier: required,
    effectiveTier: effective,
    executableInV1: effective === 0 && isTier0Action(action),
  };
}
