import type { MessageChunk } from '../../packages/providers/src/types';

// Unregistered source-data collector. The caller owns worker/authority custody,
// deadline, abort and process reaping. This does not authenticate its iterator.
// Codex's normalizer stops after turn.completed: unseen raw SDK events cannot
// be attested here. We drain the provider iterator and reject exposed extras.
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error('artifact chunk schema rejected');
  return value as Record<string, unknown>;
}

function encodedText(value: unknown, bound: number): Uint8Array {
  if (typeof value !== 'string' || value.length > bound)
    throw new Error('artifact text bound or type rejected');
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('artifact text has an unpaired surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      throw new Error('artifact text has an unpaired surrogate');
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > bound) throw new Error('artifact UTF-8 byte bound exceeded');
  return bytes;
}

export async function collectArtifactStream(
  stream: AsyncIterable<MessageChunk>,
  signal: AbortSignal
): Promise<Uint8Array> {
  let artifact: Uint8Array | undefined;
  let completed = false;
  let chunks = 0;
  let thinkingBytes = 0;
  if (signal.aborted) throw new Error('artifact stream aborted');
  try {
    for await (const raw of stream) {
      if (signal.aborted || ++chunks > 64 || completed)
        throw new Error('artifact stream state rejected');
      const chunk = fields(raw, [
        'type',
        'content',
        'sessionId',
        'tokens',
        'servedModelId',
        'servedModelMissingReason',
      ]);
      if (chunk.type === 'thinking') {
        fields(chunk, ['type', 'content']);
        if (artifact) throw new Error('thinking after artifact rejected');
        thinkingBytes += encodedText(chunk.content, 16384).length;
        if (thinkingBytes > 16384) throw new Error('artifact thinking bound exceeded');
      } else if (chunk.type === 'assistant') {
        fields(chunk, ['type', 'content']);
        if (artifact) throw new Error('duplicate artifact assistant rejected');
        artifact = encodedText(chunk.content, 65536);
        if (!artifact.length) throw new Error('empty artifact assistant rejected');
      } else if (chunk.type === 'result') {
        fields(chunk, ['type', 'sessionId', 'tokens', 'servedModelId', 'servedModelMissingReason']);
        if (
          !artifact ||
          chunk.servedModelId !== null ||
          chunk.servedModelMissingReason !== 'codex_sdk_does_not_expose_served_model'
        )
          throw new Error('artifact terminal rejected');
        if (
          chunk.sessionId !== undefined &&
          (typeof chunk.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(chunk.sessionId))
        )
          throw new Error('artifact session metadata rejected');
        if (chunk.tokens !== undefined) {
          const tokens = fields(chunk.tokens, ['input', 'output']);
          if (
            Object.keys(tokens).length !== 2 ||
            ![tokens.input, tokens.output].every(
              value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
            )
          )
            throw new Error('artifact usage metadata rejected');
        }
        completed = true;
      } else throw new Error('artifact provider event rejected');
    }
  } catch {
    // Never copy raw SDK/provider exception strings into a controller receipt.
    throw new Error('artifact provider stream rejected');
  }
  if (signal.aborted || !artifact || !completed)
    throw new Error('artifact stream did not complete');
  return artifact;
}
