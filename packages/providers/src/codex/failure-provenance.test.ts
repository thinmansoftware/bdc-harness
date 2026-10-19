import { expect, test } from 'bun:test';

import * as provenance from './provider';

test('trusted native origin survives replacement errors without copying private fields', () => {
  const original = new Error('PRIVATE-MARKER');
  const same = provenance.markCodexFailureOrigin(original, 'native_turn_failed');
  expect(same).toBe(original);
  const replacement = provenance.copyCodexFailureOrigin(original, new Error('redacted'));
  const second = provenance.copyCodexFailureOrigin(replacement, new Error('redacted again'));
  const record = provenance.readCodexFailureOrigin(second);
  expect(record).toEqual({ version: 1, origin: 'native_turn_failed' });
  expect(Object.isFrozen(record)).toBe(true);
  expect(JSON.stringify(record)).not.toContain('PRIVATE-MARKER');
  expect(Object.keys(second)).toEqual([]);
});

test('untrusted properties, hostile objects and primitives cannot manufacture origin', () => {
  const hostile = new Proxy({}, { get: () => { throw new Error('PRIVATE-GETTER'); } });
  for (const value of [null, undefined, 1, 'PRIVATE-MARKER', hostile,
    { version: 1, origin: 'native_turn_failed', cause: new Error('PRIVATE-MARKER') }]) {
    expect(provenance.readCodexFailureOrigin(value)).toEqual({ version: 1, origin: 'unknown' });
    expect(provenance.readCodexFailureOrigin(provenance.copyCodexFailureOrigin(value, {})))
      .toEqual({ version: 1, origin: 'unknown' });
  }
  for (const value of [null, undefined, 1, 'PRIVATE-MARKER']) {
    expect(provenance.markCodexFailureOrigin(value, 'native_turn_failed')).toBe(value);
    expect(provenance.readCodexFailureOrigin(value)).toEqual({ version: 1, origin: 'unknown' });
  }
  const tagged = provenance.markCodexFailureOrigin(Object.freeze({}), 'native_turn_failed');
  provenance.markCodexFailureOrigin(tagged, 'sdk_iterator_exception');
  expect(provenance.readCodexFailureOrigin(tagged)).toEqual({ version: 1, origin: 'native_turn_failed' });
});

test('iterator acquisition and advancement preserve thrown identity and mark only SDK origin', async () => {
  for (const acquisition of [true, false]) {
    const failure = new Error('PRIVATE-SDK');
    const events = {
      [Symbol.asyncIterator]() {
        if (acquisition) throw failure;
        return { next: async () => { throw failure; } };
      },
    };
    let observed: unknown;
    try { for await (const value of provenance.codexEventsWithFailureOrigin(events)) void value; }
    catch (error) { observed = error; }
    expect(observed).toBe(failure);
    expect(provenance.readCodexFailureOrigin(observed))
      .toEqual({ version: 1, origin: 'sdk_iterator_exception' });
  }
});

test('consumer event interpretation exceptions are not relabeled as SDK failures', async () => {
  const failure = new Error('PRIVATE-HANDLER');
  let closed = false;
  const events = (async function* () { try { yield { type: 'event' }; } finally { closed = true; } })();
  try { for await (const _ of provenance.codexEventsWithFailureOrigin(events)) throw failure; }
  catch (error) { expect(error).toBe(failure); }
  expect(closed).toBe(true);
  expect(provenance.readCodexFailureOrigin(failure)).toEqual({ version: 1, origin: 'unknown' });
});

test('SDK iterator return failure preserves identity and is not a consumer failure', async () => {
  const failure = new Error('PRIVATE-RETURN');
  const events = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false as const, value: 'event' }),
        return: async () => { throw failure; },
      };
    },
  };
  let failed: unknown;
  try { for await (const _ of provenance.codexEventsWithFailureOrigin(events)) break; }
  catch (error) { failed = error; }
  expect(failed).toBe(failure);
  expect(provenance.readCodexFailureOrigin(failed))
    .toEqual({ version: 1, origin: 'sdk_iterator_exception' });
});
