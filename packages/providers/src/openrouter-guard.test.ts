import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getOpenRouterXaiRefusal, setOpenRouterProviderIdResolver } from './openrouter-guard';
import { registerBuiltinProviders, registerCommunityProviders } from './registry';

const REFUSAL = 'openrouter_xai_refused: Grok is reached via provider cursor (grok-4.7-high)';

describe('getOpenRouterXaiRefusal', () => {
  test('refuses xAI on every OpenRouter-backed provider and accepts the rest', () => {
    registerBuiltinProviders();
    registerCommunityProviders();

    const refusedProviders = ['openrouter', 'grok', 'opr', 'opr-zero', 'glm'];
    const refusedModels = ['x-ai/grok-4.7', 'X-AI/Grok-4.7', ' x-ai/grok-4.6 ', 'grok-4.7'];
    for (const provider of refusedProviders) {
      for (const model of refusedModels) {
        expect(getOpenRouterXaiRefusal(provider, model)).toBe(REFUSAL);
      }
    }

    const accepted: Array<[string, string]> = [
      ['openrouter', 'deepseek/deepseek-v4.1-flash'],
      ['openrouter', 'qwen/qwen3-coder-next'],
      ['cursor', 'grok-4.7-high'],
      ['claude', 'claude-opus-5'],
      ['codex', 'gpt-5.6-sol'],
      ['openrouter', ''],
    ];
    for (const [provider, model] of accepted) {
      expect(getOpenRouterXaiRefusal(provider, model)).toBeNull();
    }
  });

  test('refuses grok xAI before the alias resolver is wired', () => {
    setOpenRouterProviderIdResolver(id => id);
    try {
      expect(getOpenRouterXaiRefusal('grok', 'x-ai/grok-4.7')).toBe(REFUSAL);
      expect(getOpenRouterXaiRefusal('grok', 'grok-4.7')).toBe(REFUSAL);
      expect(getOpenRouterXaiRefusal('grok', 'deepseek/deepseek-v4.1-flash')).toBeNull();
    } finally {
      registerBuiltinProviders();
      registerCommunityProviders();
    }
  });

  test('guard module reads no environment variable', () => {
    const source = readFileSync(new URL('./openrouter-guard.ts', import.meta.url), 'utf8');
    expect(source.includes('process.env')).toBe(false);
  });
});
