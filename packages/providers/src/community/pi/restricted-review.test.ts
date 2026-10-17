import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  REVIEW_DIGEST,
  REVIEW_ENDPOINT,
  REVIEW_MODEL,
  REVIEW_PROVIDER,
  REVIEW_REF,
  REVIEW_SYSTEM,
  validateRestrictedReview,
  parseReviewVerdict,
} from './restricted-review-policy';

function packageText(): string {
  return JSON.stringify({
    complete: true,
    artifacts: ['spec', 'diff', 'tests'].map(id => ({
      id,
      content: id + ' fixture',
      sha256: createHash('sha256')
        .update(id + ' fixture')
        .digest('hex'),
    })),
  });
}
const selected = { id: REVIEW_MODEL, provider: REVIEW_PROVIDER, baseUrl: `${REVIEW_ENDPOINT}/v1` };
let loaded = false;
let systemPrompt = '';
let fallback: string | undefined;
let sessionModel = { ...selected };
let digest = REVIEW_DIGEST;
let contextLength = 8192;
let output = JSON.stringify({
  verdict: 'REJECTED',
  reasons: ['missing evidence'],
  evidenceIds: ['tests'],
});
let stopReason = 'stop';
let prompted = 0;
let disposed = 0;
let postDigest: string | undefined;
let unexpectedAction = false;
let construction: Record<string, unknown> | undefined;
const fakeSession = {
  get systemPrompt() {
    return systemPrompt;
  },
  get model() {
    return sessionModel;
  },
  getActiveToolNames: () => [],
  abort: async () => {
    throw new Error('abort must not be called after bridge disposal');
  },
  dispose: () => {
    disposed++;
  },
};
mock.module('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => {} }) },
  ModelRegistry: {
    inMemory: () => ({
      registerProvider: (_name: string, config: { apiKey?: string }) => {
        if (config.apiKey !== 'local-no-auth')
          throw new Error('explicit local placeholder required');
      },
      find: () => selected,
    }),
  },
  SettingsManager: { inMemory: () => ({}) },
  SessionManager: { inMemory: () => ({}) },
  DefaultResourceLoader: class {
    constructor(public options: unknown) {}
    async reload() {
      loaded = true;
    }
    getSystemPrompt() {
      return loaded ? REVIEW_SYSTEM : undefined;
    }
    getAppendSystemPrompt() {
      return [];
    }
    getExtensions() {
      return { extensions: [], errors: [] };
    }
    getSkills() {
      return { skills: [] };
    }
    getPrompts() {
      return { prompts: [] };
    }
    getAgentsFiles() {
      return { agentsFiles: [] };
    }
  },
  createAgentSession: async (options: Record<string, unknown>) => {
    construction = options;
    return {
      session: fakeSession,
      modelFallbackMessage: fallback,
      extensionsResult: { extensions: [], errors: [] },
    };
  },
}));
mock.module('./event-bridge', () => ({
  bridgeSession: async function* () {
    try {
      prompted++;
      if (postDigest) digest = postDigest;
      if (unexpectedAction) yield { type: 'tool_use', name: 'synthetic' };
      yield { type: 'assistant', content: output };
      yield { type: 'result', stopReason };
    } finally {
      fakeSession.dispose();
    }
  },
}));
const { runRestrictedReview } = await import('./restricted-review');
const originalFetch = globalThis.fetch;
const proxyKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
];
const savedProxy = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of proxyKeys) delete process.env[key];
  loaded = false;
  systemPrompt =
    REVIEW_SYSTEM + '\nCurrent date: 2026-10-17\nCurrent working directory: /workspace';
  fallback = undefined;
  sessionModel = { ...selected };
  digest = REVIEW_DIGEST;
  contextLength = 8192;
  prompted = 0;
  disposed = 0;
  postDigest = undefined;
  unexpectedAction = false;
  construction = undefined;
  stopReason = 'stop';
  output = JSON.stringify({
    verdict: 'REJECTED',
    reasons: ['missing evidence'],
    evidenceIds: ['tests'],
  });
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    expect([`${REVIEW_ENDPOINT}/api/tags`, `${REVIEW_ENDPOINT}/api/ps`]).toContain(String(url));
    return Response.json({
      models: [{ name: REVIEW_MODEL, digest, context_length: contextLength }],
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of proxyKeys) {
    if (savedProxy[key] === undefined) delete process.env[key];
    else process.env[key] = savedProxy[key];
  }
});
async function collect() {
  const chunks = [];
  for await (const chunk of runRestrictedReview(packageText())) chunks.push(chunk);
  return chunks;
}

