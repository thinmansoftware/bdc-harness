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

function stream(...events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
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
      stdout: stream(
        { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'edited two files\nCOMPLETE\n' }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'ignored fallback' }
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
      '--force',
      '--trust',
      '--workspace',
      '/work/tree',
      '--model',
      'gpt-5.6-sol-high',
      '--output-format',
      'stream-json',
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
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: stream(
          { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: 'ok' }
        ),
      }).child;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    const modelArg = (argv: string[]): string[] => {
      const index = argv.indexOf('--model');
      return argv.slice(index, index + 2);
    };
    expect(modelArg(argvs[0] ?? [])).toEqual(['--model', DEFAULT_CURSOR_AGENT_MODEL]);
    expect(modelArg(argvs[1] ?? [])).toEqual(['--model', 'cursor-grok-4.6-high']);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const { child, writes } = fakeChild({
      stdout: stream(
        { type: 'assistant', message: { content: [{ type: 'text', text: '{"verdict":"PASS"}' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '' }
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
    const { child } = fakeChild({
      exitCode: 0,
      stdout: stream({ type: 'result', subtype: 'success', is_error: false, result: '' }),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('requests stream-json explicitly', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
    expect(argv).toContain('--output-format');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  test('streams progress before exit and keeps thinking and tools out of final text', async () => {
    let resolveExit!: (code: number) => void;
    let exitResolved = false;
    const exited = new Promise<number>(resolve => {
      resolveExit = code => {
        exitResolved = true;
        resolve(code);
      };
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        const text = stream(
          { type: 'system', subtype: 'init', model: 'served-model' },
          { type: 'thinking', subtype: 'delta', text: 'one' },
          { type: 'thinking', subtype: 'delta', text: 'two' },
          { type: 'thinking', subtype: 'delta', text: 'three' },
          { type: 'tool_call', subtype: 'started' },
          { type: 'tool_call', subtype: 'completed' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: 'fallback' }
        );
        const bytes = new TextEncoder().encode(text);
        controller.enqueue(bytes.slice(0, 31));
        controller.enqueue(bytes.slice(31));
        controller.close();
      },
    });
    const child: CursorAgentChild = {
      stdin: { write: () => 0, end: () => undefined },
      stdout,
      stderr: new Response('').body,
      exited,
      kill: () => undefined,
    };
    const provider = new CursorAgentProvider({ spawn: () => child });
    const iterator = provider.sendQuery('hi', '/w');
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('thinking');
    const chunks: MessageChunk[] = first.value ? [first.value] : [];
    while (chunks.length < 6) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      chunks.push(next.value);
    }
    expect(exitResolved).toBe(false);
    expect(chunks.filter(chunk => chunk.type === 'thinking')).toHaveLength(3);
    expect(chunks.filter(chunk => chunk.type === 'tool')).toHaveLength(2);
    expect(assistantText(chunks)).toBe('answer');

    resolveExit(0);
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value?.type).toBe('result');
    expect((await iterator.next()).done).toBe(true);
  });

  test('handles result errors, malformed lines, fallback text, and missing model', async () => {
    const provider = new CursorAgentProvider({
      spawn: () =>
        fakeChild({
          stdout: `garbage\n${stream({ type: 'result', subtype: 'success', is_error: false, result: 'fallback text' })}`,
        }).child,
    });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('fallback text');
    const result = chunks.at(-1);
    expect(result?.type).toBe('result');
    if (result?.type === 'result') {
      expect(result.servedModelId).toBeNull();
      expect(result.servedModelMissingReason).toContain('no model');
    }

    const errorProvider = new CursorAgentProvider({
      spawn: () =>
        fakeChild({
          stdout: stream({
            type: 'result',
            subtype: 'error',
            is_error: true,
            result: 'model refused',
          }),
        }).child,
    });
    await expect(collect(errorProvider.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);
  });

  test('preserves earlier assistant text when a later assistant event is empty', async () => {
    const provider = new CursorAgentProvider({
      spawn: () =>
        fakeChild({
          stdout: stream(
            { type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } },
            { type: 'assistant', message: { content: [] } },
            { type: 'result', subtype: 'success', is_error: false, result: 'fallback' }
          ),
        }).child,
    });
    expect(assistantText(await collect(provider.sendQuery('hi', '/w')))).toBe('kept');
  });

  test('includes malformed stream lines in diagnostics', async () => {
    const provider = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: 'malformed diagnostic\n', exitCode: 1 }).child,
    });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/malformed diagnostic/);
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
