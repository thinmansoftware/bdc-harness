import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deriveRestrictedReviewCatalog } from './restricted-review-catalog';

const fixture = readFileSync(new URL('./restricted-review-model-base.json', import.meta.url));
const original = JSON.parse(fixture.toString('utf8'));
const hash = (raw: Uint8Array | string) => createHash('sha256').update(raw).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test('preserves the complete pinned entry except the five permitted capability fields', () => {
  const result = deriveRestrictedReviewCatalog(fixture);
  const catalog = JSON.parse(result.catalogText);
  expect(result.sourceFixtureHash).toBe(
    '59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6'
  );
  expect(result.sourceFixtureHash).toBe(hash(fixture));
  expect(result.catalogHash).toBe(hash(result.catalogText));
  expect(Object.keys(catalog)).toEqual(['models']);
  expect(catalog.models).toHaveLength(1);
  expect(catalog.models[0]).toEqual({
    ...original.models[0],
    shell_type: 'disabled',
    apply_patch_tool_type: null,
    tool_mode: 'direct',
    experimental_supported_tools: [],
    supports_search_tool: false,
  });
  const changed = Object.keys(original.models[0]).filter(
    key => JSON.stringify(original.models[0][key]) !== JSON.stringify(catalog.models[0][key])
  );
  expect(changed.sort()).toEqual(
    ['shell_type', 'apply_patch_tool_type', 'tool_mode', 'supports_search_tool'].sort()
  );
  expect(catalog.models[0].slug).toBe('gpt-5.6-sol');
  expect(catalog.models[0].context_window).toBe(272000);
  expect(catalog.models[0].model_messages).toEqual(original.models[0].model_messages);
});

test('rejects same-size binary mutation before parsing any replacement metadata', () => {
  const changed = Uint8Array.from(fixture);
  changed[0] = 0;
  expect(() => deriveRestrictedReviewCatalog(changed)).toThrow('identity');
});

test('rejects changed model, context, instructions or transport metadata', () => {
  for (const patch of [
    { slug: 'other' },
    { context_window: 1000000 },
    { base_instructions: 'replacement' },
    { model_messages: {} },
    { prefer_websockets: true },
  ]) {
    const changed = structuredClone(original);
    Object.assign(changed.models[0], patch);
    expect(() => deriveRestrictedReviewCatalog(encode(changed))).toThrow('identity');
  }
});

test('rejects duplicate-key serialization by byte identity, not a general JSON parser', () => {
  const raw = fixture.toString('utf8').replace('"models":', '"models": [], "models":');
  expect(() => deriveRestrictedReviewCatalog(new TextEncoder().encode(raw))).toThrow('identity');
});

test('rejects extra entries and equivalent reserialization', () => {
  expect(() => deriveRestrictedReviewCatalog(encode(original))).toThrow('identity');
  const changed = structuredClone(original);
  changed.models.push(structuredClone(changed.models[0]));
  expect(() => deriveRestrictedReviewCatalog(encode(changed))).toThrow('identity');
});

test('rejects wrong types and bounds without accepting caller-selected expectations', () => {
  for (const value of [null, undefined, '', {}, [], new ArrayBuffer(8)]) {
    expect(() => deriveRestrictedReviewCatalog(value as Uint8Array)).toThrow('bytes');
  }
  for (const value of [new Uint8Array(0), new Uint8Array(131073)]) {
    expect(() => deriveRestrictedReviewCatalog(value)).toThrow('size');
  }
});

test('does not retain mutable caller bytes or mutable result properties', () => {
  const input = Uint8Array.from(fixture);
  const result = deriveRestrictedReviewCatalog(input);
  const text = result.catalogText;
  input.fill(0);
  expect(result.catalogText).toBe(text);
  expect(Object.isFrozen(result)).toBe(true);
  expect(() => {
    (result as { catalogText: string }).catalogText = 'changed';
  }).toThrow();
  expect(deriveRestrictedReviewCatalog(fixture)).toEqual(result);
});
