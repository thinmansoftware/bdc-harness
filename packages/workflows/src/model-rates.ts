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
// Claude Opus 5.5 (claude-opus-5-5) list rates, verified 2026-09-22:
//   Input:  $4.00 per million tokens = 0.000004 USD/token
//   Output: $20.00 per million tokens = 0.00002 USD/token
// Source: OpenRouter /api/v1/models, model anthropic/claude-opus-5.5
// (verified 2026-09-22). The harness runs Opus on the Claude subscription
// (provider claude), not OpenRouter; these figures are list rates only.

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

// ---------------------------------------------------------------------------
// Per-model rate table (WO-HARNESS-LANES-MODERNIZE-AND-HAIKU-01)
//
// Cost attribution must know the modern model ids introduced by the lane
// modernization. Rates are USD per single token (not per million).
//
// Honesty note (Rule 5 -- verify before claim): the Claude 5.5 figures below
// are DOCUMENTED ESTIMATES anchored to the published prior-generation list
// rates for the same tier; they are labelled as estimates in `source` and must
// be refreshed when Anthropic publishes the 5.5 list rates. gpt-6-astra has no
// published list rate (it is served off the Codex subscription seat), so it
// carries an EXPLICIT, documented zero -- distinguishable from a silent
// not-found-defaults-to-zero via `documentedZero: true`. getModelRate() throws
// on a genuinely unknown id rather than silently pricing it at zero.
export interface ModelRate {
  /** USD per input token. */
  inputPerToken: number;
  /** USD per output token. */
  outputPerToken: number;
  /** Provenance of the figures (verified rate, estimate anchor, or documented zero). */
  source: string;
  /** True only when the zero rate is a deliberate, documented placeholder. */
  documentedZero?: boolean;
}

export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  'claude-opus-5-5': {
    inputPerToken: 0.000004,
    outputPerToken: 0.00002,
    source: 'OpenRouter list rate anthropic/claude-opus-5.5 ($4/$20 per MTok), verified 2026-09-22',
  },
  'claude-sonnet-5-5': {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    source:
      'estimate anchored to claude-sonnet list rates ($3/$15 per MTok); refresh when 5.5 rates are published',
  },
  'claude-haiku-5-5': {
    inputPerToken: 0.000001,
    outputPerToken: 0.000005,
    source:
      'estimate anchored to claude-haiku list rates ($1/$5 per MTok); refresh when 5.5 rates are published',
  },
  'gpt-6-astra': {
    inputPerToken: 0,
    outputPerToken: 0,
    documentedZero: true,
    source:
      'DOCUMENTED ZERO: no published list rate for gpt-6-astra (served off the Codex subscription seat); explicit placeholder, not a silent default -- set a real rate if/when one is published',
  },
};

/**
 * Look up the per-token rate for a model id.
 *
 * Throws for an unknown id (fail fast) rather than silently returning a
 * zero-cost rate, which would under-report spend. A deliberate zero rate is
 * expressed via an entry with `documentedZero: true`.
 */
export function getModelRate(modelId: string): ModelRate {
  const rate = MODEL_RATES[modelId];
  if (!rate) {
    throw new Error(`[model-rates] no rate entry for model '${modelId}' (add it to MODEL_RATES)`);
  }
  return rate;
}
