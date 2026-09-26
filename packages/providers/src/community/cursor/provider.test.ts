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

function assistantText(chunks: MessageChunk[]): string {
  return chunks.flatMap(c => (c.type === 'assistant' ? [c.content] : [])).join('');
}

describe('CursorAgentProvider', () => {
  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    // Stream-json with init event (for servedModelId), thinking/tool events, and assistant text
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', cwd: '/tmp/test', session_id: 'abc123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '...' }] }, session_id: 'abc123' }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Thinking about', session_id: 'abc123', timestamp_ms: 100 }),
      JSON.stringify({ type: 'thinking', subtype: 'completed', session_id: 'abc123', timestamp_ms: 101 }),
      JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'ls -la' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'ls -la' }, stdout: 'file1\nfile2\n' } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'edited two files' }] }, session_id: 'abc123' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '\n' }] }, session_id: 'abc123' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'COMPLETE' }] }, session_id: 'abc123' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'edited two files\nCOMPLETE\n', duration_ms: 1000, session_id: 'abc123' }),
    ];
    const { child, writes } = fakeChild({ stdout: stdoutLines.join('\n') });
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

    // Assistant text should be the concatenation of assistant chunks
    expect(assistantText(chunks)).toBe('edited two files\nCOMPLETE');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.stopReason).toBe('stop');
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    // First call: use default model with simple result event for fallback
    const { child: child1 } = fakeChild({ stdout: JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 100 }) });
    // Second call: use override model with full stream-json
    const stdoutLines2 = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'cursor-grok-4.6-high', session_id: 'def456' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, session_id: 'def456' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 100, session_id: 'def456' }),
    ];
    const { child: child2 } = fakeChild({ stdout: stdoutLines2.join('\n') });
    let callCount = 0;
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      callCount++;
      if (callCount === 1) return child1;
      return child2;
    };
    const provider = new CursorAgentProvider({ spawn });
    await collect(provider.sendQuery('a', '/w'));
    await collect(provider.sendQuery('b', '/w', undefined, { model: 'cursor-grok-4.6-high' }));
    expect(DEFAULT_CURSOR_AGENT_MODEL).toBe('grok-4.7-high');
    expect(argvs[0]?.slice(-2)).toEqual(['--model', DEFAULT_CURSOR_AGENT_MODEL]);
    expect(argvs[1]?.slice(-2)).toEqual(['--model', 'cursor-grok-4.6-high']);
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--workspace');
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('--output-format');
    expect(buildCursorAgentArgv('cursor-agent', 'm', '/w')).toContain('stream-json');
  });

  test('prepends systemPrompt and extracts fenced JSON for json_schema output', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'xyz789' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '```json\n{"verdict":"PASS"}\n```' }] }, session_id: 'xyz789' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '```json\n{"verdict":"PASS"}\n```', duration_ms: 100, session_id: 'xyz789' }),
    ];
    const { child, writes } = fakeChild({ stdout: stdoutLines.join('\n') });
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

  test('progress-is-yielded-before-exit with thinking/tool/assistant events', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'test123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'test prompt' }] }, session_id: 'test123' }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Thinking about the', session_id: 'test123', timestamp_ms: 100 }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: ' solution', session_id: 'test123', timestamp_ms: 101 }),
      JSON.stringify({ type: 'thinking', subtype: 'completed', session_id: 'test123', timestamp_ms: 102 }),
      JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'echo hello' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'echo hello' }, stdout: 'hello\n' } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The answer is' }] }, session_id: 'test123' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' hello' }] }, session_id: 'test123' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'The answer is hello', duration_ms: 500, session_id: 'test123' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const chunks: MessageChunk[] = [];
    const provider = new CursorAgentProvider({ spawn: () => child });
    
    for await (const chunk of provider.sendQuery('test', '/w')) {
      chunks.push(chunk);
    }
    
    // Verify chunks are yielded during the stream (not just at the end)
    // There should be chunks for thinking and tool_call before the result
    const thinkingChunks = chunks.filter(c => c.type === 'thinking');
    const toolChunks = chunks.filter(c => c.type === 'tool');
    const toolResultChunks = chunks.filter(c => c.type === 'tool_result');
    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    
    expect(thinkingChunks.length).toBeGreaterThan(0);
    expect(toolChunks.length).toBeGreaterThan(0);
    expect(toolResultChunks.length).toBeGreaterThan(0);
    expect(assistantChunks.length).toBeGreaterThan(0);
    
    // The last chunk should be a result chunk
    expect(chunks[chunks.length - 1]?.type).toBe('result');
    
    // Assistant text should only include assistant chunks, not thinking text
    expect(assistantText(chunks)).toBe('The answer is hello');
  });

  test('error-result-throws with is_error flag', async () => {
    const { child } = fakeChild({ stdout: JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'model refused to respond', duration_ms: 100 }) });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('test', '/w'))).rejects.toThrow(/model refused to respond/);
  });

  test('error-result-throws with non-success subtype', async () => {
    const { child } = fakeChild({ stdout: JSON.stringify({ type: 'result', subtype: 'failure', is_error: false, result: 'operation failed', duration_ms: 100 }) });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('test', '/w'))).rejects.toThrow(/operation failed/);
  });

  test('empty-and-garbage-guards with empty result and no assistant', async () => {
    const { child } = fakeChild({ stdout: JSON.stringify({ type: 'result', subtype: 'success', result: '', duration_ms: 100 }) });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('test', '/w'))).rejects.toThrow(/empty output/);
  });

  test('garbage-lines-dont-crash-stream', async () => {
    const stdoutLines = [
      'not json at all',
      JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'test456' }),
      'another garbage line 123',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, session_id: 'test456' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', duration_ms: 100, session_id: 'test456' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('test', '/w'));
    
    // Should complete normally despite garbage lines
    expect(chunks.length).toBeGreaterThan(0);
    expect(assistantText(chunks)).toBe('ok');
    expect(chunks[chunks.length - 1]?.type).toBe('result');
  });

  test('non-zero-exit-throws-with-stderr-even-if-result-event-seen', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'test789' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] }, session_id: 'test789' }),
    ];
    const { child } = fakeChild({ 
      stdout: stdoutLines.join('\n'),
      exitCode: 1,
      stderr: 'Exit with error: timeout'
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('test', '/w'))).rejects.toThrow(/exited 1.*timeout/);
  });

  test('served-model-recorded from init event', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', session_id: 'test-model' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, session_id: 'test-model' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', duration_ms: 100, session_id: 'test-model' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('test', '/w'));
    
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBe('Grok 4.7 256K High');
    }
  });

  test('served-model-is-null-when-no-init-event', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }, session_id: 'test-no-init' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'answer', duration_ms: 100, session_id: 'test-no-init' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('test', '/w'));
    
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    if (last?.type === 'result') {
      expect(last.servedModelId).toBeNull();
      expect(last.servedModelMissingReason).toBe('cursor-agent init event did not include model field');
    }
  });

  test('debug-stream-chunks', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model', session_id: 'test123' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'test prompt' }] }, session_id: 'test123' }),
      JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'Thinking about the', session_id: 'test123', timestamp_ms: 100 }),
      JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'echo hello' } } } }),
      JSON.stringify({ type: 'tool_call', subtype: 'completed', call_id: 'tool1', tool_call: { shellToolCall: { args: { command: 'echo hello' }, stdout: 'hello\n' } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The answer is' }] }, session_id: 'test123' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'The answer is hello', duration_ms: 500, session_id: 'test123' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const chunks: MessageChunk[] = [];
    const provider = new CursorAgentProvider({ spawn: () => child });

    console.log('Starting iteration...');
    for await (const chunk of provider.sendQuery('test', '/w')) {
      console.log('Got chunk:', JSON.stringify(chunk));
      chunks.push(chunk);
    }
    console.log('Total chunks:', chunks.length);
    console.log('Assistant chunks:', chunks.filter(c => c.type === 'assistant').length);
    console.log('Thinking chunks:', chunks.filter(c => c.type === 'thinking').length);
    console.log('Tool chunks:', chunks.filter(c => c.type === 'tool').length);
    console.log('Tool result chunks:', chunks.filter(c => c.type === 'tool_result').length);
  });

  test('result-result-fallback-when-no-assistant', async () => {
    const stdoutLines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'fallback-model', session_id: 'test-fallback' }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'fallback text only', duration_ms: 100, session_id: 'test-fallback' }),
    ];
    const { child } = fakeChild({ stdout: stdoutLines.join('\n') });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('test', '/w'));
    
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
    // Fallback text is used for finalText (not in a chunk, but for structured output)
    if (last?.type === 'result') {
      expect(last.servedModelId).toBe('fallback-model');
      expect(last.structuredOutput).toBeUndefined(); // Not JSON schema output
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
