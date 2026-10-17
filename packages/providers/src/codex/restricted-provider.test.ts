import { test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { SendQueryOptions } from '../types';
import { restrictedClientOptions, restrictedThreadOptions } from './restricted-policy';

mock.module('@archon/paths', () => ({ createLogger: () => createMockLogger() }));
mock.module('./binary-resolver', () => ({
  resolveCodexBinaryPath: async () => 'unused-normal-resolver',
}));
const proactive = mock(async () => {});
const reactive = mock(async () => ({ refreshed: false, reason: 'no_creds' }));
mock.module('../auth-refresh/index.js', () => ({
  ensureFreshAuth: proactive,
  refreshIfAuthFailed: reactive,
  AUTH_PATTERNS: ['unauthorized', '401', 'refresh token'],
  isTerminalRefreshReason: () => false,
  buildReauthMessage: () => 'test auth failure',
  isAuthErrorMessage: (message: string) => /401|unauthorized|refresh token/i.test(message),
}));
let failures: string[] = [];
const runStreamed = mock(async () => {
  const failure = failures.shift();
  if (failure) throw new Error(failure);
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'owned-thread' };
      yield {
        type: 'turn.completed',
        usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
      };
    })(),
  };
});
const start = mock(() => ({ id: 'owned-thread', runStreamed }));
const resume = mock(() => ({ id: 'owned-thread', runStreamed }));
const sdk = mock(() => ({ startThread: start, resumeThread: resume }));
mock.module('@openai/codex-sdk', () => ({ Codex: sdk }));
const { CodexProvider } = await import('./provider');
let cwdSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  failures = [];
  for (const fn of [proactive, reactive, start, resume, sdk, runStreamed]) fn.mockClear();
  cwdSpy = spyOn(process, 'cwd').mockReturnValue('/workspace');
});
afterEach(() => cwdSpy.mockRestore());
async function consume(
  provider: InstanceType<typeof CodexProvider>,
  options?: SendQueryOptions,
  id?: string
): Promise<void> {
  for await (const chunk of provider.sendQuery('synthetic test', '/workspace', id, options))
    void chunk;
}

test('restricted startup and owned resume use fixed options without global auth', async () => {
  const provider = new CodexProvider({ restricted: true });
  await consume(provider);
  await consume(provider, undefined, 'owned-thread');
  expect(sdk).toHaveBeenCalledTimes(2);
  for (const call of sdk.mock.calls) expect(call[0]).toEqual(restrictedClientOptions());
  expect(start).toHaveBeenCalledWith(restrictedThreadOptions());
  expect(resume).toHaveBeenCalledWith('owned-thread', restrictedThreadOptions());
  expect(proactive).not.toHaveBeenCalled();
  expect(reactive).not.toHaveBeenCalled();
});

test('canary uses only constructor-owned transport and does not refresh failed auth', async () => {
  const provider = new CodexProvider({
    restricted: true,
    restrictedTransport: 'teetime-connect-v1',
  });
  failures = ['401 unauthorized'];
  await expect(consume(provider)).rejects.toThrow();
  expect(sdk.mock.calls[0][0]).toEqual(restrictedClientOptions('teetime-connect-v1'));
  expect(runStreamed).toHaveBeenCalledTimes(1);
  expect(proactive).not.toHaveBeenCalled();
  expect(reactive).not.toHaveBeenCalled();
  expect(() => new CodexProvider({ restrictedTransport: 'teetime-connect-v1' })).toThrow(
    'transport'
  );
  expect(
    () => new CodexProvider({ restricted: true, restrictedTransport: 'other' as never })
  ).toThrow('transport');
});

test('canary stops on subprocess crash without a second model attempt', async () => {
  failures = ['Codex process exited with code 1'];
  await expect(
    consume(new CodexProvider({ restricted: true, restrictedTransport: 'teetime-connect-v1' }))
  ).rejects.toThrow();
  expect(runStreamed).toHaveBeenCalledTimes(1);
  expect(proactive).not.toHaveBeenCalled();
  expect(reactive).not.toHaveBeenCalled();
});

