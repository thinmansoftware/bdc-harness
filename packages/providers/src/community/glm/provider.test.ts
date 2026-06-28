import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── Mock @archon/paths logger so provider instantiation is quiet ────────────

const mockLogger = {
  info: mock(() => undefined),
  debug: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
  fatal: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock openai so no real HTTP calls are made ──────────────────────────────

const mockStreamIterator = {
  [Symbol.asyncIterator]: mock(async function* () {
    yield {
      choices: [{ delta: { content: 'hello' } }],
      usage: null,
    };
    yield {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }),
};

const mockCreate = mock(async () => mockStreamIterator);

const mockOpenAI = mock(function () {
  return {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  };
});

mock.module('openai', () => ({
  default: mockOpenAI,
  OpenAI: mockOpenAI,
}));

// ─── Import under test (after mocks) ────────────────────────────────────────

import { clearRegistry, isRegisteredProvider, registerBuiltinProviders } from '../../registry';
import { GlmProvider } from './provider';
import { registerGlmProvider } from './registration';

describe('GlmProvider', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    // Reset GLM_API_KEY between tests
    delete process.env['GLM_API_KEY'];
  });

  test('registerGlmProvider() registers glm and is idempotent', () => {
    expect(isRegisteredProvider('glm')).toBe(false);

    registerGlmProvider();
    expect(isRegisteredProvider('glm')).toBe(true);

    // Second call must not throw
    expect(() => registerGlmProvider()).not.toThrow();
    expect(isRegisteredProvider('glm')).toBe(true);
  });

  test('GlmProvider.getType() returns glm', () => {
    const provider = new GlmProvider();
    expect(provider.getType()).toBe('glm');
  });

  test('GlmProvider.sendQuery() throws if GLM_API_KEY is not set', async () => {
    delete process.env['GLM_API_KEY'];
    const provider = new GlmProvider();
    const gen = provider.sendQuery('hello', '/tmp');
    await expect(gen.next()).rejects.toThrow('GLM_API_KEY');
  });
});
