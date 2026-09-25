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

/**
 * A child whose stdout is emitted in explicit chunks and whose exit promise the
 * test resolves manually. Used to prove progress chunks are observed BEFORE the
 * child exit resolves, not merely ordered that way in a fully buffered stream.
 */
function manualChild(
  chunks: string[],
  opts: { exitCode?: number } = {}
): {
  child: CursorAgentChild;
  writes: string[];
  resolveExit(code?: number): void;
} {
  const writes: string[] = [];
  const encoder = new TextEncoder();
  let exitResolve: (code: number) => void = () => undefined;
  const exited = new Promise<number>(resolve => {
    exitResolve = resolve;
  });
  const child: CursorAgentChild = {
    stdin: {
      write: (chunk: string): number => {
        writes.push(chunk);
        return chunk.length;
      },
      end: (): void => undefined,
    },
    stdout: new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // Keep the stream open until exit resolves: EOF is not a signal.
        void exited.then(() => controller.close());
      },
    }),
    stderr: new Response('').body,
    exited,
    kill: (): void => undefined,
  };
  return {
    child,
    writes,
    resolveExit: (code?: number): void => exitResolve(code ?? opts.exitCode ?? 0),
  };
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

function streamLine(event: Record<string, unknown>): string {
  return JSON.stringify(event) + '\n';
}

