/**
 * Permanent refusal of xAI models on OpenRouter-backed providers.
 *
 * John, 2026-09-23: Grok is reached only via provider cursor (grok-4.7-high).
 * OpenRouter carries open models. This module reads no environment variable
 * and has no bypass. It does not import the registry: that import cycle split
 * the registry module in two, so alias checks and registration disagreed.
 */
export const OPENROUTER_XAI_REFUSED_CODE = 'openrouter_xai_refused';

export const OPENROUTER_XAI_REFUSED_REASON =
  'Grok is reached via provider cursor (grok-4.7-high)';

/** Tool-loop client plus the text-only OpenRouter seats. `grok` is an alias of `openrouter`. */
export const OPENROUTER_BACKED_PROVIDER_IDS: readonly string[] = [
  'openrouter',
  'opr',
  'opr-zero',
  'glm',
];

const XAI_MODEL = /(^|\/)x-ai\//i;
const BARE_GROK_MODEL = /^grok[-.]/i;

let resolveProviderId: (id: string) => string = id => id;

/** Wired from provider registration so `grok` resolves to `openrouter`. */
export function setOpenRouterProviderIdResolver(resolve: (id: string) => string): void {
  resolveProviderId = resolve;
}

/**
 * Returns the refusal string when `provider` (after alias resolution) is an
 * OpenRouter-backed seat and `model` is an xAI or bare `grok-*` id.
 * Returns null when the provider is not OpenRouter-backed or the model is empty.
 */
export function getOpenRouterXaiRefusal(
  provider: string | undefined,
  model: string | undefined
): string | null {
  if (!provider || !model || model.trim().length === 0) return null;
  const resolved = resolveProviderId(provider);
  if (!OPENROUTER_BACKED_PROVIDER_IDS.includes(resolved)) return null;
  const normalized = model.trim().toLowerCase();
  if (!XAI_MODEL.test(normalized) && !BARE_GROK_MODEL.test(normalized)) return null;
  return `${OPENROUTER_XAI_REFUSED_CODE}: ${OPENROUTER_XAI_REFUSED_REASON}`;
}
