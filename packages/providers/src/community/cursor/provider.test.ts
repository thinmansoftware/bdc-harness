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

  test('progress chunks (init / thinking / tool_call / assistant) are yielded before the subprocess exits', async () => {
    const streamJson = [
      '{"type":"system","subtype":"init","model":"Grok 4.7 256K High","session_id":"s1"}',
      '{"type":"thinking","subtype":"delta","text":"Listing the files"}',
      '{"type":"thinking","subtype":"delta","text":" and counting them"}',
      '{"type":"thinking","subtype":"completed","text":"Listing the files and counting them"}',
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls -la"}}}}',
      '{"type":"tool_call","subtype":"completed","tool_call":{"shellToolCall":{"args":{"command":"ls -la"}}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":4558,"result":"DONE"}',
    ].join('\n');
    const { child, writes } = fakeChild({ stdout: streamJson });

    // Gate `exited` behind a manual resolve. The provider must yield its
    // pre-exit activity chunks BEFORE awaiting child.exited. We release the
    // gate after seeing the assistant chunk (the LAST pre-exit activity
    // chunk); the final `result` chunk is then yielded post-exit, so by the
    // time for-await finishes the result chunk is in `collected`.
    let resolveExit!: (code: number) => void;
    const gatedExit = new Promise<number>(r => {
      resolveExit = r;
    });
    const gatedChild: CursorAgentChild = { ...child, exited: gatedExit };

    const spawn: CursorAgentSpawn = () => gatedChild;
    const provider = new CursorAgentProvider({ spawn });

    const collected: MessageChunk[] = [];
    let exitGateReleasedAfterAssistant = false;
    let gateReleasedAtChunkIndex = -1;
    const gen = provider.sendQuery('list and finish', '/work/tree');
    let assistantSeen = false;
    for await (const chunk of gen) {
      collected.push(chunk);
      if (chunk.type === 'assistant') {
        assistantSeen = true;
        // Release the exit gate AFTER collecting the assistant chunk but
        // BEFORE the generator has awaited child.exited. This guarantees
        // every chunk pushed so far was yielded while the child was still
        // "running" by the generator's contract.
        resolveExit(0);
        exitGateReleasedAfterAssistant = assistantSeen;
        gateReleasedAtChunkIndex = collected.length - 1;
      }
    }

    // The exit gate was released only after the assistant chunk was
    // collected -- so every chunk collected before the release is a
    // pre-exit chunk.
    expect(exitGateReleasedAfterAssistant).toBe(true);
    expect(gateReleasedAtChunkIndex).toBeGreaterThanOrEqual(0);

    // At least one chunk per event type must appear in the collected stream.
    const types = new Set(collected.map(c => c.type));
    expect(types.has('thinking')).toBe(true);
    expect(types.has('tool')).toBe(true);
    expect(types.has('assistant')).toBe(true);
    // Thinking/tool events come BEFORE assistant text (per the stream-json
    // emission order). The exact order is preserved by `collected`.
    const firstAssistantIdx = collected.findIndex(c => c.type === 'assistant');
    const lastThinkingIdx = collected.map(c => c.type).lastIndexOf('thinking');
    expect(lastThinkingIdx).toBeLessThan(firstAssistantIdx);
    const firstToolIdx = collected.findIndex(c => c.type === 'tool');
    expect(firstToolIdx).toBeLessThan(firstAssistantIdx);

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
