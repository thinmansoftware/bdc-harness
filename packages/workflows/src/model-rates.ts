// Frontier model rates and tier utilities.
// WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01
//
// FRONTIER_MODEL_ID identifies the top rung for counterfactual calculations.
// Update these constants when the frontier model or published rates change.
// Rates are in USD per single token (not per million).
//
// Claude Opus 4 (claude-opus-4-7) list rates as of 2026-06-29:
//   Input:  $15.00 per million tokens = 0.000015 USD/token
//   Output: $75.00 per million tokens = 0.000075 USD/token
// Source: https://www.anthropic.com/pricing

export const FRONTIER_MODEL_ID = 'claude-opus-4-7';
export const FRONTIER_INPUT_RATE_PER_TOKEN = 0.000015; // USD
export const FRONTIER_OUTPUT_RATE_PER_TOKEN = 0.000075; // USD

/**
 * Derive the entry-rung label for a node.
 * Returns "<provider>:<effective-model>" as a colon-joined string.
 * When model is unknown (null/undefined/empty), returns "<provider>:unknown".
 * Phase 4 (router tiers) will replace this with the router-assigned rung.
 */
export function deriveEntryRung(provider: string, model: string | null | undefined): string {
  const m = typeof model === 'string' && model.length > 0 ? model : 'unknown';
  return `${provider}:${m}`;
}

/**
 * Compute the counterfactual cost if this node had run on the frontier model.
 * Uses the SAME token counts already recorded by the provider.
 * Returns 0 when both input and output are zero.
 */
export function computeFrontierCost(tokens: { input: number; output: number }): number {
  return (
    tokens.input * FRONTIER_INPUT_RATE_PER_TOKEN + tokens.output * FRONTIER_OUTPUT_RATE_PER_TOKEN
  );
}
