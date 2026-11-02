import { describe, expect, mock, test } from 'bun:test';
import type { IAgentProvider, MessageChunk } from '../types';
import { probeProviderBinding } from './provider-probe';

const binding = {
  bindingKey: 'key-1',
  providerId: 'codex',
  modelId: 'qwen/qwen3-coder',
  authContextId: 'codex:chatgpt-account',
  assistantConfigHash: 'a',
  nodeOverrideHash: 'n',
};

function provider(chunksOrErrors: readonly (MessageChunk[] | Error)[]): IAgentProvider {
  let index = 0;
  return {
    getType: () => 'codex',
    getCapabilities: () =>
      ({}) as IAgentProvider['getCapabilities'] extends () => infer T ? T : never,
    sendQuery: mock(async function* () {
      const next = chunksOrErrors[index++];
      if (next instanceof Error) throw next;
      for (const chunk of next ?? []) yield chunk;
    }),
  };
}

describe('provider probe', () => {
  test('succeeds on assistant response', async () => {
    const result = await probeProviderBinding(binding, '/tmp', {
      getAgentProvider: () => provider([[{ type: 'assistant', content: 'OK' }]]),
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
  });

  test('retries transient once and warns open', async () => {
    const result = await probeProviderBinding(binding, '/tmp', {
      getAgentProvider: () =>
        provider([
          Object.assign(new Error('rate limit'), { httpStatus: 429 }),
          [{ type: 'assistant', content: 'OK' }],
        ]),
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
  });

  test('returns structural failure after confirmation', async () => {
    const err = Object.assign(new Error('model is not supported'), { httpStatus: 400 });
    const result = await probeProviderBinding(binding, '/tmp', {
      getAgentProvider: () => provider([err, err]),
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.classification.kind).toBe('structural');
  });
});
