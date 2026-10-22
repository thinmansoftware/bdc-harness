import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';

const mockCreate = mock(async (_body: unknown, _options?: { signal?: AbortSignal }) => ({
  model: 'x-ai/grok-4.5',
  choices: [{ message: { content: 'ok', tool_calls: [] } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
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

openRouterMockSlots().grokCreate = (body, options) => mockCreate(body, options);

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokAgentProvider } from './provider';
import { executeGrokTool } from './tools';
import { registerGrokAgentProvider } from './registration';
import * as registry from '../../registry';
import {
  clearRegistry,
  isRegisteredProvider,
  getAgentProvider,
  getProviderCapabilities,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '../../registry';

describe('executeGrokTool', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'grok-tool-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test('write_file + read_file round trip', async () => {
    const w = await executeGrokTool(
      cwd,
      'write_file',
      JSON.stringify({ path: 'docs/a.md', content: 'hello\n' })
    );
    expect(w).toContain('OK wrote');
    const r = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: 'docs/a.md' }));
    expect(r).toBe('hello\n');
  });

  test('rejects path traversal', async () => {
    const r = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: '../outside.txt' }));
    expect(r).toContain('ERROR');
    expect(r.toLowerCase()).toContain('escape');
  });

  test('edit_file replaces string', async () => {
    writeFileSync(join(cwd, 'f.txt'), 'aaa bbb ccc', 'utf8');
    const e = await executeGrokTool(
      cwd,
      'edit_file',
      JSON.stringify({ path: 'f.txt', old_string: 'bbb', new_string: 'BBB' })
    );
    expect(e).toContain('OK edited');
    expect(readFileSync(join(cwd, 'f.txt'), 'utf8')).toBe('aaa BBB ccc');
  });

  test('list_dir lists files', async () => {
    writeFileSync(join(cwd, 'x.txt'), 'x', 'utf8');
    const out = await executeGrokTool(cwd, 'list_dir', JSON.stringify({ path: '.' }));
    expect(out).toContain('x.txt');
  });
});

