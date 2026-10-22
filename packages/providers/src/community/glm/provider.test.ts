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
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 },
    };
  }),
};

const mockCreate = mock(async () => mockStreamIterator);

const mockOpenAI = mock((_arg?: unknown) => ({
  chat: {
    completions: {
      create: mockCreate,
    },
  },
}));

interface OpenRouterMockSlots {
  grokCreate?: (body: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  glmCreate?: (body: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  grokCtor?: (arg: unknown) => void;
  glmCtor?: (arg: unknown) => void;
}

function openRouterMockSlots(): OpenRouterMockSlots {
  const bag = globalThis as typeof globalThis & {
    __bdcOpenRouterMockSlots?: OpenRouterMockSlots;
  };
  bag.__bdcOpenRouterMockSlots ??= {};
  return bag.__bdcOpenRouterMockSlots;
}

function dispatchOpenRouterCreate(
  body: unknown,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const streaming =
    typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true;
  const slots = openRouterMockSlots();
  const fn = streaming ? slots.glmCreate : slots.grokCreate;
  if (!fn) {
    throw new Error(
      streaming
        ? 'openai mock: GLM streaming dispatcher is not registered'
        : 'openai mock: Grok dispatcher is not registered'
    );
  }
  return fn(body, options);
}

function SharedOpenAI(arg: unknown): {
  chat: { completions: { create: typeof dispatchOpenRouterCreate } };
} {
  const slots = openRouterMockSlots();
  slots.grokCtor?.(arg);
  slots.glmCtor?.(arg);
  return { chat: { completions: { create: dispatchOpenRouterCreate } } };
}

mock.module('openai', () => ({
  default: SharedOpenAI,
  OpenAI: SharedOpenAI,
}));

openRouterMockSlots().glmCreate = (body, options) => mockCreate(body, options);
openRouterMockSlots().glmCtor = (arg: unknown): void => {
  mockOpenAI(arg);
};

// --- Import under test (after mocks) ---------------------------------------

import {
  clearRegistry,
  getProviderCapabilities,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
  resolveProviderId,
} from '../../registry';
import { GlmProvider } from './provider';
import { registerGlmProvider } from './registration';

describe('GlmProvider', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
    // Reset GLM_API_KEY between tests
    delete process.env['GLM_API_KEY'];
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => mockStreamIterator);
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
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, cost: 0 },
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

