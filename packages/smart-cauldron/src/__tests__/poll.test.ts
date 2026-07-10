import { afterEach, describe, expect, test } from 'bun:test';

import { PollTransportError, pollForTerminal } from '../poll.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pollForTerminal transport truth', () => {
  test('surfaces an HTTP transport failure instead of converting it into a timeout', async () => {
    globalThis.fetch = (async () =>
      new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-http-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });

  test('surfaces a network failure instead of silently polling null', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection reset');
    }) as unknown as typeof fetch;

    await expect(
      pollForTerminal({
        runId: 'run-network-failure',
        apiBaseUrl: 'http://archon.test',
        timeoutMs: 60_000,
        intervalMs: 1,
      })
    ).rejects.toBeInstanceOf(PollTransportError);
  });
});
