import { test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { SendQueryOptions } from '../types';
import { restrictedClientOptions, restrictedThreadOptions } from './restricted-policy';
import { readCodexFailureOrigin } from './provider';
import { collectMinimalDiagnostic, collectMinimalDiagnosticV2 } from '../../../../scripts/staging/teetime-minimal-diagnostic';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
let injectedEvents: Record<string, unknown>[] = [];
const runStreamed = mock(async () => {
  const failure = failures.shift();
  if (failure) throw new Error(failure);
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'owned-thread' };
      yield* injectedEvents;
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
  injectedEvents = [];
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

test('native turn.failed origin survives enriched model-access wording', async () => {
  injectedEvents = [{ type: 'turn.failed', error: { message: 'model not available PRIVATE-NATIVE' } }];
  let failed: unknown;
  try { await consume(new CodexProvider({ restricted: true, restrictedTransport: 'teetime-connect-v1' })); }
  catch (error) { failed = error; }
  expect(failed).toBeInstanceOf(Error);
  expect(readCodexFailureOrigin(failed)).toEqual({ version: 1, origin: 'native_turn_failed' });
  expect(JSON.stringify(readCodexFailureOrigin(failed))).not.toContain('PRIVATE-NATIVE');
  expect(runStreamed).toHaveBeenCalledTimes(1);
  expect(reactive).not.toHaveBeenCalled();
});

test('actual SDK exception boundary reaches v2 Python validation with closed metadata', async () => {
  failures = ['Codex Exec exited with code 1: Error loading rules: PRIVATE-RULE (os error 13)'];
  const provider = new CodexProvider({restricted: true, restrictedTransport: 'teetime-connect-v1'});
  const packet = await collectMinimalDiagnosticV2((prompt, signal) =>
    provider.sendQuery(prompt, '/workspace', undefined, {abortSignal: signal}), new AbortController(), () => {});
  expect(packet.failure?.provenance.origin).toBe('sdk_iterator_exception');
  expect(packet.failure?.sdkEvidence?.kind).toBe('cli-exit');
  expect(packet.failure?.sdkEvidence?.startupEvidence?.startupStages).toEqual(['exec-policy']);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE');
  const script = ['import sys,json', 'sys.path.insert(0,sys.argv[1])',
    'from teetime_minimal_diagnostic import validate_minimal_diagnostic_v2',
    'print(json.dumps(validate_minimal_diagnostic_v2(1,sys.stdin.buffer.read(4097))))'].join(';');
  const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-B', '-c', script, resolve(import.meta.dir, '../../../../scripts/staging')],
    {input: JSON.stringify(packet), encoding: 'utf8', timeout: 10000, maxBuffer: 8192});
  expect(parsed.status).toBe(0);
  expect(JSON.parse(parsed.stdout)).toEqual(packet);
  expect(runStreamed).toHaveBeenCalledTimes(1);
  expect(reactive).not.toHaveBeenCalled();
});

test('SDK run acquisition and iterator failures are distinct from event-handler exceptions', async () => {
  for (const mode of ['acquisition', 'advancement', 'handler']) {
    runStreamed.mockImplementationOnce(async () => {
      if (mode === 'acquisition') throw new Error('PRIVATE-ACQUISITION');
      return { events: (async function* () {
        if (mode === 'advancement') throw new Error('PRIVATE-ADVANCEMENT');
        yield { type: 'item.started' }; // Invalid native event, interpreter throws.
      })() };
    });
    let failed: unknown;
    try { await consume(new CodexProvider({ restricted: true, restrictedTransport: 'teetime-connect-v1' })); }
    catch (error) { failed = error; }
    expect(failed).toBeInstanceOf(Error);
    expect(readCodexFailureOrigin(failed)).toEqual({ version: 1,
      origin: mode === 'handler' ? 'unknown' : 'sdk_iterator_exception' });
  }
});

test('actual client and thread initialization failures retain their narrow origin', async () => {
  for (const boundary of [sdk, start]) {
    boundary.mockImplementationOnce(() => { throw new Error('PRIVATE-INITIALIZATION'); });
    let failed: unknown;
    try { await consume(new CodexProvider({ restricted: true, restrictedTransport: 'teetime-connect-v1' })); }
    catch (error) { failed = error; }
    expect(failed).toBeInstanceOf(Error);
    expect(readCodexFailureOrigin(failed)).toEqual({ version: 1, origin: 'provider_initialization' });
  }
});

test('only an actual unrecovered native error tags incomplete results', async () => {
  for (const mode of ['native-error', 'empty', 'recovered']) {
    runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
      if (mode !== 'empty') yield { type: 'error', message: 'PRIVATE-STREAM' };
      if (mode === 'recovered') yield { type: 'turn.completed', usage: null };
    })() }));
    const chunks = [];
    for await (const chunk of new CodexProvider({ restricted: true }).sendQuery('test', '/workspace'))
      chunks.push(chunk);
    const terminal = chunks.at(-1)!;
    expect(terminal.type).toBe('result');
    expect(terminal.isError).toBe(mode === 'recovered' ? undefined : true);
    expect(readCodexFailureOrigin(terminal)).toEqual({ version: 1,
      origin: mode === 'native-error' ? 'native_stream_error_without_terminal' : 'unknown' });
  }
});