  // S5-GLM: availability error (5xx) triggers failback provider.
  // WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01
  // Uses duck-typed error with `status` property (avoids OpenAI.APIError
  // instanceof check which fails when openai is mocked).
  test('S5-GLM: OpenRouter 5xx availability error triggers failback with disclosure', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';

    // Duck-typed 502 error -- isAvailabilityError checks err.status, not instanceof
    const serverError = Object.assign(new Error('502 Bad Gateway'), { status: 502 });
    mockCreate.mockRejectedValueOnce(serverError);

    const failbackChunks: { type: string; content?: string }[] = [];
    const failbackSendQuery = mock(async function* (
      _p: string,
      _c: string,
      _r?: string,
      _o?: unknown
    ) {
      yield { type: 'assistant', content: 'claude fallback content' } as const;
      yield { type: 'result', sessionId: 'fb' } as const;
    });

    const failbackFactory = mock(() => ({ sendQuery: failbackSendQuery }));
    const provider = new GlmProvider({
      failbackProviderFactory: failbackFactory as unknown as () => GlmProvider,
    });

    for await (const chunk of provider.sendQuery('hello', '/tmp')) {
      failbackChunks.push(chunk as { type: string; content?: string });
    }

    // Factory was invoked on availability error
    expect(failbackFactory).toHaveBeenCalled();
    // Disclosure chunk present
    const disclosure = failbackChunks.find(
      c => c.type === 'system' && c.content?.includes('GLM FAILBACK')
    );
    expect(disclosure).toBeDefined();
    // Failback content streamed through
    expect(
      failbackChunks.some(c => c.type === 'assistant' && c.content === 'claude fallback content')
    ).toBe(true);
  });

  // S6-GLM: non-availability error (401 auth) does NOT trigger failback.
  test('S6-GLM: 401 auth error re-throws without invoking failback', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-bad';

    // Duck-typed 401 error -- isAvailabilityError returns false for 4xx
    const authError = Object.assign(new Error('401 Unauthorized: invalid API key'), {
      status: 401,
    });
    mockCreate.mockRejectedValueOnce(authError);

    const failbackFactory = mock(() => {
      throw new Error('failback must not be called on auth error');
    });
    const provider = new GlmProvider({
      failbackProviderFactory: failbackFactory as unknown as () => GlmProvider,
    });

    const consumeGenerator = async () => {
      for await (const _ of provider.sendQuery('hello', '/tmp')) {
        // consume
      }
    };

    // Auth error should re-throw, NOT invoke failback
    await expect(consumeGenerator()).rejects.toThrow('401 Unauthorized');
    expect(failbackFactory).not.toHaveBeenCalled();
  });

  test('refuses xAI before any network call and does not fail back', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockClear();
    const failbackFactory = mock(() => {
      throw new Error('failback must not run for an xAI refusal');
    });
    const provider = new GlmProvider({
      failbackProviderFactory: failbackFactory as unknown as () => GlmProvider,
    });
    await expect(async () => {
      for await (const _chunk of provider.sendQuery('hello', '/tmp', undefined, {
        model: 'x-ai/grok-4.7',
      })) {
        // consume
      }
    }).toThrow(/^openrouter_xai_refused/);
    expect(failbackFactory).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();

    registerCommunityProviders();
    expect(resolveProviderId('opr')).toBe('opr');
    expect(getProviderCapabilities('opr')).toEqual(getProviderCapabilities('glm'));
    expect(getProviderCapabilities('opr').execution).toEqual({
      text: true,
      repositoryRead: false,
      repositoryWrite: false,
      shell: false,
    });
    expect(getProviderCapabilities('glm').costControl).toBe(true);
    expect(getProviderCapabilities('glm').toolRestrictions).toBe(false);
  });

  test('emits usage.cost from the final stream chunk and fails closed when it is missing', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { model: 'z-ai/glm-5.2', choices: [{ delta: { content: 'hi' } }], usage: null };
        yield {
          model: 'z-ai/glm-5.2',
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, cost: 0.004 },
        };
      },
    }));
    const provider = new GlmProvider();
    const chunks = [];
    for await (const chunk of provider.sendQuery('cost', '/tmp', undefined, { model: 'glm-5.2' })) {
      chunks.push(chunk);
    }
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.004);
    expect(result && result.type === 'result' ? result.tokens?.cost : undefined).toBe(0.004);
    expect(result && result.type === 'result' ? result.isError : false).toBeFalsy();

    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'hi' } }], usage: null };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        };
      },
    }));
    const missingChunks = [];
    for await (const chunk of provider.sendQuery('missing', '/tmp', undefined, {
      model: 'glm-5.2',
    })) {
      missingChunks.push(chunk);
    }
    const missing = missingChunks.find(chunk => chunk.type === 'result');
    expect(missing && missing.type === 'result' ? missing.errorSubtype : undefined).toBe(
      'openrouter_cost_missing'
    );
    expect(missing && missing.type === 'result' ? missing.cost : undefined).toBeUndefined();
  });

  test('carries primary cost onto a failback result and does not emit an error result first', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' } }], usage: null };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.002 },
        };
        throw new Error('socket hang up');
      },
    }));
    const failbackSendQuery = mock(async function* () {
      yield { type: 'assistant' as const, content: 'fallback' };
      yield { type: 'result' as const, cost: 0.003 };
    });
    const failbackFactory = mock(() => ({ sendQuery: failbackSendQuery, getType: () => 'claude' }));
    const provider = new GlmProvider({
      failbackProviderFactory: failbackFactory as unknown as () => GlmProvider,
    });
    const chunks = [];
    for await (const chunk of provider.sendQuery('failback', '/tmp')) {
      chunks.push(chunk);
    }
    expect(chunks.some(chunk => chunk.type === 'result' && chunk.isError)).toBe(false);
    expect(chunks.some(chunk => chunk.type === 'provider_route')).toBe(true);
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.005);
  });

  test('emits known cost then rethrows when a stream fails after usage without failback', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: 'paid' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.002 },
        };
        throw new Error('socket hang up');
      },
    }));
    const provider = new GlmProvider();
    const chunks = [];
    let thrown: Error | undefined;
    try {
      for await (const chunk of provider.sendQuery('nofb', '/tmp')) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err as Error;
    }
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result && result.type === 'result' ? result.isError : undefined).toBe(true);
    expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.002);
    expect(thrown?.message).toContain('socket hang up');
  });

  test('does not fail back when the stream dies before its usage chunk', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockImplementationOnce(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' } }], usage: null };
        throw new Error('socket hang up');
      },
    }));
    const failbackFactory = mock(() => {
      throw new Error('failback must not run before usage');
    });
    const provider = new GlmProvider({
      failbackProviderFactory: failbackFactory as unknown as () => GlmProvider,
    });
    const chunks = [];
    for await (const chunk of provider.sendQuery('early', '/tmp', undefined, {
      nodeConfig: { maxBudgetUsd: 0.01 },
    })) {
      chunks.push(chunk);
    }
    expect(failbackFactory).not.toHaveBeenCalled();
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result && result.type === 'result' ? result.errorSubtype : undefined).toBe(
      'openrouter_cost_missing'
    );
    expect(result && result.type === 'result' ? result.cost : undefined).toBeUndefined();
  });

  test('returns error_max_budget_usd when the real cost is above the cap and allows an equal cap', async () => {
    process.env['GLM_API_KEY'] = 'sk-or-test';
    mockCreate.mockImplementation(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: 'over' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.004 },
        };
      },
    }));
    const provider = new GlmProvider();
    const over = [];
    for await (const chunk of provider.sendQuery('over', '/tmp', undefined, {
      nodeConfig: { maxBudgetUsd: 0.002 },
    })) {
      over.push(chunk);
    }
    const overResult = over.find(chunk => chunk.type === 'result');
    expect(overResult && overResult.type === 'result' ? overResult.errorSubtype : undefined).toBe(
      'error_max_budget_usd'
    );
    expect(overResult && overResult.type === 'result' ? overResult.cost : undefined).toBe(0.004);

    mockCreate.mockImplementation(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          choices: [{ delta: { content: 'equal' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.002 },
        };
      },
    }));
    const equal = [];
    for await (const chunk of provider.sendQuery('equal', '/tmp', undefined, {
      maxBudgetUsd: 0.002,
    })) {
      equal.push(chunk);
    }
    const equalResult = equal.find(chunk => chunk.type === 'result');
    expect(equalResult && equalResult.type === 'result' ? equalResult.isError : false).toBeFalsy();
    expect(equalResult && equalResult.type === 'result' ? equalResult.cost : undefined).toBe(0.002);
  });
});