test('foreign or restarted-instance sessions fail before auth and SDK', async () => {
  await consume(new CodexProvider({ restricted: true }));
  sdk.mockClear();
  await expect(
    consume(new CodexProvider({ restricted: true }), undefined, 'owned-thread')
  ).rejects.toThrow('unowned');
  expect(sdk).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
});

test('canary rejects even owned resume before constructing another SDK client', async () => {
  const provider = new CodexProvider({
    restricted: true,
    restrictedTransport: 'teetime-connect-v1',
  });
  await consume(provider);
  for (const fn of [sdk, start, resume, runStreamed]) fn.mockClear();
  await expect(consume(provider, undefined, 'owned-thread')).rejects.toThrow('resume');
  expect(sdk).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(runStreamed).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
  expect(reactive).not.toHaveBeenCalled();
});

test('configuration overrides and wrong worker cwd fail before auth and SDK', async () => {
  const provider = new CodexProvider({ restricted: true });
  const denied: SendQueryOptions[] = [
    { model: 'claude' },
    { env: { HOME: '/other' } },
    { assistantConfig: { sandboxMode: 'danger-full-access' } },
    { nodeConfig: { mcp: 'anything' } },
    { fallbackModel: 'anything' },
    { forkSession: true },
    { persistSession: false },
  ];
  for (const options of denied)
    await expect(consume(provider, options)).rejects.toThrow('rejected');
  const wrongRequestCwd = async (): Promise<void> => {
    for await (const chunk of provider.sendQuery('test', '/other')) void chunk;
  };
  await expect(wrongRequestCwd()).rejects.toThrow('dedicated');
  cwdSpy.mockReturnValue('/app');
  await expect(consume(provider)).rejects.toThrow('dedicated');
  expect(sdk).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
});

test('restricted auth failure never refreshes or falls back', async () => {
  failures = ['401 unauthorized'];
  await expect(
    consume(new CodexProvider({ restricted: true, retryBaseDelayMs: 0 }))
  ).rejects.toThrow();
  expect(reactive).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
  expect(
    () =>
      new CodexProvider({
        restricted: true,
        failbackProviderFactory: () => {
          throw new Error('must not run');
        },
      })
  ).toThrow('fallback');
});

test('subprocess retry preserves restricted thread policy', async () => {
  failures = ['Codex process exited with code 1'];
  await consume(new CodexProvider({ restricted: true, retryBaseDelayMs: 0 }));
  expect(start.mock.calls.length).toBeGreaterThan(1);
  for (const call of start.mock.calls) expect(call[0]).toEqual(restrictedThreadOptions());
  expect(reactive).not.toHaveBeenCalled();
});

test('missing owned rollout restarts with the same restricted policy', async () => {
  const provider = new CodexProvider({ restricted: true, retryBaseDelayMs: 0 });
  await consume(provider);
  failures = ['no rollout found for thread id owned-thread'];
  await consume(provider, undefined, 'owned-thread');
  expect(resume).toHaveBeenCalledWith('owned-thread', restrictedThreadOptions());
  expect(start.mock.calls.length).toBeGreaterThan(1);
  for (const call of start.mock.calls) expect(call[0]).toEqual(restrictedThreadOptions());
  expect(reactive).not.toHaveBeenCalled();
});

test('terminal crash stops without any fallback or global refresh', async () => {
  failures = Array(10).fill('Codex process exited with code 1');
  await expect(
    consume(new CodexProvider({ restricted: true, retryBaseDelayMs: 0 }))
  ).rejects.toThrow();
  for (const call of start.mock.calls) expect(call[0]).toEqual(restrictedThreadOptions());
  expect(reactive).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
});

test('rate limit fails without changing model or provider', async () => {
  failures = Array(10).fill('429 rate limit exceeded');
  await expect(
    consume(new CodexProvider({ restricted: true, retryBaseDelayMs: 0 }))
  ).rejects.toThrow();
  for (const call of start.mock.calls) expect(call[0]).toEqual(restrictedThreadOptions());
  expect(reactive).not.toHaveBeenCalled();
  expect(proactive).not.toHaveBeenCalled();
});
