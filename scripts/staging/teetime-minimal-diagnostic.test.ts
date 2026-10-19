import { expect, test } from 'bun:test';
import { markCodexFailureOrigin } from '../../packages/providers/src/codex/provider';
import type { MessageChunk } from '../../packages/providers/src/types';
import { spawnSync } from 'node:child_process';

import { collectMinimalDiagnostic, MINIMAL_DIAGNOSTIC_PROMPT,
  type MinimalDiagnosticResult } from './teetime-minimal-diagnostic';

async function collect(chunks: MessageChunk[], controller = new AbortController()) {
  let calls = 0, closed = 0;
  const packet = await collectMinimalDiagnostic((prompt: string, signal: AbortSignal) => {
    expect(prompt).toBe(MINIMAL_DIAGNOSTIC_PROMPT);
    expect(signal).toBe(controller.signal);
    calls++;
    return (async function* () { yield* chunks; })();
  }, controller, () => { closed++; });
  return { packet, calls, closed };
}

test('tiny response is diagnostic success only, with no response or app source retained', async () => {
  const { packet, calls, closed } = await collect([
    { type: 'thinking', content: 'PRIVATE-THINKING' },
    { type: 'assistant', content: '\tOK\r\n' }, { type: 'result' },
  ]);
  expect(calls).toBe(1); expect(closed).toBe(1);
  expect(packet).toEqual({ version: 1, kind: 'teetime-minimal-diagnostic', passed: true,
    responseVerified: true, modelInvocations: 1, assistantCount: 1, resultCount: 1,
    thinkingCount: 1, chunkCount: 3, normalProviderEnd: true,
    providerIteratorClosed: true, aborted: false, failure: null });
  expect(JSON.stringify(packet)).not.toMatch(/PRIVATE|artifact|sourceTree|content/);
});

test('original provider failure origin and hint survive cleanup, without private messages', async () => {
  const failure = markCodexFailureOrigin(new Error('401 PRIVATE-PROVIDER'), 'native_turn_failed');
  const packet = await collectMinimalDiagnostic(() => (async function* () { throw failure; })(),
    new AbortController(), () => {});
  expect(packet.passed).toBe(false);
  expect(packet.responseVerified).toBe(false);
  expect(packet.failure).toEqual({ code: 'provider_exception', cleanupFailure: false, exceptionCategory: 'auth_hint',
    provenance: { version: 1, origin: 'native_turn_failed' } });
  expect(packet.providerIteratorClosed).toBe(true);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE-PROVIDER');
});

test('native incomplete error result uses exact chunk provenance', async () => {
  const terminal = markCodexFailureOrigin<MessageChunk>({ type: 'result', isError: true,
    errors: ['PRIVATE-NATIVE'] }, 'native_stream_error_without_terminal');
  const { packet } = await collect([terminal]);
  expect(packet.failure).toEqual({ code: 'terminal_rejected', cleanupFailure: false, exceptionCategory: 'none',
    provenance: { version: 1, origin: 'native_stream_error_without_terminal' } });
  expect(JSON.stringify(packet)).not.toContain('PRIVATE-NATIVE');
});

test('order, malformed content, disallowed chunks and non-ASCII trim reject', async () => {
  const assistant: MessageChunk = { type: 'assistant', content: 'OK' };
  const result: MessageChunk = { type: 'result' };
  const cases: [MessageChunk[], NonNullable<MinimalDiagnosticResult['failure']>['code']][] = [
    [[result, assistant], 'order_rejected'],
    [[assistant, result, result], 'order_rejected'],
    [[assistant, result, { type: 'thinking', content: 'private' }], 'order_rejected'],
    [[assistant, assistant, result], 'order_rejected'],
    [[{ type: 'tool', toolName: 'PRIVATE-TOOL' }], 'unexpected_chunk'],
    [[{ type: 'assistant', content: '\u00a0OK' }, result], 'response_mismatch'],
    [[{ type: 'assistant', content: '\ud800' }, result], 'content_rejected'],
    [[{ type: 'assistant' } as MessageChunk, result], 'content_rejected'],
    [[{ type: 'assistant', content: null } as unknown as MessageChunk], 'content_rejected'],
    [[{ type: 'assistant', content: 42 } as unknown as MessageChunk], 'content_rejected'],
    [[assistant], 'stream_incomplete'],
    [[assistant, { type: 'result', isError: true }], 'terminal_rejected'],
  ];
  for (const [chunks, code] of cases) {
    const { packet } = await collect(chunks);
    expect(packet.passed).toBe(false); expect(packet.responseVerified).toBe(false);
    expect(packet.failure?.code).toBe(code);
    expect(JSON.stringify(packet)).not.toContain('PRIVATE-TOOL');
  }
});

test('chunk/content bounds reject before retaining private output', async () => {
  const { packet: chunks } = await collect(Array.from({ length: 65 }, () => ({ type: 'thinking', content: '' } as MessageChunk)));
  expect(chunks.chunkCount).toBe(65); expect(chunks.thinkingCount).toBe(64);
  expect(chunks.failure?.code).toBe('chunk_limit');
  for (const content of ['P'.repeat(65), 'P'.repeat(16385)]) {
    const { packet } = await collect([{ type: 'assistant', content }]);
    expect(packet.passed).toBe(false); expect(packet.failure?.code).toBe('content_limit');
    expect(JSON.stringify(packet)).not.toContain('PPPP');
  }
});

