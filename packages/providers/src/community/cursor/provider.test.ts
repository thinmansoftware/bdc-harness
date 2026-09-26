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
  /** When true, the exit promise stays unresolved until releaseExit is called,
   *  so tests can assert progress is yielded BEFORE process exit. */
  holdExit?: boolean;
}

interface FakeChildResult {
  child: CursorAgentChild;
  writes: string[];
  releaseExit: () => void;
}

function fakeChild(opts: FakeChildOptions = {}): FakeChildResult {
  const writes: string[] = [];
  let releaseExit = (): void => undefined;
  const exitPromise = new Promise<number>(resolve => {
    if (opts.holdExit) {
      releaseExit = (): void => resolve(opts.exitCode ?? 0);
    } else {
      resolve(opts.exitCode ?? 0);
    }
  });
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
    exited: exitPromise,
    kill: (): void => undefined,
  };
  return { child, writes, releaseExit };
}

/**
 * A spawn double that emits its stdout as a sequence of chunks, giving tests
 * control over how JSON records are framed across stream chunk boundaries.
 * Chunks are written lazily as the reader consumes them.
 */
function chunkedStream(text: string, chunkSizes: number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) {
        controller.close();
        return;
      }
      const size = chunkSizes[index % chunkSizes.length] ?? text.length - offset;
      index++;
      const end = Math.min(offset + size, text.length);
      controller.enqueue(encoder.encode(text.slice(offset, end)));
      offset = end;
    },
  });
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of gen) chunks.push(chunk);
  return chunks;
}

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

const initEvent = (model = 'Grok 4.7 256K High'): string =>
  JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/w', model });
const thinkingEvent = (text: string): string =>
  JSON.stringify({ type: 'thinking', subtype: 'delta', text, session_id: 's' });
const toolStartedEvent = (command: string): string =>
  JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'call-1',
    tool_call: { shellToolCall: { args: { command } } },
  });
const toolCompletedEvent = (command: string): string =>
  JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'call-1',
    tool_call: { shellToolCall: { args: { command } } },
  });
const assistantEvent = (text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: 's',
  });
const successResult = (result = 'done'): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    is_error: false,
    result,
    session_id: 's',
  });

