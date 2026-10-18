import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { restrictedClientOptions } from '../../packages/providers/src/codex/restricted-policy';
import {
  fixtureClientOptions,
  compareBundledCatalog,
  parseUniqueFixtureJson,
  REVIEWER_DISABLED_FEATURES,
  inspectReviewerRequest,
  fixtureCaseAccepted,
  validateFixtureFinalText,
} from './teetime-reviewer-fixture';

const raw = readFileSync(
  new URL('../../packages/providers/src/codex/restricted-review-model-base.json', import.meta.url)
);
const original = JSON.parse(raw.toString());
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test('fixture options preserve restricted controls and expose no caller override argument', () => {
  const base = restrictedClientOptions();
  const actual = fixtureClientOptions();
  expect(actual).toEqual({
    ...base,
    config: {
      ...base.config,
      model_catalog_json: '/home/appuser/.codex/reviewer-models.json',
      tools: {
        update_plan: { enabled: false },
        experimental_request_user_input: { enabled: false },
      },
      features: {
        ...(base.config!.features as object),
        ...Object.fromEntries(REVIEWER_DISABLED_FEATURES.map(key => [key, false])),
      },
    },
  });
  expect(actual.env).toEqual(base.env);
  expect(actual.configOverrides).toEqual(base.configOverrides);
  expect(fixtureClientOptions.length).toBe(0);
  expect(REVIEWER_DISABLED_FEATURES).toContain('shell_tool');
  expect(REVIEWER_DISABLED_FEATURES).toContain('code_mode_host');
  expect(REVIEWER_DISABLED_FEATURES).toContain('request_permissions_tool');
  expect(REVIEWER_DISABLED_FEATURES).toContain('image_generation');
  expect(REVIEWER_DISABLED_FEATURES).toContain('deferred_tool_world_state');
});

test('compares full parsed installed entry while preserving exact frozen-source derivation', () => {
  const result = compareBundledCatalog(encode(original), raw);
  expect(JSON.parse(result.catalogText).models[0].slug).toBe('gpt-5.6-sol');
  expect(result.installedOutputHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sourceFixtureHash).toBe(
    '59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6'
  );
  expect(result.installedOutputHash).not.toBe(result.sourceFixtureHash);
});

test('rejects every selected-entry delta, omission or duplicate selected entry', () => {
  for (const patch of [
    { context_window: 1 },
    { shell_type: 'disabled' },
    { model_messages: {} },
    { unexpected: false },
  ]) {
    const changed = structuredClone(original);
    Object.assign(changed.models[0], patch);
    expect(() => compareBundledCatalog(encode(changed), raw)).toThrow('entry');
  }
  const changed = structuredClone(original);
  delete changed.models[0].effective_context_window_percent;
  expect(() => compareBundledCatalog(encode(changed), raw)).toThrow('entry');
  changed.models = [original.models[0], original.models[0]];
  expect(() => compareBundledCatalog(encode(changed), raw)).toThrow('entry');
});

test('strict fixture JSON rejects duplicate decoded keys, invalid syntax, depth and byte bounds', () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"a":{"b":1,"b":2}}',
    '{"a":1,}',
    '{"a":NaN}',
    '[01]',
    '[true false]',
    '{} trailing',
    '['.repeat(40) + ']'.repeat(40),
  ]) {
    expect(() => parseUniqueFixtureJson(new TextEncoder().encode(text))).toThrow();
  }
  expect(() => parseUniqueFixtureJson(new Uint8Array(1048577))).toThrow('bound');
  expect(() => parseUniqueFixtureJson(Uint8Array.of(255))).toThrow();
  const value = { a: ['comma,:}in string', true, null, -1.2e3], nested: { b: '\\"' } };
  expect(parseUniqueFixtureJson(encode(value))).toEqual(value);
});

test('does not permit duplicate keys in trusted CLI output or replacement source bytes', () => {
  const text = raw.toString().replace('"models":', '"models":[],"models":');
  expect(() => compareBundledCatalog(new TextEncoder().encode(text), raw)).toThrow();
  expect(() => compareBundledCatalog(raw, encode(original))).toThrow('identity');
});

const request = () => ({
  model: 'gpt-5.6-sol',
  stream: true,
  instructions: 'complete synthetic instructions',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture' }] }],
});

test('actual request gate rejects executable tools, additional-tools and unknown framing', () => {
  expect(inspectReviewerRequest(encode(request()), 1, 'positive').denialObserved).toBe(false);
  for (const patch of [
    { tools: [{ type: 'function', name: 'exec_command' }] },
    { tools: { namespace: 'functions' } },
    { namespace: { name: 'functions' } },
    { input: [{ type: 'additional_tools', tools: [{ name: 'exec' }] }] },
    { input: [{ type: 'extension', name: 'unexpected' }] },
  ])
    expect(() =>
      inspectReviewerRequest(encode({ ...request(), ...patch }), 1, 'positive')
    ).toThrow();
});

test('hostile request gate requires exact unsupported output and rejects successful tool results', () => {
  for (const [caseName, name] of [
    ['shell', 'exec_command'],
    ['patch', 'apply_patch'],
    ['code-mode', 'exec'],
  ] as const) {
    const body = {
      ...request(),
      input: [
        {
          type: 'function_call_output',
          call_id: 'teetime-reviewer-hostile',
          output: 'unsupported call: functions.' + name,
        },
      ],
    };
    expect(inspectReviewerRequest(encode(body), 2, caseName).denialObserved).toBe(true);
    for (const output of [
      'success',
      'Exit code: 0',
      'unsupported call: functions.other',
      '',
      { success: true },
    ])
      expect(() =>
        inspectReviewerRequest(
          encode({ ...body, input: [{ ...body.input[0], output }] }),
          2,
          caseName
        )
      ).toThrow();
  }
});

test('fixture acceptance fails closed on excess requests, final text and incomplete hostile custody', () => {
  expect(() => inspectReviewerRequest(encode(request()), 2, 'positive')).toThrow('count');
  expect(() => inspectReviewerRequest(encode(request()), 3, 'shell')).toThrow('count');
  expect(() => inspectReviewerRequest(encode(request()), 0, 'positive')).toThrow('count');
  expect(() => validateFixtureFinalText('{"approved":true}')).toThrow('final');
  validateFixtureFinalText('{"syntheticReviewer":"ready"}');
  const positive = {
    requests: 1,
    hostileEmitted: false,
    denialObserved: false,
    rawToolEvent: false,
  };
  expect(fixtureCaseAccepted('positive', positive)).toBe(true);
  const negative = { requests: 2, hostileEmitted: true, denialObserved: true, rawToolEvent: false };
  expect(fixtureCaseAccepted('shell', negative)).toBe(false);
  for (const patch of [
    { requests: 3 },
    { hostileEmitted: false },
    { denialObserved: false },
    { rawToolEvent: true },
  ])
    expect(() => fixtureCaseAccepted('shell', { ...negative, ...patch })).toThrow();
});
