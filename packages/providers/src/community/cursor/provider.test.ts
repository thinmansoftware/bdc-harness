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

function streamLines(...events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

function assistantEvent(text: string): unknown {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function successEvent(result = ''): unknown {
  return { type: 'result', subtype: 'success', is_error: false, result };
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

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

describe('CursorAgentProvider', () => {
  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout: streamLines(assistantEvent('edited two files\nCOMPLETE\n'), successEvent()),
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
      '--force',
      '--trust',
      '--output-format',
      'stream-json',
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
      expect(last.servedModelId).toBeNull();
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({ stdout: streamLines(assistantEvent('ok'), successEvent()) }).child;
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
    const { child, writes } = fakeChild({
      stdout: streamLines(assistantEvent('```json\n{"verdict":"PASS"}\n```'), successEvent()),
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
    const { child } = fakeChild({ exitCode: 0, stdout: streamLines(successEvent()) });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('requests stream-json output while preserving all required flags', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
    expect(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'stream-json',
    ]);
    expect(argv).toEqual([
      'cursor-agent',
      '--print',
      '--force',
      '--trust',
      '--output-format',
      'stream-json',
      '--workspace',
      '/w',
      '--model',
      'grok-4.7-high',
    ]);
  });

  test('streams thinking, tool, and assistant progress and records the served model', async () => {
    const stdout = streamLines(
      { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High' },
      { type: 'thinking', subtype: 'delta', text: 'one' },
      { type: 'thinking', subtype: 'delta', text: 'two' },
      { type: 'thinking', subtype: 'completed' },
      { type: 'tool_call', subtype: 'started', call_id: 'call-1' },
      { type: 'tool_call', subtype: 'completed', call_id: 'call-1' },
      assistantEvent('final answer'),
      successEvent('result fallback must not be used')
    );
    const chunks = await collect(
      new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child }).sendQuery('go', '/w')
    );

    expect(chunks.filter(chunk => chunk.type === 'thinking')).toHaveLength(3);
    expect(chunks.filter(chunk => chunk.type === 'tool')).toHaveLength(2);
    expect(assistantText(chunks)).toBe('final answer');
    const result = chunks.at(-1);
    expect(result?.type === 'result' && result.servedModelId).toBe('Grok 4.7 256K High');
  });

  test('parses split, coalesced, and final unterminated stdout lines in order', async () => {
    const encoder = new TextEncoder();
    const first = JSON.stringify(assistantEvent('one'));
    const rest = `${JSON.stringify(assistantEvent('two'))}\n${JSON.stringify(successEvent())}`;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first.slice(0, 12)));
        controller.enqueue(encoder.encode(`${first.slice(12)}\n${rest}`));
        controller.close();
      },
    });
    const { child } = fakeChild();
    child.stdout = stdout;
    const chunks = await collect(new CursorAgentProvider({ spawn: () => child }).sendQuery('go', '/w'));
    expect(assistantText(chunks)).toBe('onetwo');
  });

  test('throws failed result messages and limits details to the last 400 characters', async () => {
    for (const event of [
      { type: 'result', subtype: 'error', is_error: true, result: 'model refused' },
      { type: 'result', subtype: 'cancelled', is_error: false, result: `${'x'.repeat(450)}tail` },
    ]) {
      const run = collect(
        new CursorAgentProvider({ spawn: () => fakeChild({ stdout: streamLines(event) }).child }).sendQuery(
          'go',
          '/w'
        )
      );
      if (event.result === 'model refused') {
        await expect(run).rejects.toThrow(/model refused/);
      } else {
        await expect(run).rejects.toThrow(new RegExp(`x{396}tail$`));
      }
    }
  });

  test('ignores malformed lines and falls back to a successful result string', async () => {
    const stdout = `${JSON.stringify({ type: 'thinking', text: 'work' })}\nnot json\n${JSON.stringify(
      successEvent('fallback text')
    )}\n`;
    const chunks = await collect(
      new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child }).sendQuery('go', '/w')
    );
    expect(assistantText(chunks)).toBe('fallback text');
    expect(chunks.some(chunk => chunk.type === 'thinking')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('result');
  });

  test('malformed output does not mask the empty-output guard', async () => {
    const stdout = `not json\n${JSON.stringify(successEvent())}\n`;
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    await expect(collect(provider.sendQuery('go', '/w'))).rejects.toThrow(/empty output/);
  });

  test('reports null served model with a reason when init model is absent', async () => {
    const chunks = await collect(
      new CursorAgentProvider({
        spawn: () => fakeChild({ stdout: streamLines(assistantEvent('ok'), successEvent()) }).child,
      }).sendQuery('go', '/w')
    );
    const result = chunks.at(-1);
    expect(result?.type === 'result' && result.servedModelId).toBeNull();
    expect(result?.type === 'result' && result.servedModelMissingReason).toBe(
      'cursor_stream_init_model_missing'
    );
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