describe('restricted text-only reviewer candidate', () => {
  it('requires a complete hash-bound artifact package and fixed request identity', () => {
    expect(() =>
      validateRestrictedReview(
        packageText(),
        '/workspace',
        undefined,
        { model: REVIEW_REF },
        '/workspace'
      )
    ).not.toThrow();
    for (const options of [
      { env: {} },
      { nodeConfig: { allowed_tools: [] } },
      { model: 'other' },
      { forkSession: false },
    ])
      expect(() =>
        validateRestrictedReview(packageText(), '/workspace', undefined, options, '/workspace')
      ).toThrow();
    expect(() =>
      validateRestrictedReview(packageText(), '/workspace', 'old', undefined, '/workspace')
    ).toThrow();
    expect(() =>
      validateRestrictedReview(
        packageText().replace('spec fixture', 'tampered'),
        '/workspace',
        undefined,
        undefined,
        '/workspace'
      )
    ).toThrow();
    expect(() =>
      validateRestrictedReview(
        packageText().replace('"complete":true', '"complete":false'),
        '/workspace',
        undefined,
        undefined,
        '/workspace'
      )
    ).toThrow();
  });
  it('constructs a tool-free fresh session and emits only a parsed verdict after identity checks', async () => {
    const chunks = await collect();
    expect(loaded).toBe(true);
    expect(construction?.tools).toEqual([]);
    expect(construction?.customTools).toEqual([]);
    expect(construction?.scopedModels).toEqual([]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      type: 'result',
      structuredOutput: { verdict: 'REJECTED' },
      servedModelId: null,
    });
    expect(prompted).toBe(1);
    expect(disposed).toBeGreaterThan(0);
  });
  it('rejects altered effective instructions before prompting and disposes', async () => {
    systemPrompt = 'default prompt';
    await expect(collect()).rejects.toThrow('mismatch');
    expect(prompted).toBe(0);
    expect(disposed).toBe(1);
  });
  it('rejects fallback and disposes before any prompt', async () => {
    fallback = 'different model selected';
    await expect(collect()).rejects.toThrow('fallback');
    expect(prompted).toBe(0);
    expect(disposed).toBe(1);
  });
  it('rejects selected endpoint drift before prompt', async () => {
    sessionModel.baseUrl = 'http://unapproved.invalid';
    await expect(collect()).rejects.toThrow('mismatch');
    expect(prompted).toBe(0);
  });
  it('rejects model digest drift before session construction', async () => {
    digest = 'different';
    await expect(collect()).rejects.toThrow('digest');
    expect(construction).toBeUndefined();
    expect(prompted).toBe(0);
  });
  it('rejects unqualified effective context before session creation', async () => {
    contextLength = 4096;
    await expect(collect()).rejects.toThrow('capacity');
    expect(construction).toBeUndefined();
    expect(prompted).toBe(0);
  });
  it('rejects inherited proxy settings before any fetch', async () => {
    process.env.HTTP_PROXY = 'http://synthetic.invalid';
    await expect(collect()).rejects.toThrow('proxy');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('rejects digest changes after inference without emitting a verdict', async () => {
    postDigest = 'changed';
    const chunks = [];
    await expect(
      (async () => {
        for await (const chunk of runRestrictedReview(packageText())) chunks.push(chunk);
      })()
    ).rejects.toThrow('digest');
    expect(chunks).toHaveLength(0);
    expect(disposed).toBe(1);
  });
  it('rejects unexpected tool actions', async () => {
    unexpectedAction = true;
    await expect(collect()).rejects.toThrow('unexpected');
    expect(disposed).toBe(1);
  });
  it('leaves cleanup with the bridge once prompting begins', async () => {
    await collect();
    expect(disposed).toBe(1);
  });
  it('rejects non-string or duplicate evidence identities', () => {
    for (const evidenceIds of [[['spec']], ['spec', 'spec']]) {
      expect(() =>
        parseReviewVerdict(
          JSON.stringify({
            verdict: 'APPROVED',
            reasons: ['fixture'],
            evidenceIds,
          })
        )
      ).toThrow();
    }
  });
  it('fails closed on truncated output and malformed verdicts', async () => {
    stopReason = 'length';
    await expect(collect()).rejects.toThrow('truncated');
    expect(() => parseReviewVerdict('APPROVED')).toThrow();
    expect(() =>
      parseReviewVerdict('{"verdict":"APPROVED","reasons":[],"evidenceIds":[]}')
    ).toThrow();
  });
});

it('enforces every declared verdict rule without repairing malformed responses', () => {
  const valid = {
    verdict: 'APPROVED',
    reasons: ['verified'],
    evidenceIds: ['spec', 'diff', 'tests'],
  };
  expect(parseReviewVerdict(JSON.stringify(valid))).toEqual(valid);
  for (const value of [
    null,
    [],
    { ...valid, extra: true },
    { ...valid, verdict: 'MAYBE' },
    { ...valid, reasons: [] },
    { ...valid, reasons: Array(13).fill('reason') },
    { ...valid, reasons: [' '] },
    { ...valid, reasons: ['x'.repeat(501)] },
    { ...valid, reasons: [1] },
    { ...valid, evidenceIds: [] },
    { ...valid, evidenceIds: ['spec'] },
    { ...valid, evidenceIds: ['spec', 'diff', 'unknown'] },
    { ...valid, evidenceIds: ['spec', 'diff', 'diff'] },
  ])
    expect(() => parseReviewVerdict(JSON.stringify(value))).toThrow();
  for (const text of [
    'Verdict: ' + JSON.stringify(valid),
    '```json\n' + JSON.stringify(valid) + '\n```',
    'x'.repeat(6001),
  ])
    expect(() => parseReviewVerdict(text)).toThrow();
  expect(
    parseReviewVerdict(JSON.stringify({ ...valid, verdict: 'REJECTED', evidenceIds: ['tests'] }))
      .verdict
  ).toBe('REJECTED');
});
