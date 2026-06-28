import type { GlmProviderDefaults } from '../../types';

export type { GlmProviderDefaults };

/**
 * Parse raw YAML-derived config into typed GLM defaults.
 * Defensive: invalid fields are dropped silently (matches parseClaudeConfig
 * and parseCodexConfig -- never throws, so broken user config cannot prevent
 * provider registration or workflow discovery).
 */
export function parseGlmConfig(raw: Record<string, unknown>): GlmProviderDefaults {
  const result: GlmProviderDefaults = {};

  if (typeof raw.model === 'string') {
    result.model = raw.model;
  }

  if (typeof raw.baseURL === 'string') {
    result.baseURL = raw.baseURL;
  }

  return result;
}
