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
  /** When supplied, replaces the string-based stdout with a controllable
   *  ReadableStream. The stream is queued so the provider can observe each
   *  `read()` resolution on a separate microtask -- enables the
   *  "yielded-before-exit" assertion without arbitrary sleeps. */
  stdoutStream?: ReadableStream<Uint8Array>;
}

function fakeChild(opts: FakeChildOptions = {}): { child: CursorAgentChild; writes: string[] } {
  const writes: string[] = [];
  const stdout =
    opts.stdoutStream !== undefined
      ? opts.stdoutStream
      : new Response(opts.stdout ?? '').body;
  const child: CursorAgentChild = {
    stdin: {
      write: (chunk: string): number => {
        writes.push(chunk);
        return chunk.length;
      },
      end: (): void => undefined,
    },
    stdout,
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
  test('argv requests stream-json output while preserving the existing flags', () => {
    const argv = buildCursorAgentArgv('cursor-agent', 'grok-4.7-high', '/work/tree');
    expect(argv).toEqual([
      'cursor-agent',
      '--print',
      '--force',
      '--trust',
      '--workspace',
      '/work/tree',
      '--model',
      'grok-4.7-high',
      '--output-format',
      'stream-json',
    ]);
    // The two stream-json flags must be adjacent so cursor-agent parses them
    // as a flag + value pair (defends against future argv reordering).
    const formatIndex = argv.indexOf('--output-format');
    expect(formatIndex).toBeGreaterThanOrEqual(0);
    expect(argv[formatIndex + 1]).toBe('stream-json');
  });

  test('progress chunks (init / thinking / tool_call / assistant) are yielded before stdout closes and before the subprocess exits', async () => {
    // The cursor-agent stream-json contract is one JSON object per line,
    // followed by a trailing newline. The test feeds the provider a
    // controllable ReadableStream that stays OPEN while we assert each
    // activity chunk is yielded, then closes (and releases the exit gate)
    // only after the assertion is satisfied. A buffering-until-EOF bug
    // would surface here as a 50ms timeout on every pull, because the
    // provider would have no chunks to yield until the stream closed.
    const streamEvents = [
      '{"type":"system","subtype":"init","model":"Grok 4.7 256K High","session_id":"s1"}',
      '{"type":"thinking","subtype":"delta","text":"Listing the files"}',
      '{"type":"thinking","subtype":"delta","text":" and counting them"}',
      '{"type":"thinking","subtype":"completed","text":"Listing the files and counting them"}',
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls -la"}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"shellToolCall":{"args":{"command":"ls -la"}}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":4558,"result":"DONE"}',
    ];
    const encoder = new TextEncoder();
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });

    // Gate `exited` behind a manual resolve. We will NOT release this gate
    // until after we have drained all the pre-exit activity chunks -- so
    // any chunk we collect has demonstrably been yielded before the child
    // is allowed to "exit".
    let resolveExit!: (code: number) => void;
    const gatedExit = new Promise<number>(r => {
      resolveExit = r;
    });
    let exitResolved = false;

    // The fakeChild helper does not understand our gated exit / controllable
    // stdout combination, so we wire the test seam directly: a manual writes
    // buffer for the prompt-on-stdin assertion and a fixed-stream child
    // surface that matches CursorAgentChild.
    const writes: string[] = [];
    const gatedChild: CursorAgentChild = {
      stdin: {
        write: (chunk: string): number => {
          writes.push(chunk);
          return chunk.length;
        },
        end: (): void => undefined,
      },
      stdout: stdoutStream,
      stderr: new Response('').body,
      exited: gatedExit.then(code => {
        exitResolved = true;
        return code;
      }),
      kill: (): void => undefined,
    };

    const spawn: CursorAgentSpawn = () => gatedChild;
    const provider = new CursorAgentProvider({ spawn });

    // pullWithGuard races iter.next() against a short timeout. The guard is
    // a SAFETY against hangs -- the test logic does not depend on it firing.
    // Crucially, we always await the prior pullWithGuard before starting the
    // next one, so at most one iter.next() Promise is pending at a time;
    // abandoned Promises cannot silently consume yields.
    async function pullWithGuard(iter: AsyncIterator<MessageChunk>, ms: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: 'timeout' }>(r => {
        timer = setTimeout(() => r({ kind: 'timeout' }), ms);
      });
      const nextPromise = iter.next().then(value => ({ kind: 'next' as const, value }));
      const raceWinner = await Promise.race([nextPromise, timeout]);
      if (timer) clearTimeout(timer);
      return { raceWinner, nextPromise };
    }

    const gen = provider.sendQuery('list and finish', '/work/tree');
    const iter = gen[Symbol.asyncIterator]();

    // Feed the controllable stream one event at a time, asserting a yield
    // (or no-yield for init/result) after each enqueue. The stream stays
    // OPEN across the entire drain -- it is closed only once we have
    // already collected every pre-exit activity chunk.
    const collected: MessageChunk[] = [];
    // The 6 events below yield one chunk each; the init and result events
    // set state without yielding.
    const yieldCounts = [0, 1, 1, 1, 1, 1, 1, 0];
    for (let i = 0; i < streamEvents.length; i++) {
      stdoutController.enqueue(encoder.encode(`${streamEvents[i]}\n`));
      const expected = yieldCounts[i];
      for (let k = 0; k < expected; k++) {
        const { raceWinner } = await pullWithGuard(iter, 200);
        if (raceWinner.kind !== 'next') {
          throw new Error(
            `expected a chunk for event #${i} but timed out after 200ms ` +
              `(this means the provider is buffering until stdout closes)`
          );
        }
        if (raceWinner.value.done) {
          throw new Error(`unexpected generator completion at event #${i}`);
        }
        collected.push(raceWinner.value.value);
      }
    }

    // After the last enqueue (the result event, which yields nothing), the
    // provider is blocked on reader.read(): the stream is OPEN, no more
    // data has been queued, and the read loop has already drained every
    // complete line. A pull with a short timeout MUST time out -- that is
    // the smoking-gun assertion that "chunks were yielded before close".
    const blocked = await pullWithGuard(iter, 50);
    expect(blocked.raceWinner.kind).toBe('timeout');
    expect(exitResolved).toBe(false); // exit gate still held

    // Now -- and ONLY now -- close the stream and release the exit gate.
    // After this, the provider's read returns done=true, it breaks out of
    // the read loop, awaits child.exited (now resolved with 0), and yields
    // the final result chunk. The probe's nextPromise consumes that yield.
    resolveExit(0);
    stdoutController.close();

    const resultResolution = await blocked.nextPromise;
    expect(resultResolution.kind).toBe('next');
    if (resultResolution.kind === 'next') {
      expect(resultResolution.value.done).toBe(false);
      collected.push(resultResolution.value.value);
    }

    const terminal = await iter.next();
    expect(terminal.done).toBe(true);

    // Sanity: 6 pre-exit activity chunks (3 thinking, 2 tool, 1 assistant)
    // + 1 result chunk. The pre-exit ones arrived BEFORE stdoutController.close()
    // and BEFORE the exit gate resolved; the result chunk arrived after.
    expect(collected.length).toBe(7);

    // At least one chunk per event type must appear in the collected stream.
    const types = new Set(collected.map(c => c.type));
    expect(types.has('thinking')).toBe(true);
    expect(types.has('tool')).toBe(true);
    expect(types.has('assistant')).toBe(true);
    expect(types.has('result')).toBe(true);

    // Thinking/tool events come BEFORE assistant text (per the stream-json
    // emission order). The exact order is preserved by `collected`.
    const firstAssistantIdx = collected.findIndex(c => c.type === 'assistant');
    const lastThinkingIdx = collected.map(c => c.type).lastIndexOf('thinking');
    expect(lastThinkingIdx).toBeLessThan(firstAssistantIdx);
    const firstToolIdx = collected.findIndex(c => c.type === 'tool');
    expect(firstToolIdx).toBeLessThan(firstAssistantIdx);
    // Result chunk is last.
    expect(collected[collected.length - 1]?.type).toBe('result');

    // Final node text = concatenated assistant texts only (no thinking text).
    const assistantTextValue = assistantText(collected);
    expect(assistantTextValue).toBe('DONE');
    expect(collected.some(c => c.type === 'thinking' && c.content.includes('DONE'))).toBe(false);

    // Result chunk carries the served model from the init event.
    const resultChunk = collected[collected.length - 1];
    expect(resultChunk?.type).toBe('result');
    if (resultChunk?.type === 'result') {
      expect(resultChunk.servedModelId).toBe('Grok 4.7 256K High');
    }

    // Prompt on stdin, never on argv.
    expect(writes.join('')).toContain('list and finish');
  });

  test('default model and per-call override remain stable; buildCursorAgentArgv exposes workspace flag', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({
        stdout: [
          '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
          '{"type":"result","subtype":"success","is_error":false,"result":"ok"}',
        ].join('\n'),
      }).child;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    expect(argvs[0]?.slice(-4)).toEqual(['--model', DEFAULT_CURSOR_AGENT_MODEL, '--output-format', 'stream-json']);
    expect(argvs[1]?.slice(-4)).toEqual(['--model', 'cursor-grok-4.6-high', '--output-format', 'stream-json']);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const stdout = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"```json\\n{\\"verdict\\":\\"PASS\\"}\\n```"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"```json\\n{\\"verdict\\":\\"PASS\\"}\\n```"}',
    ].join('\n');
    const { child, writes } = fakeChild({ stdout });
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

  test('multiple assistant events are concatenated in encounter order', async () => {
    const stdout = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello, "}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"world!"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":""}',
    ].join('\n');
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('Hello, world!');
    const resultChunk = chunks[chunks.length - 1];
    expect(resultChunk?.type === 'result' && resultChunk.structuredOutput).toBeUndefined();
  });

  test('result with is_error=true throws containing the result message', async () => {
    const stdout = '{"type":"result","subtype":"error","is_error":true,"result":"model refused"}';
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);
  });

  test('result whose subtype is not "success" throws even when is_error is false', async () => {
    const stdout = '{"type":"result","subtype":"cancelled","is_error":false,"result":"user cancelled"}';
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/user cancelled/);
  });

  test('error result text is trimmed to the last 400 characters', async () => {
    // 600 'x' chars + ' tail-marker' (12 chars) = 612 chars total. The bound
    // is the LAST 400 characters: characters [212..611] of the source, which
    // is 388 x's followed by ' tail-marker'.
    const longMessage = 'x'.repeat(600) + ' tail-marker';
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: longMessage,
    });
    // Each sendQuery() spawns a fresh child -- ReadableStream bodies are
    // single-consumption, so reusing the same child double would surface
    // "ReadableStream has already been used" rather than the real bound.
    const provider = new CursorAgentProvider({
      spawn: () => fakeChild({ stdout }).child,
    });
    // First call: throws with the tail-marker present (last 400 chars).
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/tail-marker/);
    // Second call (fresh child): confirm the trimmed message starts with the
    // last 400 source characters (388 x's then ' tail-marker') and has total
    // length 400. This proves the bound is exactly the last 400 characters.
    let captured: Error | undefined;
    try {
      await collect(provider.sendQuery('hi', '/w'));
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeDefined();
    const msg = captured?.message ?? '';
    expect(msg.length).toBe(400);
    expect(msg).toMatch(/^x{388} tail-marker$/);
  });

  test('success result with no assistant text uses result.result as the node text', async () => {
    const stdout = '{"type":"result","subtype":"success","is_error":false,"result":"only-result-text"}';
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('only-result-text');
  });

  test('success with neither assistant text nor non-empty result text still throws the workspace-trust guard', async () => {
    const stdout = '{"type":"result","subtype":"success","is_error":false,"result":""}';
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);
  });

  test('a malformed non-JSON line between valid events is ignored diagnostically and the stream still resolves', async () => {
    const stdout = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}',
      'this is not json { broken',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"-second"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"first-second"}',
    ].join('\n');
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('first-second');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
  });

  test('a final valid JSON line without a trailing newline is still processed', async () => {
    const stdout = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"trailing"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"trailing"}',
    ].join('\n'); // already ends without trailing newline
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('trailing');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
  });

  test('a non-zero exit throws with stderr context, never a silent result', async () => {
    const { child } = fakeChild({
      exitCode: 1,
      stderr: 'Authentication required. Please run',
      stdout: '{"type":"result","subtype":"success","is_error":false,"result":"never-reached"}',
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(
      /exited 1.*Authentication required/
    );
  });

  test('init event model is captured on the final result chunk as servedModelId', async () => {
    const stdout = [
      '{"type":"system","subtype":"init","model":"Grok 4.7 256K High","session_id":"abc"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"hi"}',
    ].join('\n');
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = chunks[chunks.length - 1];
    expect(last?.type === 'result' && last.servedModelId).toBe('Grok 4.7 256K High');
    expect(last?.type === 'result' && last.servedModelMissingReason).toBeUndefined();
  });

  test('stream with no init model reports servedModelId=null with the contract-appropriate reason', async () => {
    const stdout = [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"hi"}',
    ].join('\n');
    const { child } = fakeChild({ stdout });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBeNull();
      expect(typeof last.servedModelMissingReason).toBe('string');
      expect(last.servedModelMissingReason?.length).toBeGreaterThan(0);
    }
  });

  test('fails closed without cwd', async () => {
    const provider = new CursorAgentProvider({ spawn: () => fakeChild().child });
    await expect(async () => {
      const gen = provider.sendQuery('hi', '');
      await gen.next();
    }).toThrow(/cwd/);
  });

  test('exit 0 with no events at all (workspace-trust no-op) is a failure, not success', async () => {
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