test('pre-abort invokes no provider; abort or cleanup failure cannot pass', async () => {
  const controller = new AbortController(); controller.abort();
  const { packet: before, calls } = await collect([], controller);
  expect(calls).toBe(0); expect(before.modelInvocations).toBe(0);
  expect(before.aborted).toBe(true); expect(before.failure?.code).toBe('aborted');
  const packet = await collectMinimalDiagnostic(() => (async function* () {
    yield { type: 'assistant' as const, content: 'OK' }; yield { type: 'result' as const };
  })(), new AbortController(), () => { throw new Error('PRIVATE-CLEANUP'); });
  expect(packet.passed).toBe(false); expect(packet.responseVerified).toBe(false);
  expect(packet.failure?.code).toBe('cleanup_failed');
  expect(packet.failure?.cleanupFailure).toBe(true);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE-CLEANUP');
});

test('provider hints are snapshotted before cleanup abort and hostile message getters stay private', async () => {
  const controller = new AbortController();
  const packet = await collectMinimalDiagnostic(() => (async function* () {
    throw markCodexFailureOrigin(new Error('401 PRIVATE-BEFORE-CLEANUP'), 'native_turn_failed');
  })(), controller, () => { controller.abort(); });
  expect(packet.aborted).toBe(true);
  expect(packet.failure?.exceptionCategory).toBe('auth_hint');
  expect(packet.failure?.provenance.origin).toBe('native_turn_failed');
  const hostile = new Error();
  Object.defineProperty(hostile, 'message', { get() { throw new Error('PRIVATE-GETTER'); } });
  const failed = await collectMinimalDiagnostic(() => (async function* () { throw hostile; })(),
    new AbortController(), () => {});
  expect(failed.failure).toEqual({ code: 'provider_exception', cleanupFailure: false, exceptionCategory: 'other',
    provenance: { version: 1, origin: 'unknown' } });
  expect(JSON.stringify(failed)).not.toContain('PRIVATE-GETTER');
});

test('valid Unicode thinking is discarded while malformed or aggregate-excess content rejects', async () => {
  const { packet } = await collect([{ type: 'thinking', content: '\ud83d\ude00' },
    { type: 'assistant', content: 'OK' }, { type: 'result' }]);
  expect(packet.passed).toBe(true);
  for (const chunks of [
    [{ type: 'thinking', content: '\udc00' }],
    [{ type: 'thinking', content: 'x'.repeat(9000) }, { type: 'thinking', content: 'x'.repeat(9000) }],
  ] as MessageChunk[][]) {
    const { packet: failed } = await collect(chunks);
    expect(failed.passed).toBe(false);
    expect(JSON.stringify(failed)).not.toContain('xxxx');
  }
});

test('chunk65 remains the primary bound failure when callback or iterator cleanup throws', async () => {
  for (const boundary of ['callback', 'iterator']) {
    const packet = await collectMinimalDiagnostic(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false as const, value: { type: 'thinking' as const, content: '' } }),
          return: async () => {
            if (boundary === 'iterator') throw new Error('PRIVATE-RETURN');
            return { done: true as const, value: undefined };
          },
        };
      },
    }), new AbortController(), () => {
      if (boundary === 'callback') throw new Error('PRIVATE-CALLBACK');
    });
    expect(packet.chunkCount).toBe(65); expect(packet.thinkingCount).toBe(64);
    expect(packet.passed).toBe(false); expect(packet.responseVerified).toBe(false);
    expect(packet.failure?.code).toBe('chunk_limit');
    expect(packet.failure?.cleanupFailure).toBe(true);
    const bridge = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
      ['-I', '-B', '-c', 'import sys;sys.path.insert(0,sys.argv[1]);from teetime_minimal_diagnostic import validate_minimal_diagnostic;validate_minimal_diagnostic(1,sys.stdin.buffer.read(4097))',
        import.meta.dir], { input: JSON.stringify(packet), encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
    expect(bridge.status).toBe(0);
    expect(JSON.stringify(packet)).not.toContain('PRIVATE-');
  }
});

test('an original provider failure survives a later cleanup exception and ordinary rejection has none', async () => {
  const packet = await collectMinimalDiagnostic(() => (async function* () {
    throw markCodexFailureOrigin(new Error('401 PRIVATE-PRIMARY'), 'native_turn_failed');
  })(), new AbortController(), () => { throw new Error('PRIVATE-SECONDARY'); });
  expect(packet.failure).toEqual({ code: 'provider_exception', cleanupFailure: true,
    exceptionCategory: 'auth_hint', provenance: { version: 1, origin: 'native_turn_failed' } });
  expect(packet.passed).toBe(false); expect(packet.normalProviderEnd).toBe(false);
  const { packet: rejected } = await collect([{ type: 'tool', toolName: 'PRIVATE-TOOL' }]);
  expect(rejected.failure?.code).toBe('unexpected_chunk');
  expect(rejected.failure?.cleanupFailure).toBe(false);
  expect(JSON.stringify(packet)).not.toContain('PRIVATE-');
});
