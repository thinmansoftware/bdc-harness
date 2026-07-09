export interface GrokAgentProviderDefaults {
  [key: string]: unknown;
  /** OpenRouter model id, e.g. x-ai/grok-4.5 */
  model?: string;
  /** Override OpenRouter base URL (tests / proxies) */
  baseURL?: string;
  /** Max agent tool turns per sendQuery (default 40) */
  maxTurns?: number;
  /** Bash tool timeout ms (default 120000) */
  bashTimeoutMs?: number;
}

export function parseGrokAgentConfig(raw: Record<string, unknown>): GrokAgentProviderDefaults {
  const result: GrokAgentProviderDefaults = {};
  if (typeof raw.model === 'string') result.model = raw.model;
  if (typeof raw.baseURL === 'string') result.baseURL = raw.baseURL;
  if (typeof raw.maxTurns === 'number' && raw.maxTurns > 0) result.maxTurns = raw.maxTurns;
  if (typeof raw.bashTimeoutMs === 'number' && raw.bashTimeoutMs > 0) {
    result.bashTimeoutMs = raw.bashTimeoutMs;
  }
  return result;
}