test('actual mocked provider events survive the diagnostic collector and independent Python validator', async () => {
  const validator = [
    'import json,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from teetime_minimal_diagnostic import validate_minimal_diagnostic',
    'v=validate_minimal_diagnostic(int(sys.argv[2]),sys.stdin.buffer.read(4097))',
    "print(json.dumps({'passed':v['passed'],'origin':None if v['failure'] is None else v['failure']['provenance']['origin']}))",
  ].join(';');
  for (const mode of ['native-failure', 'native-incomplete', 'tiny-success']) {
    injectedEvents = [];
    if (mode === 'native-failure')
      injectedEvents = [{ type: 'turn.failed', error: { message: 'invalid request PRIVATE-NATIVE' } }];
    else if (mode === 'tiny-success')
      injectedEvents = [{ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }];
    else runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
      yield { type: 'error', message: 'PRIVATE-INCOMPLETE' };
    })() }));
    const provider = new CodexProvider({ restricted: true, restrictedTransport: 'teetime-connect-v1' });
    const packet = await collectMinimalDiagnostic((prompt, signal) =>
      provider.sendQuery(prompt, '/workspace', undefined, { abortSignal: signal }),
    new AbortController(), () => {});
    expect(packet.passed).toBe(mode === 'tiny-success');
    const raw = JSON.stringify(packet);
    expect(raw).not.toContain('PRIVATE-');
    const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-I', '-B', '-c', validator, resolve(import.meta.dir, '../../../../scripts/staging'),
        packet.passed ? '0' : '1'],
      { input: raw, encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    expect(parsed.status).toBe(0);
    expect(JSON.parse(parsed.stdout)).toEqual({ passed: mode === 'tiny-success',
      origin: mode === 'tiny-success' ? null : mode === 'native-failure'
        ? 'native_turn_failed' : 'native_stream_error_without_terminal' });
  }
});

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

test('actual provider normalization keeps task lists as discardable progress', async () => {
  injectedEvents = [
    {
      type: 'item.completed',
      item: {
        type: 'todo_list',
        items: [{ text: 'Synthetic untrusted progress', completed: false }],
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'file_change',
        status: 'completed',
        changes: [{ kind: 'add', path: '/workspace/canary.txt' }],
      },
    },
  ];
  const { acceptCanaryChunk } = await import('../../../../scripts/staging/teetime-canary-result');
  const state = { results: 0, failureCode: 'none' as const };
  const system: string[] = [];
  const provider = new CodexProvider({
    restricted: true,
    restrictedTransport: 'teetime-connect-v1',
  });
  for await (const chunk of provider.sendQuery('synthetic', '/workspace')) {
    if (chunk.type === 'system') system.push(chunk.content);
    acceptCanaryChunk(state, chunk);
  }
  expect(system).toEqual([
    '[TASKS] Tasks:\n[ ] Synthetic untrusted progress',
    '[OK] File changes:\n[+] /workspace/canary.txt',
  ]);
  expect(state.results).toBe(1);
  expect(state.failureCode).toBe('none');
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
