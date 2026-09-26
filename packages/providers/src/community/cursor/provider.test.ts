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
  /** When set, used instead of an already-resolved exitCode promise so a test
   *  can observe streaming before the child exits. */
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
    stdout: new Response(opts.stdout ?? '').body,
    stderr: new Response(opts.stderr ?? '').body,
    exited: opts.exited ?? Promise.resolve(opts.exitCode ?? 0),
    kill: (): void => undefined,
  };
  return { child, writes };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

const initEvent = (model?: string): string =>
  jsonLine({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    ...(model === undefined ? {} : { model }),
  });

const thinkingDelta = (text: string): string =>
  jsonLine({ type: 'thinking', subtype: 'delta', text, session_id: 'sess-1' });

const toolCallEvent = (subtype: 'started' | 'completed', command = 'ls -la'): string =>
  jsonLine({
    type: 'tool_call',
    subtype,
    call_id: `call-${subtype}`,
    tool_call: { shellToolCall: { args: { command } } },
  });

const assistantEvent = (...texts: string[]): string =>
  jsonLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: texts.map(text => ({ type: 'text', text })),
    },
    session_id: 'sess-1',
  });

const successResult = (result: string): string =>
  jsonLine({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: 'sess-1',
  });

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

function finalResult(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> {
  const last = chunks[chunks.length - 1];
  if (last?.type !== 'result') throw new Error('expected a terminal result chunk');
  return last;
}

describe('CursorAgentProvider', () => {
  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout: assistantEvent('edited two files\nCOMPLETE\n') + successResult('edited two files'),
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
    const last = finalResult(chunks);
    expect(last.stopReason).toBe('stop');
    expect(last.servedModelId).toBeNull();
    expect(last.servedModelMissingReason).toContain('no system/init event');
  });

  test('argv requests stream-json without --stream-partial-output', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
    const formatAt = argv.indexOf('--output-format');
    expect(formatAt).toBeGreaterThanOrEqual(0);
    expect(argv[formatAt + 1]).toBe('stream-json');
    for (const flag of ['--print', '--force', '--trust', '--workspace', '--model']) {
      expect(argv).toContain(flag);
    }
    expect(argv).not.toContain('--stream-partial-output');
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({ stdout: assistantEvent('ok') }).child;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    expect(argvs[0]?.slice(-4)).toEqual([
      '--model',
      DEFAULT_CURSOR_AGENT_MODEL,
      '--output-format',
      'stream-json',
    ]);
    expect(argvs[1]?.slice(-4)).toEqual([
      '--model',
      'cursor-grok-4.6-high',
      '--output-format',
      'stream-json',
    ]);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
  });

  test('yields thinking, tool_call, and assistant progress before the child exits', async () => {
    const gate = deferred<number>();
    const stdout =
      initEvent('Grok 4.7 256K High') +
      thinkingDelta('Listing the files') +
      thinkingDelta('Reading the spec') +
      thinkingDelta('Editing the file') +
      toolCallEvent('started') +
      toolCallEvent('completed') +
      assistantEvent('DONE') +
      successResult('DONE');
    const { child } = fakeChild({ stdout, exited: gate.promise });
    const provider = new CursorAgentProvider({ spawn: () => child });

    const gen = provider.sendQuery('build it', '/w');
    // Drain everything except the terminal result chunk, which cannot arrive
    // until the child exits.
    const progress: MessageChunk[] = [];
    for (let i = 0; i < 6; i += 1) {
      progress.push((await gen.next()).value as MessageChunk);
    }
    expect(progress.map(c => c.type)).toEqual([
      'thinking',
      'thinking',
      'thinking',
      'tool',
      'tool',
      'assistant',
    ]);
    // No chunk before exit is the terminal result.
    expect(progress.some(c => c.type === 'result')).toBe(false);

    // The generator is now parked on the child's exit.
    let resultResolved = false;
    const tail = gen.next().then(outcome => {
      resultResolved = true;
      return outcome;
    });
    await Promise.resolve();
    expect(resultResolved).toBe(false);

    gate.resolve(0);
    const outcome = await tail;
    expect(outcome.done).toBe(false);
    const last = outcome.value as Extract<MessageChunk, { type: 'result' }>;
    expect(last.type).toBe('result');
    expect((await gen.next()).done).toBe(true);

    // The node output is the assistant text only: no thinking text, and the
    // success result text is not duplicated on top of it.
    const all = [...progress, last];
    expect(assistantText(all)).toBe('DONE');
    expect(assistantText(all)).not.toContain('Listing the files');
  });

  test('concatenates assistant events and multi-part text in stream order; result never duplicates it', async () => {
    const stdout =
      assistantEvent('first ', 'second') +
      assistantEvent(' third') +
      successResult('first second third');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('first second third');
  });

  test('ignores non-text assistant parts safely', async () => {
    const stdout =
      jsonLine({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'x' },
            { type: 'text', text: 'kept' },
          ],
        },
      }) + successResult('kept');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('kept');
  });

  test('falls back to the success result text when no assistant event was seen', async () => {
    const stdout = initEvent() + successResult('final answer from result');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    // The fallback text must be DAG-consumable: the DAG accumulates node output
    // ($node_id.output) from assistant chunks only, so the provider synthesizes
    // one assistant chunk carrying the result text before the terminal result.
    expect(assistantText(chunks)).toBe('final answer from result');
    const assistantIdx = chunks.findIndex(c => c.type === 'assistant');
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(chunks.findLastIndex(c => c.type === 'result')).toBeGreaterThan(assistantIdx);
  });

  test('json_schema output parses the result-only fallback text', async () => {
    const stdout = initEvent() + successResult('{"verdict":"PASS"}');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(
      provider.sendQuery('judge it', '/w', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    expect(assistantText(chunks)).toBe('{"verdict":"PASS"}');
    expect(finalResult(chunks).structuredOutput).toEqual({ verdict: 'PASS' });
  });

  test('a stream-json error result throws with the bounded result tail', async () => {
    const long = `prefix-${'x'.repeat(500)}-model refused`;
    const stdout =
      thinkingDelta('trying') +
      jsonLine({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: long,
        session_id: 'sess-1',
      });
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const failure = await collect(provider.sendQuery('hi', '/w')).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('model refused');
    expect(message).not.toContain('prefix-');
    expect(message.length).toBeLessThan(500);
  });

  test('a success-subtype mismatch (is_error false but subtype not success) still throws', async () => {
    const stdout = jsonLine({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: false,
      result: 'partial failure detail',
      session_id: 'sess-1',
    });
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/partial failure detail/);
  });

  test('a non-JSON line between valid events is diagnostic-only; an unterminated final record still parses', async () => {
    const stdout =
      initEvent('Grok 4.7 256K High') +
      thinkingDelta('working') +
      'this is not json at all\n' +
      assistantEvent('kept text') +
      successResult('kept text').replace(/\n$/, ''); // no trailing newline
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('kept text');
    expect(finalResult(chunks).servedModelId).toBe('Grok 4.7 256K High');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const { child, writes } = fakeChild({
      stdout: assistantEvent('```json\n{"verdict":"PASS"}\n```'),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(
      provider.sendQuery('judge it', '/w', undefined, {
        systemPrompt: 'You are strict.',
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      })
    );
    expect(writes.join('')).toMatch(/^You are strict\.\n\njudge it\n\nRespond with valid JSON/);
    const last = finalResult(chunks);
    expect(last.structuredOutput).toEqual({ verdict: 'PASS' });
  });

  test('fails closed without cwd', async () => {
    const provider = new CursorAgentProvider({ spawn: () => fakeChild().child });
    await expect(async () => {
      const gen = provider.sendQuery('hi', '');
      await gen.next();
    }).toThrow(/cwd/);
  });

  test('a non-zero exit is a thrown error carrying the stderr tail, never a silent result', async () => {
    const { child } = fakeChild({
      exitCode: 1,
      stderr: 'Authentication required. Please run',
      stdout: thinkingDelta('progress before the failure'),
    });
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

  test('a success result with no assistant text and empty result text is still the empty-output error', async () => {
    const { child } = fakeChild({ exitCode: 0, stdout: initEvent() + successResult('') });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('a stream of only blank and malformed lines is the empty-output error, never a crash', async () => {
    const { child } = fakeChild({ exitCode: 0, stdout: '\nnot json\n   \n{also not json\n' });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('serves the model id from the init event', async () => {
    const stdout = initEvent('Grok 4.7 256K High') + assistantEvent('ok') + successResult('ok');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(finalResult(chunks).servedModelId).toBe('Grok 4.7 256K High');
  });

  test('an init event without a model field reports null plus a reason', async () => {
    const stdout = initEvent() + assistantEvent('ok');
    const provider = new CursorAgentProvider({ spawn: () => fakeChild({ stdout }).child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = finalResult(chunks);
    expect(last.servedModelId).toBeNull();
    expect(last.servedModelMissingReason).toContain('no model field');
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
