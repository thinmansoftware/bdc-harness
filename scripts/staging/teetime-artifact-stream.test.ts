import { expect, test } from 'bun:test';
import type { MessageChunk } from '../../packages/providers/src/types';
import { collectArtifactStream } from './teetime-artifact-stream';

const assistant: MessageChunk = { type: 'assistant', content: '{"artifact":"raw bytes"}\n' };
const completion: MessageChunk = {
  type: 'result',
  tokens: { input: 0, output: 0 },
  servedModelId: null,
  servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
};

async function* stream(chunks: unknown[]): AsyncGenerator<MessageChunk> {
  for (const chunk of chunks) yield chunk as MessageChunk;
}

function collect(chunks: unknown[], controller = new AbortController()): Promise<Uint8Array> {
  return collectArtifactStream(stream(chunks), controller.signal);
}

test('returns exact assistant bytes only after completion and normal provider iterator end', async () => {
  const data = await collect([
    { type: 'thinking', content: 'untrusted reasoning' },
    assistant,
    completion,
  ]);
  expect(new TextDecoder().decode(data)).toBe(assistant.content);
});

test('does not parse, trim, concatenate or extract the artifact', async () => {
  const raw = ' \n{"duplicate":1,"duplicate":2} ';
  const data = await collect([{ type: 'assistant', content: raw }, completion]);
  expect(new TextDecoder().decode(data)).toBe(raw);
});

test('rejects missing, extra, out-of-order and post-terminal provider chunks', async () => {
  for (const chunks of [
    [],
    [assistant],
    [completion],
    [assistant, assistant, completion],
    [assistant, completion, completion],
    [assistant, completion, assistant],
    [assistant, { type: 'thinking', content: 'late' }, completion],
  ]) {
    await expect(collect(chunks)).rejects.toThrow();
  }
});

test('rejects tools, system, warnings, routing, rate-limit and unknown chunks', async () => {
  for (const chunk of [
    { type: 'system', content: '[WARNING] no' },
    { type: 'tool', toolName: 'shell' },
    { type: 'tool_result', toolName: 'shell', toolOutput: 'claimed success' },
    { type: 'provider_route', route: 'failback' },
    { type: 'rate_limit', rateLimitInfo: {} },
    { type: 'unknown' },
    null,
    'text',
    [],
  ])
    await expect(collect([chunk, assistant, completion])).rejects.toThrow();
});

test('rejects malformed assistant/thinking and completion fields', async () => {
  for (const chunk of [
    { type: 'assistant', content: '' },
    { type: 'assistant', content: 1 },
    { type: 'assistant', content: '{}', flush: true },
    { type: 'thinking', content: 1 },
    { type: 'thinking', content: 'ok', unexpected: true },
  ]) {
    await expect(collect([chunk, completion])).rejects.toThrow();
  }
  for (const change of [
    { isError: true },
    { errors: ['failed'] },
    { structuredOutput: {} },
    { errorSubtype: 'failed' },
    { servedModelId: 'unverified' },
    { servedModelMissingReason: 'other' },
    { sessionId: {} },
    { tokens: { input: -1, output: 0 } },
    { tokens: 'wrong' },
  ]) {
    await expect(collect([assistant, { ...completion, ...change }])).rejects.toThrow();
  }
});

test('bounds UTF-8 artifact bytes and rejects lone surrogates before encoding', async () => {
  for (const content of ['x'.repeat(65537), '\u00e9'.repeat(32769), '\ud800', '\udc00']) {
    await expect(collect([{ type: 'assistant', content }, completion])).rejects.toThrow();
  }
  const paired = await collect([{ type: 'assistant', content: '\ud83d\ude00' }, completion]);
  expect(paired.length).toBe(4);
});

test('bounds cumulative thinking and all provider chunks', async () => {
  await expect(
    collect([{ type: 'thinking', content: 'x'.repeat(16385) }, assistant, completion])
  ).rejects.toThrow();
  const many = Array.from({ length: 65 }, () => ({ type: 'thinking', content: 'a' }));
  await expect(collect([...many, assistant, completion])).rejects.toThrow();
});

test('rejects iterator exception even after a completion chunk', async () => {
  async function* interrupted(): AsyncGenerator<MessageChunk> {
    yield assistant;
    yield completion;
    throw new Error('synthetic transport failure');
  }
  await expect(
    collectArtifactStream(interrupted(), new AbortController().signal)
  ).rejects.toThrow();
});

test('checks abort before, after awaiting a step, and before returning', async () => {
  const before = new AbortController();
  before.abort();
  await expect(collect([assistant, completion], before)).rejects.toThrow();
  const during = new AbortController();
  async function* aborted(): AsyncGenerator<MessageChunk> {
    yield assistant;
    during.abort();
    yield completion;
  }
  await expect(collectArtifactStream(aborted(), during.signal)).rejects.toThrow();
  const atEnd = new AbortController();
  async function* finalAbort(): AsyncGenerator<MessageChunk> {
    yield assistant;
    yield completion;
    atEnd.abort();
  }
  await expect(collectArtifactStream(finalAbort(), atEnd.signal)).rejects.toThrow();
});