describe('CursorAgentProvider', () => {
  test('Test 1: argv requests stream-json', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/w');
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
    // stream-json immediately follows --output-format
    const idx = argv.indexOf('--output-format');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe('stream-json');
    // No per-token deltas requested.
    expect(argv).not.toContain('--stream-partial-output');
  });

  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout: [initEvent('gpt-5.6-sol-high'), assistantEvent('edited two files\nCOMPLETE\n'), successResult()].join(
        '\n'
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

    expect(seenArgv.slice(-2)).toEqual(['--model', 'gpt-5.6-sol-high']);
    expect(seenArgv).toContain('--workspace');
    expect(seenCwd).toBe('/work/tree');
    // The prompt reaches the child on stdin and never as an argv element.
    expect(writes.join('')).toContain('implement the WO');
    for (const arg of seenArgv) expect(arg).not.toContain('implement the WO');

    expect(assistantText(chunks)).toBe('edited two files\nCOMPLETE\n');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.stopReason).toBe('stop');
      expect(last.servedModelId).toBe('gpt-5.6-sol-high');
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: [initEvent(), assistantEvent('ok'), successResult()].join('\n'),
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
    const { child, writes } = fakeChild({
      stdout: [initEvent(), assistantEvent('```json\n{"verdict":"PASS"}\n```'), successResult()].join(
        '\n'
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

  test('Test 2: progress is yielded before exit and node output is assistant text only', async () => {
    // Hold process exit open so we can prove progress chunks arrive while the
    // child is still running (not only after it resolves).
    const { child, releaseExit } = fakeChild({
      holdExit: true,
      exitCode: 0,
      stdout:
        [
          initEvent(),
          thinkingEvent('Listing the files in'),
          thinkingEvent('more thinking'),
          toolStartedEvent('ls -la'),
          toolCompletedEvent('ls -la'),
          assistantEvent('I will list the files then reply DONE'),
          successResult('I will list the files then reply DONE'),
        ].join('\n') + '\n',
    });

    const provider = new CursorAgentProvider({ spawn: () => child });
    const gen = provider.sendQuery('do work', '/w');
    const collected: MessageChunk[] = [];

    // Consume exactly up to and including the assistant chunk without awaiting
    // process exit, then assert progress already flowed.
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      collected.push(step.value);
      if (step.value.type === 'assistant') break;
    }

    // The assistant progress was yielded while exit was still unresolved.
    const progressTypes = collected.map(c => c.type);
    expect(progressTypes).toContain('thinking');
    expect(progressTypes).toContain('tool');
    expect(progressTypes).toContain('assistant');
    expect(assistantText(collected)).toBe('I will list the files then reply DONE');
    expect(assistantText(collected)).not.toContain('Listing the files in');
    expect(assistantText(collected)).not.toContain('ls -la');

    // Now let the process exit and the stream finish.
    releaseExit();
    for await (const rest of gen) collected.push(rest);

    const last = collected[collected.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') expect(last.servedModelId).toBe('Grok 4.7 256K High');
  });

  test('Test 2: a JSON record split across chunks and multiple records per chunk are both handled', async () => {
    // Frame the full stream so a single JSON line straddles a chunk boundary
    // and another chunk carries several complete lines at once.
    const text = [
      initEvent(),
      thinkingEvent('split across a boundary'),
      assistantEvent('one'),
      assistantEvent('two'),
      assistantEvent('three'),
      successResult('one two three'),
    ].join('\n') + '\n';

    let child: CursorAgentChild;
    const spawn: CursorAgentSpawn = () => {
      child = {
        stdin: { write: () => 0, end: () => undefined },
        stdout: chunkedStream(text, [20, 200]),
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
      return child;
    };
    const provider = new CursorAgentProvider({ spawn });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('onetwothree');
  });

  test('Test 3: error result throws and a non-success subtype also throws', async () => {
    const errorStream =
      [initEvent(), assistantEvent('about to fail'), JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model refused' })].join(
        '\n'
      ) + '\n';
    const provider1 = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: errorStream }).child,
    });
    await expect(collect(provider1.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);

    const subtypeOnly =
      [initEvent(), assistantEvent('x'), JSON.stringify({ type: 'result', subtype: 'cancelled', is_error: false, result: 'stopped early' })].join(
        '\n'
      ) + '\n';
    const provider2 = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: subtypeOnly }).child,
    });
    await expect(collect(provider2.sendQuery('hi', '/w'))).rejects.toThrow(/stopped early/);
  });

  test('Test 4: empty result with no assistant text throws the empty-output error', async () => {
    const emptySuccess =
      [initEvent(), JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })].join(
        '\n'
      ) + '\n';
    const provider = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: emptySuccess, exitCode: 0 }).child,
    });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('Test 4: a non-JSON line between valid events does not crash and result uses valid text', async () => {
    const garbage =
      [
        initEvent(),
        'this is not json at all',
        assistantEvent('valid output'),
        successResult(''),
      ].join('\n') + '\n';
    const provider = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: garbage }).child,
    });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('valid output');
  });

  test('Test 4: a final JSON line without a trailing newline is consumed', async () => {
    const noTrailingNewline =
      [initEvent(), assistantEvent('no newline')].join('\n') + '\n' + successResult('');
    const provider = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: noTrailingNewline }).child,
    });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('no newline');
  });

  test('a non-zero exit is a thrown error carrying the stderr tail, never a silent result', async () => {
    const { child } = fakeChild({ exitCode: 1, stderr: 'Authentication required. Please run' });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exited 1.*Authentication required/
    );
  });

  test('Test 5: served model is captured from init; absent init reports null with a reason', async () => {
    const withModel =
      [initEvent('Grok 4.7 256K High'), assistantEvent('ok'), successResult()].join('\n') + '\n';
    const provider1 = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: withModel }).child,
    });
    const chunks1 = await collect(provider1.sendQuery('hi', '/w'));
    const result1 = chunks1[chunks1.length - 1];
    expect(result1?.type).toBe('result');
    if (result1?.type === 'result') {
      expect(result1.servedModelId).toBe('Grok 4.7 256K High');
    }

    const noModel =
      [
        JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd: '/w' }),
        assistantEvent('ok'),
        successResult(),
      ].join('\n') + '\n';
    const provider2 = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout: noModel }).child,
    });
    const chunks2 = await collect(provider2.sendQuery('hi', '/w'));
    const result2 = chunks2[chunks2.length - 1];
    expect(result2?.type).toBe('result');
    if (result2?.type === 'result') {
      expect(result2.servedModelId).toBeNull();
      expect(result2.servedModelMissingReason).toMatch(/served-model field/);
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