function initEvent(model = 'Grok 4.7 256K High'): Record<string, unknown> {
  return { type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/w', model };
}

function assistantEvent(text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function successResultEvent(result: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1234,
    is_error: false,
    result,
  };
}

describe('CursorAgentProvider', () => {
  test('argv-requests-stream-json: --output-format immediately followed by stream-json', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
    const i = argv.indexOf('--output-format');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('stream-json');
    expect(argv).toEqual([
      'cursor-agent',
      '--print',
      '--force',
      '--trust',
      '--workspace',
      '/w',
      '--model',
      'grok-4.7-high',
      '--output-format',
      'stream-json',
    ]);
  });

  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout:
        streamLine(assistantEvent('edited two files\nCOMPLETE\n')) +
        streamLine(successResultEvent('edited two files\nCOMPLETE\n')),
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
    }
  });

  test('progress-is-yielded-before-exit: thinking/tool/assistant chunks arrive while exit is unresolved', async () => {
    const { child, resolveExit } = manualChild([
      streamLine(initEvent()),
      streamLine({ type: 'thinking', subtype: 'delta', text: 'Listing the files in' }),
      streamLine({ type: 'thinking', subtype: 'delta', text: 'the worktree.' }),
      streamLine({ type: 'thinking', subtype: 'completed' }),
      streamLine({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c1',
        tool_call: { shellToolCall: { args: { command: 'ls -la' } } },
      }),
      streamLine({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c1',
        tool_call: { shellToolCall: { args: { command: 'ls -la' }, output: 'file list' } },
      }),
      streamLine(assistantEvent('DONE build')),
      streamLine(successResultEvent('DONE build')),
    ]);

    const provider = new CursorAgentProvider({ spawn: () => child });
    const gen = provider.sendQuery('hi', '/w');
    const observed: MessageChunk[] = [];
    let exitResolved = false;
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        observed.push(next.value);
        // 3 thinking + tool + tool_result + assistant = 6 chunks; the success
        // result line yields no chunk, so the stream is not drained yet.
        if (observed.length >= 6) break;
      }
      // Nothing has resolved the child exit yet: every chunk above was yielded
      // while the child was still running (that is what keeps the idle timer alive).
      exitResolved = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);
      expect(exitResolved).toBe(false);
      // Now let the child exit and drain the remaining stream through the same
      // generator (the success result line, then the final result chunk).
      resolveExit(0);
      for (;;) {
        const next = await gen.next();
        if (next.done) break;
        observed.push(next.value);
      }
    } finally {
      resolveExit(0);
      await gen.return(undefined as never).catch(() => undefined);
    }

    const thinking = observed.filter(c => c.type === 'thinking');
    const tools = observed.filter(c => c.type === 'tool');
    const toolResults = observed.filter(c => c.type === 'tool_result');
    const assistants = observed.filter(c => c.type === 'assistant');
    // Three thinking events -> three thinking chunks (one per event, delta or not).
    expect(thinking.length).toBe(3);
    // One tool_call started -> one tool chunk; one completed -> one tool_result chunk.
    expect(tools.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect(assistants.length).toBe(1);
    const result = observed[observed.length - 1];
    expect(result?.type).toBe('result');
    // Final node text is the assistant text ONLY -- no thinking or tool payload text.
    const text = assistantText(observed);
    expect(text).toBe('DONE build');
    expect(text).not.toContain('Listing the files');
    expect(text).not.toContain('ls -la');
    expect(text).not.toContain('file list');
  });

  test('error-result-throws: is_error result with result text is a thrown error', async () => {
    const { child } = fakeChild({
      stdout:
        streamLine(initEvent()) +
        streamLine(assistantEvent('partial work')) +
        streamLine({ type: 'result', subtype: 'error', is_error: true, result: 'model refused' }),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);
  });

  test('error-result-throws: non-success subtype is a thrown error even without is_error', async () => {
    const { child } = fakeChild({
      stdout: streamLine({
        type: 'result',
        subtype: 'interrupted',
        is_error: false,
        result: 'stopped',
      }),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/stopped/);
  });

  test('error-result-throws: a result event with an OMITTED subtype is a thrown error, not success', async () => {
    const { child } = fakeChild({
      stdout: streamLine({
        type: 'result',
        is_error: false,
        result: 'looks fine but has no subtype',
      }),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/invalid subtype/);
  });

  test('error-result-throws: a result event with a non-string subtype is a thrown error', async () => {
    const { child } = fakeChild({
      stdout: streamLine({ type: 'result', subtype: 7, is_error: false, result: 'bad shape' }),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/invalid subtype/);
  });

  test('empty-and-garbage-guards: success with no assistant text and empty result still fails closed', async () => {
    const { child } = fakeChild({
      stdout: streamLine(initEvent()) + streamLine(successResultEvent('')),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('empty-and-garbage-guards: a malformed line is skipped and never reaches node output', async () => {
    const { child } = fakeChild({
      stdout:
        streamLine(initEvent()) +
        'not json at all\n' +
        streamLine(assistantEvent('real answer')) +
        '<<<also not json>>>\n' +
        streamLine(successResultEvent('real answer')),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const text = assistantText(chunks);
    expect(text).toBe('real answer');
    expect(text).not.toContain('not json at all');
    expect(text).not.toContain('also not json');
    expect(chunks[chunks.length - 1]?.type).toBe('result');
  });

  test('served-model-recorded: init event model becomes servedModelId', async () => {
    const { child } = fakeChild({
      stdout:
        streamLine(initEvent('Grok 4.7 256K High')) +
        streamLine(assistantEvent('ok')) +
        streamLine(successResultEvent('ok')),
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

  test('served-model-recorded: no init model leaves servedModelId null with a missing reason', async () => {
    const { child } = fakeChild({
      stdout: streamLine(assistantEvent('ok')) + streamLine(successResultEvent('ok')),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = chunks[chunks.length - 1];
    expect(last?.type === 'result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBeNull();
      expect(typeof last.servedModelMissingReason).toBe('string');
    }
  });

  test('a JSON line split across stdout chunks is parsed once; a tail line without a final newline still lands', async () => {
    const { child, resolveExit } = manualChild([
      // Three separate stdout chunks for ONE assistant line: the line is only
      // complete after the third fragment, so the framing must buffer.
      '{"type":"ass',
      'istant","message":{"role":"assistant","cont',
      'ent":[{"type":"text","text":"split line ok"}]}}\n',
      streamLine(successResultEvent('split line ok')),
    ]);
    const provider = new CursorAgentProvider({ spawn: () => child });
    resolveExit(0);
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('split line ok');
  });

  test('a final valid JSON object without a terminating newline is processed at EOF', async () => {
    const { child } = fakeChild({
      stdout:
        streamLine(assistantEvent('')) +
        '{"type":"result","subtype":"success","is_error":false,"result":"tail result"}',
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    // No assistant text was seen, so the successful result text is the fallback.
    expect(assistantText(chunks)).toBe('tail result');
    expect(chunks[chunks.length - 1]?.type).toBe('result');
  });

  test('result text is the fallback node text when no assistant text was emitted', async () => {
    const { child } = fakeChild({
      stdout: streamLine(successResultEvent('fallback answer')),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    // The fallback MUST be emitted as an assistant chunk: the DAG executor
    // accumulates node output only from assistant chunks, so a result-only
    // stream would otherwise produce an empty $node_id.output.
    expect(assistantText(chunks)).toBe('fallback answer');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.structuredOutput).toBeUndefined();
    }
    // Re-run with json_schema to prove the fallback feeds structured parsing.
    const { child: child2 } = fakeChild({
      stdout: streamLine(successResultEvent('```json\n{"verdict":"PASS"}\n```')),
    });
    const provider2 = new CursorAgentProvider({ spawn: () => child2 });
    const chunks2 = await collect(
      provider2.sendQuery('hi', '/w', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    const last2 = chunks2[chunks2.length - 1];
    expect(last2?.type === 'result' && last2.structuredOutput).toEqual({ verdict: 'PASS' });
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: streamLine(assistantEvent('ok')) + streamLine(successResultEvent('ok')),
      }).child;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    expect(argvs[0]?.slice(-2)).toEqual(['--output-format', 'stream-json']);
    expect(argvs[1]?.slice(-4)).toEqual([
      '--model',
      'cursor-grok-4.6-high',
      '--output-format',
      'stream-json',
    ]);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const { child, writes } = fakeChild({
      stdout:
        streamLine(assistantEvent('```json\n{"verdict":"PASS"}\n```')) +
        streamLine(successResultEvent('```json\n{"verdict":"PASS"}\n```')),
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
