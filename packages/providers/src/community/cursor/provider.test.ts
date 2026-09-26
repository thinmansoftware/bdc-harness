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
  stdoutStream?: ReadableStream<Uint8Array>;
  exited?: Promise<number>;
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
    stdout: opts.stdoutStream ?? new Response(opts.stdout ?? '').body,
    stderr: new Response(opts.stderr ?? '').body,
    exited: opts.exited ?? Promise.resolve(opts.exitCode ?? 0),
    kill: (): void => undefined,
  };
  return { child, writes };
}

function jsonl(events: unknown[], trailingNewline = true): string {
  const body = events.map(event => JSON.stringify(event)).join('\n');
  return trailingNewline ? `${body}\n` : body;
}

function assistantEvent(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function successResult(result: string): Record<string, unknown> {
  return { type: 'result', subtype: 'success', is_error: false, result };
}

function initEvent(model: string): Record<string, unknown> {
  return { type: 'system', subtype: 'init', model };
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
      stdout: jsonl([
        assistantEvent('edited two files\nCOMPLETE\n'),
        successResult('edited two files\nCOMPLETE\n'),
      ]),
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
      expect(last.servedModelId).toBeNull();
      expect(last.servedModelMissingReason).toBe(
        'cursor-agent stream-json init event did not include a model'
      );
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: jsonl([assistantEvent('ok'), successResult('ok')]),
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
    // Provider-internal streaming: the text this test cares about arrives inside a
    // stream-json assistant event and is echoed by the result event.
    const { child, writes } = fakeChild({
      stdout: jsonl([assistantEvent('```json\n{"verdict":"PASS"}\n```'), successResult('')]),
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

  test('argv-requests-stream-json', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
    const formatAt = argv.indexOf('--output-format');
    expect(formatAt).toBeGreaterThan(-1);
    expect(argv[formatAt + 1]).toBe('stream-json');
    expect(argv).toEqual([
      'cursor-agent',
      '--print',
      '--output-format',
      'stream-json',
      '--force',
      '--trust',
      '--workspace',
      '/w',
      '--model',
      'grok-4.7-high',
    ]);
  });

  test('progress-is-yielded-before-exit', async () => {
    let resolveExited: (code: number) => void = () => undefined;
    let exitResolved = false;
    const exited = new Promise<number>(resolve => {
      resolveExited = (code: number): void => {
        exitResolved = true;
        resolve(code);
      };
    });
    const thinking = ['Listing the files', ' in the', ' directory'];
    const assistant = 'I will list the files.';
    const payload = jsonl(
      [
        initEvent('Grok 4.7 256K High'),
        { type: 'thinking', subtype: 'delta', text: thinking[0] },
        { type: 'thinking', subtype: 'delta', text: thinking[1] },
        { type: 'thinking', subtype: 'delta', text: thinking[2] },
        {
          type: 'tool_call',
          subtype: 'started',
          call_id: 'call-1',
          tool_call: { shellToolCall: { args: { command: 'ls -la' } } },
        },
        {
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'call-1',
          tool_call: { shellToolCall: { result: 'ok' } },
        },
        assistantEvent(assistant),
        successResult(`${thinking.join('')} THEN ${assistant} DONE`),
      ],
      // Deliberately unterminated: the last record arrives with no newline.
      false
    );
    const bytes = new TextEncoder().encode(payload);
    // Split mid-record so the buffer must reassemble one JSON line.
    const splitAt = 11;
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, splitAt));
        controller.enqueue(bytes.subarray(splitAt));
        controller.close();
      },
    });
    const { child } = fakeChild({ stdoutStream, exited });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const gen = provider.sendQuery('list files', '/w');
    const seen: MessageChunk[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.type === 'assistant') break;
    }
    expect(exitResolved).toBe(false);
    expect(seen.filter(chunk => chunk.type === 'thinking')).toHaveLength(3);
    expect(seen.filter(chunk => chunk.type === 'tool')).toHaveLength(2);
    expect(seen.filter(chunk => chunk.type === 'assistant')).toHaveLength(1);
    resolveExited(0);
    const rest: MessageChunk[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      rest.push(next.value);
    }
    const chunks = [...seen, ...rest];
    expect(assistantText(chunks)).toBe(assistant);
    expect(assistantText(chunks)).not.toContain('Listing the files');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
  });

  test('result-text-is-the-fallback-when-no-assistant-text', async () => {
    const { child } = fakeChild({
      stdout: jsonl([successResult('fallback body only')]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(chunks[chunks.length - 1]?.type).toBe('result');
    expect(chunks.some(chunk => chunk.type === 'assistant')).toBe(false);
  });

  test('error-result-throws', async () => {
    const { child } = fakeChild({
      stdout: jsonl([
        { type: 'result', subtype: 'error', is_error: true, result: 'model refused' },
      ]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);
  });

  test('error-result-throws-with-only-the-last-400-characters', async () => {
    const huge = `${'x'.repeat(1000)}TAIL_MARKER`;
    const { child } = fakeChild({
      stdout: jsonl([{ type: 'result', subtype: 'error', is_error: true, result: huge }]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    let message = '';
    try {
      await collect(provider.sendQuery('hi', '/w'));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('TAIL_MARKER');
    expect(message).not.toContain('x'.repeat(700));
  });

  test('a non-success subtype throws even when is_error is absent', async () => {
    const { child } = fakeChild({
      stdout: jsonl([{ type: 'result', subtype: 'error_during_execution', result: 'boom' }]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/boom/);
  });

  test('empty-and-garbage-guards', async () => {
    const empty = fakeChild({ stdout: jsonl([successResult('   ')]) });
    const emptyProvider = new CursorAgentProvider({ spawn: () => empty.child });
    await expect(collect(emptyProvider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);

    const kept = 'kept text';
    const garbage = fakeChild({
      stdout: [
        JSON.stringify(assistantEvent(kept)),
        'this is not json',
        JSON.stringify(successResult(kept)),
      ].join('\n'),
    });
    const garbageProvider = new CursorAgentProvider({ spawn: () => garbage.child });
    const chunks = await collect(garbageProvider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe(kept);
    expect(chunks[chunks.length - 1]?.type).toBe('result');

    // Diagnostic text stays bounded: a huge garbage line cannot bloat the error.
    const blob = fakeChild({
      stdout: ['y'.repeat(10_000), JSON.stringify(successResult('   '))].join('\n'),
    });
    const blobProvider = new CursorAgentProvider({ spawn: () => blob.child });
    let message = '';
    try {
      await collect(blobProvider.sendQuery('hi', '/w'));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('empty output');
    expect(message).not.toContain('y'.repeat(500));
  });

  test('served-model-recorded', async () => {
    const { child } = fakeChild({
      stdout: jsonl(
        [initEvent('Grok 4.7 256K High'), assistantEvent('DONE'), successResult('DONE')],
        false
      ),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
      expect(last.servedModelMissingReason).toBeUndefined();
    }
  });

  test('missing init event reports a null served model with the contract reason', async () => {
    const { child } = fakeChild({
      stdout: jsonl([assistantEvent('DONE'), successResult('DONE')]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBeNull();
      expect(last.servedModelMissingReason).toBe(
        'cursor-agent stream-json init event did not include a model'
      );
    }
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
