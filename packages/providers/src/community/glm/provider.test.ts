import { beforeEach, describe, expect, mock, test } from 'bun:test';

// --- Mock @archon/paths logger so provider instantiation is quiet ----------

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

// --- Mock openai so no real HTTP calls are made ----------------------------

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

// --- Import under test (after mocks) ---------------------------------------

import { clearRegistry, isRegisteredProvider, registerBuiltinProviders } from '../../registry';
import { GlmProvider } from './provider';
import { registerGlmProvider } from './registration';

describe('GlmProvider', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    // Reset GLM_API_KEY between tests
    delete process.env['GLM_API_KEY'];
    mockCreate.mockClear();
    mockOpenAI.mockClear();
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

  test('GlmProvider uses OpenRouter base URL by default', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    const provider = new GlmProvider();
    const gen = provider.sendQuery('hello', '/tmp');
    // Drain the generator so the client constructor runs
    for await (const _ of gen) {
      /* discard */
    }
    const constructorArg = mockOpenAI.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(constructorArg?.['baseURL']).toBe('https://openrouter.ai/api/v1');
  });

  test('GlmProvider normalizes bare glm-5.2 to z-ai/glm-5.2', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    const provider = new GlmProvider();
    const gen = provider.sendQuery('hello', '/tmp', undefined, { model: 'glm-5.2' });
    for await (const _ of gen) {
      /* discard */
    }
    const createArg = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg?.['model']).toBe('z-ai/glm-5.2');
  });

  test('GlmProvider passes through already-prefixed z-ai/glm-4.6 unchanged', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    const provider = new GlmProvider();
    const gen = provider.sendQuery('hello', '/tmp', undefined, { model: 'z-ai/glm-4.6' });
    for await (const _ of gen) {
      /* discard */
    }
    const createArg = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(createArg?.['model']).toBe('z-ai/glm-4.6');
  });

  // T1 (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01): a GLM-lane node runs ->
  // result chunk carries servedModelId from the OpenRouter SSE stream's
  // ChatCompletionChunk.model field (present on every chunk per the OpenAI
  // wire protocol).
  test('GlmProvider captures served model id from OpenRouter SSE chunks', async () => {
    process.env['GLM_API_KEY'] = 'sk-test';
    // Override the module-level stream once with chunks that carry the served
    // model id (mimicking OpenRouter's response shape where requested
    // z-ai/glm-5.2 may be served as z-ai/glm-5.2-20260616).
    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          model: 'z-ai/glm-5.2-20260616',
          choices: [{ delta: { content: 'hi' } }],
          usage: null,
        };
        yield {
          model: 'z-ai/glm-5.2-20260616',
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        };
      },
    }));

    const provider = new GlmProvider();
    const chunks = [];
    for await (const chunk of provider.sendQuery('hello', '/tmp', undefined, {
      model: 'glm-5.2',
    })) {
      chunks.push(chunk);
    }

    const result = chunks.find(c => c.type === 'result');
    expect(result).toBeDefined();
    // Narrow to the result variant for the served-model assertion.
    expect(result && 'servedModelId' in result ? result.servedModelId : undefined).toBe(
      'z-ai/glm-5.2-20260616'
    );
  });
});
