import { expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LineCounter, isScalar, parseDocument, visit } from 'yaml';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';

const root = join(import.meta.dir, '../../..');
const defaults = join(root, '.archon/workflows/defaults');
const lanes = [
  'bdc-feature-development',
  ...[
    'astra',
    'codex',
    'codex-only',
    'cursor',
    'fable',
    'fusion-cx-kimi',
    'fusion-cx-qwen',
    'grok',
    'kimi-k3',
    'zero',
    'zero-claude',
    'zero-open',
  ].map(suffix => `bdc-feature-development-${suffix}`),
  'bdc-canary-layer2-trivial',
];
const moved = [
  'bdc-feature-development',
  'bdc-feature-development-codex-only',
  'bdc-feature-development-fable',
  'bdc-feature-development-grok',
  'bdc-feature-development-zero-claude',
  'bdc-feature-development-zero',
  'bdc-canary-layer2-trivial',
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function modelsIn(text: string, file: string): { model: string; location: string }[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter });
  expect(document.errors, file).toEqual([]);
  const models: { model: string; location: string }[] = [];
  visit(document, {
    Pair(_key, pair) {
      if (!isScalar(pair.key) || !['model', 'failover_model'].includes(String(pair.key.value)))
        return;
      expect(isScalar(pair.value), file).toBe(true);
      if (!isScalar(pair.value)) return;
      const line = lineCounter.linePos(pair.value.range?.[0] ?? 0).line;
      models.push({ model: String(pair.value.value), location: `${file}:${line}` });
    },
  });
  return models;
}

function violationsIn(text: string, file: string): string[] {
  return modelsIn(text, file)
    .filter(({ model }) => !MODEL_ALLOWLIST.has(model))
    .map(({ model, location }) => `${location}: ${model}`);
}

function claudeViolationsIn(text: string, file: string): string[] {
  if (file.endsWith('.md')) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!frontmatter) return [];
    text = `\n${frontmatter[1]}`;
  }
  return modelsIn(text, file)
    .filter(({ model }) => /^(?:opus|sonnet|haiku)/i.test(model) && !MODEL_ALLOWLIST.has(model))
    .map(({ model, location }) => `${location}: bare Claude alias ${model}`);
}

const startThread = mock((_options: unknown) => ({
  id: 'allowlist-test',
  runStreamed: async () => ({
    events: (async function* () {
      yield {
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
      };
    })(),
  }),
}));
mock.module('@openai/codex-sdk', () => ({
  Codex: class {
    startThread = startThread;
  },
}));
mock.module('../../providers/src/codex/binary-resolver', () => ({
  resolveCodexBinaryPath: async () => '/unused/codex',
  fileExists: async () => false,
}));
mock.module('../../providers/src/auth-refresh/index.js', () => ({
  ensureFreshAuth: async () => {},
  refreshIfAuthFailed: async () => ({ refreshed: false, reason: 'no_creds' }),
  isTerminalRefreshReason: () => false,
  buildReauthMessage: () => 'test auth failure',
  AUTH_PATTERNS: [],
  isAuthErrorMessage: () => false,
}));

const { MODEL_ALLOWLIST, CODEX_FALLBACK_MODEL, CodexProvider, resetCodexSingleton } =
  await import('@archon/providers');

async function resolvedModel(model?: string): Promise<unknown> {
  resetCodexSingleton();
  startThread.mockClear();
  const provider = new CodexProvider();
  for await (const chunk of provider.sendQuery('ok', '/tmp', undefined, { model })) {
    expect(chunk.isError).not.toBe(true);
  }
  return (startThread.mock.calls[0]?.[0] as { model?: string }).model;
}

