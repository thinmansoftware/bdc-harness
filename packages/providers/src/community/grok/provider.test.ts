import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';

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

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokAgentProvider } from './provider';
import { executeGrokTool } from './tools';
import { registerGrokAgentProvider } from './registration';
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
        };
      }
      return {
        model: 'deepseek/deepseek-v4.1-flash',
        choices: [{ message: { content: 'done', tool_calls: [] } }],
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

  test('community bootstrap includes grok', () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    expect(isRegisteredProvider('grok')).toBe(true);
    expect(isRegisteredProvider('opr')).toBe(true);
  });
});
