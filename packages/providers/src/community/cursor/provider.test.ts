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
    const { child, writes } = fakeChild({ stdout: 'edited two files\nCOMPLETE\n' });
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
      return fakeChild({ stdout: 'ok' }).child;
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
    const { child, writes } = fakeChild({ stdout: '```json\n{"verdict":"PASS"}\n```' });
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
  });
});
