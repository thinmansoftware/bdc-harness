import { describe, expect, test, beforeEach } from 'bun:test';
import type { MessageChunk } from '../../types';
import {
  buildCursorAgentArgv,
  CursorAgentProvider,
  DEFAULT_CURSOR_AGENT_MODEL,
  type CursorAgentChild,
  type CursorAgentSpawn,
} from './provider';
import { registerCursorAgentProvider } from './registration';
import {
  clearRegistry,
  getAgentProvider,
  getProviderCapabilities,
  isRegisteredProvider,
  registerBuiltinProviders,
  registerCommunityProviders,
} from '../../registry';

// Hermetic: a fake spawn seam only. No real cursor-agent binary, credential,
// or network call is touched (same injection style as the Overseer's
// ReviewModelSpawn in pr-review-evaluator.ts).
interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakeChild(opts: FakeChildOptions = {}): { child: CursorAgentChild; writes: string[] } {
  const writes: string[] = [];
  const child: CursorAgentChild = {
    stdin: {
      write: (chunk: string): number => {
        writes.push(chunk);
        return chunk.length;
      },
      end: (): void => undefined,
    },
    stdout: new Response(opts.stdout ?? '').body,
    stderr: new Response(opts.stderr ?? '').body,
    exited: Promise.resolve(opts.exitCode ?? 0),
    kill: (): void => undefined,
  };
  return { child, writes };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

/** Build a stream-json stdout payload: one JSON object per line. */
function jsonl(...events: unknown[]): string {
  return events.map(e => `${JSON.stringify(e)}\n`).join('');
}

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

describe('CursorAgentProvider', () => {
  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', session_id: 's1' },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'edited two files\nCOMPLETE\n' }],
          },
          session_id: 's1',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'edited two files\nCOMPLETE\n',
          session_id: 's1',
        }
      ),
    });
    const spawn: CursorAgentSpawn = (argv, options) => {
      seenArgv = argv;
      seenCwd = options.cwd;
      return child;
    };
    const provider = new CursorAgentProvider({
      assistantConfig: { model: 'gpt-5.6-sol-high' },
      spawn,
    });

    const prompt = `implement the WO ${'p'.repeat(200_000)}`;
    const chunks = await collect(provider.sendQuery(prompt, '/work/tree'));

    expect(seenArgv).toEqual([
      'cursor-agent',
      '--print',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      '--workspace',
      '/work/tree',
      '--model',
      'gpt-5.6-sol-high',
    ]);
    expect(seenCwd).toBe('/work/tree');
    // The prompt reaches the child on stdin and never as an argv element.
    expect(writes.join('')).toContain('implement the WO');
    for (const arg of seenArgv) expect(arg).not.toContain('implement the WO');

    expect(assistantText(chunks)).toBe('edited two files\nCOMPLETE\n');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.stopReason).toBe('stop');
      // Served model captured from the stream-json init event.
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: jsonl({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
      }).child;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    expect(argvs[0]?.slice(-2)).toEqual(['--model', DEFAULT_CURSOR_AGENT_MODEL]);
    expect(argvs[1]?.slice(-2)).toEqual(['--model', 'cursor-grok-4.6-high']);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const fenced = '```json\n{"verdict":"PASS"}\n```';
    const { child, writes } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', model: 'grok-4.7-high' },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: fenced }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: fenced }
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(
      provider.sendQuery('judge it', '/w', undefined, {
        systemPrompt: 'You are strict.',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    expect(writes.join('')).toMatch(/^You are strict\.\n\njudge it\n\nRespond with valid JSON/);
    const last = chunks[chunks.length - 1];
    expect(last?.type === 'result' && last.structuredOutput).toEqual({ verdict: 'PASS' });
  });

  test('fails closed without cwd', async () => {
    const provider = new CursorAgentProvider({ spawn: () => fakeChild().child });
    await expect(async () => {
      const gen = provider.sendQuery('hi', '');
      await gen.next();
    }).toThrow(/cwd/);
  });

  test('a non-zero exit is a thrown error carrying the stderr tail, never a silent result', async () => {
    const { child } = fakeChild({ exitCode: 1, stderr: 'Authentication required. Please run' });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exited 1.*Authentication required/
    );
  });

  test('exit 0 with empty output (workspace-trust no-op) is a failure, not success', async () => {
    const { child } = fakeChild({ exitCode: 0, stdout: '   \n' });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('getType and capabilities', () => {
    const provider = new CursorAgentProvider({ spawn: () => fakeChild().child });
    expect(provider.getType()).toBe('cursor');
    const caps = provider.getCapabilities();
    expect(caps.execution).toEqual({
      text: true,
      repositoryRead: true,
      repositoryWrite: true,
      shell: true,
    });
    expect(caps.sessionResume).toBe(false);
  });
});