test('lanes_use_allowlisted_models', () => {
  const violations = lanes.flatMap(lane => {
    const file = join(defaults, `${lane}.yaml`);
    const text = readFileSync(file, 'utf8');
    expect(modelsIn(text, file).length).toBeGreaterThan(0);
    return violationsIn(text, relative(root, file));
  });
  for (const directory of ['.archon/agents', 'packages/personas', '.archon/workflows']) {
    for (const file of filesUnder(join(root, directory))) {
      if (!/\.(?:md|ya?ml)$/.test(file)) continue;
      violations.push(...claudeViolationsIn(readFileSync(file, 'utf8'), relative(root, file)));
    }
  }
  expect(violations).toEqual([]);
  expect(readFileSync(join(defaults, 'bdc-feature-development-astra.yaml'), 'utf8')).toContain(
    'gpt-6-astra'
  );
});

test('provider_default_allowlisted', async () => {
  expect(CODEX_FALLBACK_MODEL).toBe('gpt-6.1-sol');
  expect(MODEL_ALLOWLIST.has(CODEX_FALLBACK_MODEL)).toBe(true);
  for (const model of [undefined, 'gpt-5.3-codex', 'gpt-5.2-codex']) {
    expect(await resolvedModel(model), String(model)).toBe(CODEX_FALLBACK_MODEL);
  }
});

test('codex_default_model_env_honored_or_absent', async () => {
  const previous = process.env.CODEX_DEFAULT_MODEL;
  try {
    process.env.CODEX_DEFAULT_MODEL = 'gpt-5.5';
    expect(await resolvedModel()).toBe('gpt-6.1-sol');
  } finally {
    if (previous === undefined) delete process.env.CODEX_DEFAULT_MODEL;
    else process.env.CODEX_DEFAULT_MODEL = previous;
  }
  const sources = [
    ...filesUnder(join(root, 'packages')).filter(
      file => file.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(file)
    ),
    ...filesUnder(join(root, '.archon')).filter(file => /\.ya?ml$/.test(file)),
  ];
  expect(
    sources.filter(file => readFileSync(file, 'utf8').includes('CODEX_DEFAULT_MODEL'))
  ).toEqual([]);
});

test('bundled_defaults_regenerated', () => {
  for (const lane of moved) {
    const file = `${lane}.yaml`;
    const text = readFileSync(join(defaults, file), 'utf8');
    expect(BUNDLED_WORKFLOWS[lane], file).toBe(text);
    expect(BUNDLED_WORKFLOWS[lane], file).not.toContain('gpt-5.6');
  }
});

test.each(['fable', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-5'])(
  'Claude scan rejects unlisted %s in frontmatter and flow maps',
  model => {
    expect(claudeViolationsIn(`---\nmodel: ${model}\n---\nPrompt.`, 'agent.md')).toHaveLength(1);
    expect(claudeViolationsIn(`nodes: [{id: x, model: ${model}}]`, 'workflow.yaml')).toHaveLength(
      1
    );
  }
);

test('Claude scan fails on a BOM before frontmatter', () => {
  expect(() => claudeViolationsIn('\uFEFF---\nmodel: opus\n---\nPrompt.', 'agent.md')).toThrow(
    'BOM'
  );
});

test('allowlist_rejects_unlisted_model', () => {
  expect(claudeViolationsIn('---\nmodel: opus[1m]\n---\nPrompt.', 'agent.md')).toEqual([
    'agent.md:2: bare Claude alias opus[1m]',
  ]);
  expect(claudeViolationsIn('nodes: [{id: x, model: sonnet}]', 'workflow.yaml')).toEqual([
    'workflow.yaml:1: bare Claude alias sonnet',
  ]);
  for (const model of MODEL_ALLOWLIST) {
    expect(claudeViolationsIn(`---\nmodel: "${model}"\n---\nPrompt.`, 'agent.md')).toEqual([]);
  }
  for (const model of [
    'gpt-5.6-sol',
    'made-up-model-9',
    'opus',
    'opus[1m]',
    'sonnet',
    'haiku',
    'sonnet[1m]',
    'opusplan',
  ]) {
    for (const key of ['model', 'failover_model']) {
      expect(violationsIn(`${key}: "${model}" # fixture`, 'synthetic.yaml')).toEqual([
        `synthetic.yaml:1: ${model}`,
      ]);
    }
  }
});
