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

function streamJson(events: unknown[]): string {
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

function assistantEvent(text: string): unknown {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function successResult(result: string): unknown {
  return { type: 'result', subtype: 'success', is_error: false, result };
}

describe('CursorAgentProvider', () => {
  test('spawns cursor-agent with --workspace <cwd> and the configured model; prompt on stdin', async () => {
    let seenArgv: string[] = [];
    let seenCwd = '';
    const { child, writes } = fakeChild({
      stdout: streamJson([
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
        'cursor-agent stream-json output had no system/init model field'
      );
    }
  });

  test('defaults to grok-4.7-high and honours a per-call model override', async () => {
    const argvs: string[][] = [];
    const spawn: CursorAgentSpawn = argv => {
      argvs.push(argv);
      return fakeChild({ stdout: streamJson([assistantEvent('ok'), successResult('ok')]) }).child;
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
      stdout: streamJson([assistantEvent(fenced), successResult(fenced)]),
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
    expect(formatAt).toBeGreaterThanOrEqual(0);
    expect(argv[formatAt + 1]).toBe('stream-json');
    expect(argv).toContain('--print');
    expect(argv).toContain('--force');
    expect(argv).toContain('--trust');
    const workspaceAt = argv.indexOf('--workspace');
    expect(argv[workspaceAt + 1]).toBe('/w');
    const modelAt = argv.indexOf('--model');
    expect(argv[modelAt + 1]).toBe('grok-4.7-high');
  });

  test('progress-is-yielded-before-exit', async () => {
    let releaseExit: (code: number) => void = () => {
      throw new Error('exit resolver not installed');
    };
    const exited = new Promise<number>(resolve => {
      releaseExit = resolve;
    });
    const stdout = streamJson([
      { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', session_id: 's' },
      { type: 'thinking', subtype: 'delta', text: 'Listing the files in', session_id: 's' },
      { type: 'thinking', subtype: 'delta', text: ' the worktree', session_id: 's' },
      { type: 'thinking', subtype: 'delta', text: ' now', session_id: 's' },
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c1',
        tool_call: { shellToolCall: { args: { command: 'ls -la' } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c1',
        tool_call: { shellToolCall: { args: { command: 'ls -la' } } },
      },
      assistantEvent('DONE'),
      successResult('DONE'),
    ]);
    const child: CursorAgentChild = {
      stdin: { write: () => 0, end: () => undefined },
      stdout: new Response(stdout).body,
      stderr: new Response('').body,
      exited,
      kill: () => undefined,
    };
    const provider = new CursorAgentProvider({ spawn: () => child });
    const gen = provider.sendQuery('list files', '/w');
    const chunks: MessageChunk[] = [];
    let exitReleased = false;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('timed out waiting for progress chunks before exit')),
        2000
      );
    });
    const done = (async () => {
      for await (const chunk of gen) {
        chunks.push(chunk);
        const thinkingCount = chunks.filter(c => c.type === 'thinking').length;
        const assistantCount = chunks.filter(c => c.type === 'assistant').length;
        if (!exitReleased && thinkingCount >= 5 && assistantCount >= 1) {
          exitReleased = true;
          releaseExit(0);
        }
      }
    })();
    await Promise.race([done, timeout]);
    expect(exitReleased).toBe(true);
    expect(assistantText(chunks)).toBe('DONE');
    const thinking = chunks.flatMap(c => (c.type === 'thinking' ? [c.content] : []));
    expect(thinking.filter(text => text.length > 0).join('')).toBe(
      'Listing the files in the worktree now'
    );
    expect(thinking.filter(text => text.length === 0)).toHaveLength(2);
    expect(assistantText(chunks)).not.toContain('Listing the files');
  });

  test('error-result-throws', async () => {
    const { child } = fakeChild({
      stdout: streamJson([
        { type: 'result', subtype: 'error', is_error: true, result: 'model refused' },
      ]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    await expect(collect(provider.sendQuery('hi', '/w'))).rejects.toThrow(/model refused/);
  });

  test('empty-and-garbage-guards', async () => {
    const empty = fakeChild({
      stdout: streamJson([{ type: 'result', subtype: 'success', is_error: false, result: '' }]),
    });
    const emptyProvider = new CursorAgentProvider({ spawn: () => empty.child });
    await expect(collect(emptyProvider.sendQuery('hi', '/w'))).rejects.toThrow(/empty output/);

    const noisy = fakeChild({
      stdout: [
        JSON.stringify(assistantEvent('kept-text')),
        'this is not json',
        JSON.stringify(successResult('kept-text')),
      ].join('\n'),
    });
    const noisyProvider = new CursorAgentProvider({ spawn: () => noisy.child });
    const chunks = await collect(noisyProvider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('kept-text');
  });

  test('success result text is the node output when no assistant text was seen', async () => {
    const { child } = fakeChild({
      stdout: streamJson([successResult('only-from-result')]),
    });
    const provider = new CursorAgentProvider({ spawn: () => child });
    const chunks = await collect(provider.sendQuery('hi', '/w'));
    expect(assistantText(chunks)).toBe('only-from-result');
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe('result');
  });

  test('served-model-recorded', async () => {
    const { child } = fakeChild({
      stdout: streamJson([
        { type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', session_id: 's' },
        assistantEvent('DONE'),
        successResult('DONE'),
      ]),
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
