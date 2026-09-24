import { expect, test } from 'bun:test';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { runProbeBindingCommand } from './probe-binding';

function provider(behavior: MessageChunk[] | Error): IAgentProvider {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    async *sendQuery() {
      if (behavior instanceof Error) throw behavior;
      for (const chunk of behavior) yield chunk;
    },
  };
}

const args = ['probe-binding', '--provider', 'claude', '--model', 'claude-opus-5-5'];

test('probe-binding exits 0 and prints ok when the provider yields an assistant chunk', async () => {
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('network_forbidden');
  }) as typeof fetch;
  try {
    const result = await runProbeBindingCommand(args, {
      getAgentProvider: () => provider([{ type: 'assistant', content: 'OK' }]),
      sleep: async () => {},
      cwd: '/tmp',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('ok');
    expect(fetchCalls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('probe-binding exits 2 and prints the classification when the provider throws an auth error', async () => {
  const fetchCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error('network_forbidden');
  }) as typeof fetch;
  try {
    const authError = Object.assign(new Error('authentication failed'), { httpStatus: 401 });
    const result = await runProbeBindingCommand(args, {
      getAgentProvider: () => provider(authError),
      sleep: async () => {},
      cwd: '/tmp',
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('unknown_400');
    expect(fetchCalls).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
