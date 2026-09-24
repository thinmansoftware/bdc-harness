import { expect, mock, test } from 'bun:test';
import type { IAgentProvider, MessageChunk, ProviderCapabilities } from '@archon/providers';
import type { RunCanaryResult } from './types';
import { runCanaryCli } from './cli';
import { formatProbeBindingResult, runProbeBinding } from './probe-binding';

function fakeProvider(chunks: readonly MessageChunk[], error?: Error): IAgentProvider {
  return {
    async *sendQuery() {
      if (error) throw error;
      yield* chunks;
    },
    getType: () => 'claude',
    getCapabilities: () => ({}) as ProviderCapabilities,
  };
}

test('binding probe reports ok for an assistant response', async () => {
  const result = await runProbeBinding('claude', 'claude-opus-5-5', '/tmp', {
    getAgentProvider: () => fakeProvider([{ type: 'assistant', content: 'OK' }]),
  });

  expect(result.ok).toBe(true);
  expect(formatProbeBindingResult(result)).toBe('ok: claude/claude-opus-5-5');
});

test('binding probe reports an auth classification without network access', async () => {
  const authError = Object.assign(new Error('unauthorized: invalid API key'), { status: 401 });
  const result = await runProbeBinding('claude', 'claude-opus-5-5', '/tmp', {
    getAgentProvider: () => fakeProvider([], authError),
    sleep: async () => {},
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected probe failure');
  expect(result.classification.errorClass).toBe('unknown_400');
  expect(formatProbeBindingResult(result)).toContain(result.classification.errorClass);
});

test.each([
  [fakeProvider([{ type: 'assistant', content: 'OK' }]), 0, 'ok:'],
  [
    fakeProvider([], Object.assign(new Error('unauthorized: invalid API key'), { status: 401 })),
    2,
    'unknown_400',
  ],
] as const)(
  'CLI maps binding probe result to exit code %d',
  async (provider, exitCode, outputText) => {
    const output: string[] = [];
    const exit = await runCanaryCli(
      ['probe-binding', '--provider', 'claude', '--model', 'claude-opus-5-5'],
      {},
      {
        runner: mock(async () => ({}) as RunCanaryResult),
        getAgentProvider: () => provider,
        stdout: value => output.push(value),
        stderr: value => output.push(value),
      }
    );

    expect(exit).toBe(exitCode);
    expect(output.join('\n')).toContain(outputText);
  }
);
