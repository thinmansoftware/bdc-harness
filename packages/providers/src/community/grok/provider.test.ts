import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';

const mockCreate = mock(
  async (_body: unknown, _options?: { signal?: AbortSignal }) =>
    ({
      model: 'x-ai/grok-4.5',
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
    }) as const
);

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

  test('reads only from the supplied run artifact directory', async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'grok-artifact-'));
    try {
      writeFileSync(join(artifactsDir, 'diff.patch'), 'safe diff', 'utf8');
      writeFileSync(join(cwd, 'private.txt'), 'outside artifact', 'utf8');
      expect(
        await executeGrokTool(cwd, 'read_artifact', JSON.stringify({ path: 'diff.patch' }), {
          artifactsDir,
        })
      ).toBe('safe diff');
      expect(
        await executeGrokTool(cwd, 'read_artifact', JSON.stringify({ path: '../private.txt' }), {
          artifactsDir,
        })
      ).toMatch(/^ERROR:/);
      expect(
        await executeGrokTool(cwd, 'read_artifact', JSON.stringify({ path: 'diff.patch' }))
      ).toBe('ERROR: artifact directory unavailable');
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
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
          usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 },
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
        usage: { prompt_tokens: 30, completion_tokens: 3, cost: 0.002 },
        choices: [{ message: { content: 'done', tool_calls: [] } }],
      };
    });

    const cwd = mkdtempSync(join(tmpdir(), 'grok-abort-'));
    const signal = new AbortController().signal;
    try {
      const provider = new GrokAgentProvider();
      const chunks: Array<{ type: string; toolName?: string; content?: string; cost?: number }> =
        [];
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
      expect(chunks.find(chunk => chunk.type === 'result')?.cost).toBe(0.003);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('read-only tool list rejects a model-requested write before execution', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      model: 'moonshotai/kimi-k3',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'proof.txt', content: 'changed' }),
                },
              },
            ],
          },
        },
      ],
    }));

    const cwd = mkdtempSync(join(tmpdir(), 'openrouter-readonly-'));
    try {
      const provider = new GrokAgentProvider();
      await expect(async () => {
        for await (const _chunk of provider.sendQuery('review', cwd, undefined, {
          model: 'moonshotai/kimi-k3',
          nodeConfig: { allowed_tools: ['read_file', 'list_dir'] },
        })) {
          // Drain until the provider rejects the prohibited tool call.
        }
      }).toThrow(/openrouter_tool_refused: write_file/);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const request = mockCreate.mock.calls[0]?.[0] as {
        tools?: Array<{ function: { name: string } }>;
      };
      expect(request.tools?.map(tool => tool.function.name)).toEqual(['read_file', 'list_dir']);
      expect(existsSync(join(cwd, 'proof.txt'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('budgeted node stops before a returned tool call when reported cost reaches cap', async () => {
    process.env.GLM_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockCreate.mockImplementation(async () => ({
      model: 'deepseek/deepseek-v4-pro-0813',
      usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0.15 },
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_write',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'proof.txt', content: 'changed' }),
                },
              },
            ],
          },
        },
      ],
    }));
    const cwd = mkdtempSync(join(tmpdir(), 'openrouter-budget-'));
    try {
      const provider = new GrokAgentProvider();
      const chunks = [];
      for await (const chunk of provider.sendQuery('build', cwd, undefined, {
        model: 'deepseek/deepseek-v4-pro-0813',
        maxBudgetUsd: 0.1,
      })) {
        chunks.push(chunk);
      }
      expect(chunks.at(-1)).toMatchObject({
        type: 'result',
        isError: true,
        errorSubtype: 'error_max_budget_usd',
        cost: 0.15,
      });
      expect(existsSync(join(cwd, 'proof.txt'))).toBe(false);
      const request = mockCreate.mock.calls[0]?.[0] as {
        max_tokens?: number;
        usage?: { include?: boolean };
      };
      expect(request.max_tokens).toBe(2048);
      expect(request.usage?.include).toBe(true);
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
