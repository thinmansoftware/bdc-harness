// Frontier model rates and tier utilities.
// WO-HARNESS-LAYER1-TIER-AND-COUNTERFACTUAL-COST-01
//
// FRONTIER_MODEL_ID identifies the top rung for counterfactual calculations.
// Update the default below (and rates, if they changed) when the frontier
// model changes -- ARCHON_FRONTIER_MODEL_ID lets an operator override
// without a code change/deploy in the interim (M-20260726-87: this was
// previously hardcoded with no override path, forcing a full sweep+rebuild
// every time the frontier model changed). Rates are in USD per single token
// (not per million) and are NOT read from the env override -- if the
// override model's rates differ meaningfully from Opus's, update the rate
// constants too.
//
// Claude Opus 5.5 (claude-opus-5-5) list rates as of 2026-09-22:
//   Input:  $4.00 per million tokens = 0.000004 USD/token
//   Output: $20.00 per million tokens = 0.00002 USD/token
// Source: OpenRouter /api/v1/models, anthropic/claude-opus-5.5, 2026-09-22.
// List rates only. The harness runs Opus on the Claude subscription
// (provider claude), never OpenRouter.

const DEFAULT_FRONTIER_MODEL_ID = 'claude-opus-5-5';

export const FRONTIER_MODEL_ID: string =
  process.env.ARCHON_FRONTIER_MODEL_ID ?? DEFAULT_FRONTIER_MODEL_ID;
export const FRONTIER_INPUT_RATE_PER_TOKEN = 0.000004; // USD
export const FRONTIER_OUTPUT_RATE_PER_TOKEN = 0.00002; // USD

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