describe('CursorAgentProvider stream-json', () => {
  test('stream-json: JSON-line streaming yields assistant text and captures the init model', async () => {
    const { child } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', session_id: 's1' },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'part one ' }] },
          session_id: 's1',
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'part two' }] },
          session_id: 's1',
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'part one part two' }
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));

    expect(assistantText(chunks)).toBe('part one part two');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.stopReason).toBe('stop');
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
    }
  });

  test('stream-json: progress events (thinking deltas, tool calls) surface as chunks', async () => {
    const { child } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', model: 'grok-4.7-high' },
        { type: 'thinking', subtype: 'delta', text: 'planning the edit', session_id: 's1' },
        { type: 'thinking', subtype: 'completed', session_id: 's1' },
        {
          type: 'tool_call',
          subtype: 'started',
          call_id: 'call-1',
          tool_call: { shellToolCall: { args: { command: 'ls' }, toolCallId: 'call-1' } },
        },
        {
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'call-1',
          tool_call: {
            shellToolCall: {
              args: { command: 'ls' },
              result: { success: { exitCode: 0 } },
              toolCallId: 'call-1',
            },
          },
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'done' }
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));

    expect(chunks.some(c => c.type === 'thinking' && c.content === 'planning the edit')).toBe(true);
    expect(
      chunks.some(c => c.type === 'tool' && c.toolName === 'shell' && c.toolCallId === 'call-1')
    ).toBe(true);
    expect(
      chunks.some(
        c =>
          c.type === 'tool_result' &&
          c.toolName === 'shell' &&
          c.toolOutput.includes('"exitCode":0')
      )
    ).toBe(true);
  });

  test('stream-json: malformed lines are skipped without dropping valid events', async () => {
    const { child } = fakeChild({
      stdout: [
        'not json at all',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"survived"}}</truncated',
        jsonl(
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'survived' }] },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'survived' }
        ),
        '{"also": "not a known event"',
        '',
      ].join('\n'),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));

    expect(assistantText(chunks)).toBe('survived');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') expect(last.stopReason).toBe('stop');
  });

  test('stream-json: a result error becomes an isError result chunk, never a silent success', async () => {
    const { child } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', model: 'grok-4.7-high' },
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'tool exploded',
        }
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));

    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.isError).toBe(true);
      expect(last.errorSubtype).toBe('error_during_execution');
      expect(last.errors).toEqual(['tool exploded']);
      expect(last.stopReason).toBeUndefined();
    }
  });

  test('stream-json: falls back to the result event text when no assistant text streamed', async () => {
    const { child } = fakeChild({
      stdout: jsonl(
        { type: 'system', subtype: 'init', session_id: 's1' },
        { type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"PASS"}' }
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(
      provider.sendQuery('judge it', '/w', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );

    expect(assistantText(chunks)).toBe('{"verdict":"PASS"}');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.structuredOutput).toEqual({ verdict: 'PASS' });
      // Init event carried no model: report null WITH a machine-readable reason.
      expect(last.servedModelId).toBeNull();
      expect(last.servedModelMissingReason).toContain('init-event');
    }
  });
});

describe('registerCursorAgentProvider', () => {
  beforeEach(() => {
    clearRegistry();
  });

  test('registers cursor id idempotently', () => {
    registerCursorAgentProvider();
    registerCursorAgentProvider();
    expect(isRegisteredProvider('cursor')).toBe(true);
    expect(getAgentProvider('cursor').getType()).toBe('cursor');
    expect(getProviderCapabilities('cursor').execution.shell).toBe(true);
  });

  test('community bootstrap includes cursor alongside grok', () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    expect(isRegisteredProvider('cursor')).toBe(true);
    expect(isRegisteredProvider('grok')).toBe(true);
    expect(isRegisteredProvider('openrouter')).toBe(true);
  });
});