describe('GrokAgentProvider', () => {
  const prevGlm = process.env.GLM_API_KEY;
  const prevOr = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (prevGlm === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = prevGlm;
    if (prevOr === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOr;
  });

  test('fails closed without API key', async () => {
    delete process.env.GLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const p = new GrokAgentProvider();
    await expect(async () => {
      const gen = p.sendQuery('hi', '/tmp', undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
      });
      await gen.next();
    }).toThrow(/GLM_API_KEY|OPENROUTER_API_KEY/);
  });

  test('fails closed without cwd', async () => {
    process.env.GLM_API_KEY = 'test-key';
    const p = new GrokAgentProvider();
    await expect(async () => {
      const gen = p.sendQuery('hi', '', undefined, { model: 'deepseek/deepseek-v4.1-flash' });
      await gen.next();
    }).toThrow(/cwd/);
  });

  test('refuses xAI models before any network call', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockClear();
    const p = new GrokAgentProvider();
    for (const model of ['x-ai/grok-4.7', 'grok-4.7']) {
      await expect(async () => {
        const gen = p.sendQuery('hi', '/tmp', undefined, { model });
        await gen.next();
      }).toThrow(/^openrouter_xai_refused/);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('requires an explicit model', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockClear();
    const p = new GrokAgentProvider();
    await expect(async () => {
      const gen = p.sendQuery('hi', '/tmp');
      await gen.next();
    }).toThrow(/^openrouter_model_required/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('yields tool chunks and forwards abortSignal', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'deepseek/deepseek-v4.1-flash',
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'missing.txt' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
        };
      }
      return {
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ message: { content: 'done', tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
    });

    const cwd = mkdtempSync(join(tmpdir(), 'grok-abort-'));
    const signal = new AbortController().signal;
    try {
      const provider = new GrokAgentProvider();
      const chunks: Array<{ type: string; toolName?: string; content?: string }> = [];
      for await (const chunk of provider.sendQuery('read a file', cwd, undefined, {
        abortSignal: signal,
        model: 'deepseek/deepseek-v4.1-flash',
      })) {
        chunks.push(chunk);
      }

      expect(chunks.some(chunk => chunk.type === 'tool' && chunk.toolName === 'read_file')).toBe(
        true
      );
      expect(
        chunks.some(
          chunk =>
            typeof chunk.content === 'string' && chunk.content.startsWith('[grok-agent tool]')
        )
      ).toBe(false);
      const firstOptions = mockCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
      expect(firstOptions?.signal).toBe(signal);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('getType and capabilities', () => {
    const p = new GrokAgentProvider();
    expect(p.getType()).toBe('openrouter');
    const caps = p.getCapabilities();
    expect(caps.structuredOutput).toBe(true);
    expect(caps.sessionResume).toBe(false);
    expect(caps.costControl).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
  });

  test('sums usage.cost onto the result chunk and fails closed when cost is missing', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'deepseek/deepseek-v4.1-flash',
          usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.001 },
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_read',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'missing.txt' }),
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { prompt_tokens: 12, completion_tokens: 6, cost: 0.002 },
        choices: [{ message: { content: 'done', tool_calls: [] } }],
      };
    });
    const cwd = mkdtempSync(join(tmpdir(), 'grok-cost-'));
    try {
      const provider = new GrokAgentProvider();
      const chunks = [];
      for await (const chunk of provider.sendQuery('sum', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
      })) {
        chunks.push(chunk);
      }
      const result = chunks.find(chunk => chunk.type === 'result');
      expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.003);
      expect(result && result.type === 'result' ? result.tokens?.cost : undefined).toBe(0.003);
      expect(result && result.type === 'result' ? result.isError : undefined).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      model: 'deepseek/deepseek-v4.1-flash',
      usage: { prompt_tokens: 3, completion_tokens: 1 },
      choices: [{ message: { content: 'no cost', tool_calls: [] } }],
    }));
    const missing = new GrokAgentProvider();
    const missingChunks = [];
    for await (const chunk of missing.sendQuery('missing', cwd, undefined, {
      model: 'deepseek/deepseek-v4.1-flash',
    })) {
      missingChunks.push(chunk);
    }
    const missingResult = missingChunks.find(chunk => chunk.type === 'result');
    expect(
      missingResult && missingResult.type === 'result' ? missingResult.isError : undefined
    ).toBe(true);
    expect(
      missingResult && missingResult.type === 'result' ? missingResult.errorSubtype : undefined
    ).toBe('openrouter_cost_missing');
    expect(missingResult && missingResult.type === 'result' ? missingResult.cost : undefined).toBe(
      undefined
    );
  });

  test('keeps the cost of a paid turn when a later completion throws', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'deepseek/deepseek-v4.1-flash',
          usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.002 },
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_list',
                    type: 'function',
                    function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                  },
                ],
              },
            },
          ],
        };
      }
      throw new Error('socket hang up');
    });
    const cwd = mkdtempSync(join(tmpdir(), 'grok-partial-'));
    const chunks = [];
    let thrown: Error | undefined;
    try {
      const provider = new GrokAgentProvider();
      for await (const chunk of provider.sendQuery('partial', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
      })) {
        chunks.push(chunk);
      }
    } catch (err) {
      thrown = err as Error;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const result = chunks.find(chunk => chunk.type === 'result');
    expect(result && result.type === 'result' ? result.isError : undefined).toBe(true);
    expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.002);
    expect(thrown?.message).toContain('socket hang up');
  });

  test('records metered cost and openrouter_cost_missing when a later usage is lost', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'deepseek/deepseek-v4.1-flash',
          usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.002 },
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_list',
                    type: 'function',
                    function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { prompt_tokens: 8, completion_tokens: 2 },
        choices: [{ message: { content: 'lost', tool_calls: [] } }],
      };
    });
    const cwd = mkdtempSync(join(tmpdir(), 'grok-lost-'));
    try {
      const provider = new GrokAgentProvider();
      const chunks = [];
      for await (const chunk of provider.sendQuery('lost', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
        maxBudgetUsd: 0.01,
      })) {
        chunks.push(chunk);
      }
      const result = chunks.find(chunk => chunk.type === 'result');
      expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.002);
      expect(result && result.type === 'result' ? result.errorSubtype : undefined).toBe(
        'openrouter_cost_missing'
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('stops the tool loop when running cost reaches the cap', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      model: 'deepseek/deepseek-v4.1-flash',
      usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0.001 },
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_list',
                type: 'function',
                function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
              },
            ],
          },
        },
      ],
    }));
    const cwd = mkdtempSync(join(tmpdir(), 'grok-cap-'));
    try {
      const provider = new GrokAgentProvider();
      const chunks = [];
      for await (const chunk of provider.sendQuery('cap', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
        nodeConfig: { maxBudgetUsd: 0.002 },
      })) {
        chunks.push(chunk);
      }
      expect(mockCreate.mock.calls.length).toBe(2);
      const result = chunks.find(chunk => chunk.type === 'result');
      expect(result && result.type === 'result' ? result.errorSubtype : undefined).toBe(
        'error_max_budget_usd'
      );
      expect(result && result.type === 'result' ? result.cost : undefined).toBe(0.002);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a read-only allowlist rejects writes and leaves the worktree unchanged', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    let calls = 0;
    mockCreate.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'deepseek/deepseek-v4.1-flash',
          usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 },
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_bash',
                    type: 'function',
                    function: {
                      name: 'bash',
                      arguments: JSON.stringify({ command: 'rm sentinel.txt' }),
                    },
                  },
                  {
                    id: 'call_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'evil.txt', content: 'nope' }),
                    },
                  },
                  {
                    id: 'call_edit',
                    type: 'function',
                    function: {
                      name: 'edit_file',
                      arguments: JSON.stringify({
                        path: 'sentinel.txt',
                        old_string: 'keep',
                        new_string: 'changed',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.001 },
        choices: [{ message: { content: 'blocked', tool_calls: [] } }],
      };
    });
    const cwd = mkdtempSync(join(tmpdir(), 'grok-ro-'));
    const sentinel = join(cwd, 'sentinel.txt');
    writeFileSync(sentinel, 'keep', 'utf8');
    const before = createHash('sha256').update(readFileSync(sentinel)).digest('hex');
    try {
      const provider = new GrokAgentProvider();
      const chunks = [];
      for await (const chunk of provider.sendQuery('readonly', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
        nodeConfig: { allowed_tools: ['read_file', 'list_dir'] },
      })) {
        chunks.push(chunk);
      }
      const advertised = (
        mockCreate.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> }
      ).tools?.map(tool => tool.function.name);
      expect(advertised).toEqual(['read_file', 'list_dir']);
      for (const name of ['bash', 'write_file', 'edit_file']) {
        expect(chunks.some(chunk => chunk.type === 'tool' && chunk.toolName === name)).toBe(true);
        expect(
          chunks.some(
            chunk =>
              chunk.type === 'tool_result' &&
              chunk.toolName === name &&
              chunk.toolOutput.includes('is not allowed')
          )
        ).toBe(true);
      }
      expect(createHash('sha256').update(readFileSync(sentinel)).digest('hex')).toBe(before);
      expect(existsSync(join(cwd, 'evil.txt'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('advertises all five tools when no allowlist or denylist is set', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      model: 'deepseek/deepseek-v4.1-flash',
      usage: { prompt_tokens: 2, completion_tokens: 1, cost: 0 },
      choices: [{ message: { content: 'done', tool_calls: [] } }],
    }));
    const cwd = mkdtempSync(join(tmpdir(), 'grok-all-'));
    try {
      const provider = new GrokAgentProvider();
      for await (const _chunk of provider.sendQuery('all', cwd, undefined, {
        model: 'deepseek/deepseek-v4.1-flash',
      })) {
        // drain
      }
      const advertised = (
        mockCreate.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> }
      ).tools?.map(tool => tool.function.name);
      expect(advertised).toEqual(['bash', 'read_file', 'write_file', 'edit_file', 'list_dir']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('registerGrokAgentProvider', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('registers grok id idempotently', () => {
    registerGrokAgentProvider();
    registerGrokAgentProvider();
    expect(isRegisteredProvider('grok')).toBe(true);
    expect(isRegisteredProvider('openrouter')).toBe(true);
    const p = getAgentProvider('grok');
    expect(p.getType()).toBe('openrouter');
    expect(getProviderCapabilities('grok').structuredOutput).toBe(true);
  });

  test('a thrown registration does not latch the idempotency flag', () => {
    const original = registry.registerProvider;
    let attempts = 0;
    const spy = spyOn(registry, 'registerProvider').mockImplementation(entry => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`Provider '${entry.id}' is already registered`);
      }
      return original(entry);
    });
    try {
      expect(() => registerGrokAgentProvider()).toThrow(/already registered/);
      registerGrokAgentProvider();
      expect(attempts).toBe(2);
      expect(isRegisteredProvider('openrouter')).toBe(true);
      expect(isRegisteredProvider('grok')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('community bootstrap includes grok', () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    expect(isRegisteredProvider('grok')).toBe(true);
    expect(isRegisteredProvider('opr')).toBe(true);
  });
});
