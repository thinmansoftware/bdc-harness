import { describe, expect, mock, test } from 'bun:test';
import type { IAgentProvider, MessageChunk } from '../types';
import { runProviderProbe } from './provider-probe';

async function* chunks(): AsyncGenerator<MessageChunk> {
  yield { type: 'assistant', content: 'OK' };
}

function provider(sendQuery: IAgentProvider['sendQuery']): IAgentProvider {
  return {
    sendQuery,
    getType: () => 'fake',
    getCapabilities: () => ({
      execution: { text: true, repositoryRead: false, repositoryWrite: false, shell: false },
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    }),
  };
}

describe('runProviderProbe', () => {
  test('returns ok after consuming a provider stream', async () => {
    const sendQuery = mock(() => chunks());
    const result = await runProviderProbe({ providerId: 'fake', modelId: 'm' }, '/tmp', () =>
      provider(sendQuery)
    );
    expect(result.ok).toBe(true);
    expect(sendQuery).toHaveBeenCalledTimes(1);
  });

  test('retries a transient error once', async () => {
    const sendQuery = mock(() => {
      throw Object.assign(new Error('429 rate limit'), { status: 429 });
    });
    const result = await runProviderProbe(
      { providerId: 'fake', modelId: 'm' },
      '/tmp',
      () => provider(sendQuery),
      { retryDelayMs: 0 }
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.classification?.kind).toBe('transient');
  });
});
