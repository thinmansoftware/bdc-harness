/**
 * OpenRouter review fence unit tests (WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01).
 *
 * Tests 1, 2, 3, 4, 7 (fence module: pattern matching, gitleaks invocation,
 * fail-closed on missing binary / missing env) plus the OpenRouter client
 * privacy pin (Test 1 request body) and the no-private-endpoint fail-closed
 * guarantee (no unpinned retry).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';

// NOTE: Stop 6 runs this file in the SAME `bun test` process as
// openrouter-diff-scan-gate.test.ts and docker-packaging.test.ts. mock.module()
// is process-global and irreversible, so this file must NOT mock any module
// those two depend on (e.g. @archon/paths) -- doing so strips exports they
// need. Only `openai` is mocked here; neither sibling instantiates a real
// OpenAI client, so that mock is inert for them.

// --- Mock openai; each test can set the next create() behavior -------------
interface CapturedCall {
  body: Record<string, unknown>;
}
const captured: CapturedCall[] = [];
// Default: a minimal streaming response (one assistant chunk + usage).
let createImpl: (body: Record<string, unknown>) => unknown = () => ({
  [Symbol.asyncIterator]: async function* () {
    yield { choices: [{ delta: { content: 'ok' } }], usage: null, model: 'z-ai/glm-5.2' };
    yield {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: 'z-ai/glm-5.2',
    };
  },
});
const mockCreate = mock((body: Record<string, unknown>) => {
  captured.push({ body });
  return createImpl(body);
});
const mockOpenAI = mock(function () {
  return { chat: { completions: { create: mockCreate } } };
});
mock.module('openai', () => ({ default: mockOpenAI, OpenAI: mockOpenAI }));

// --- Import under test (after mocks) ---------------------------------------
import {
  CUSTOMER_REPOS,
  formatHitLocation,
  isCustomerRepo,
  isNoPrivateEndpointError,
  isOpenRouterRoute,
  normalizeRepoSlug,
  scanDiffForOpenRouter,
  type GitleaksResult,
} from './openrouter-review-fence';
import { GlmProvider } from './community/glm/provider';
import {
  buildOpenRouterChatMessages,
  serializeOpenRouterRequestContent,
} from './openrouter-request';
import { GrokAgentProvider } from './community/grok/provider';

const SLUGS = ['mutant-market'];
const cleanGitleaks = (): Promise<GitleaksResult> =>
  Promise.resolve({ available: true, findings: [] });

function gitleaksBinaryPresent(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('gitleaks', ['version'], err => resolve(!err));
  });
}

describe('fence classifiers', () => {
  test('isOpenRouterRoute matches all OpenRouter-backed seats + codex-opr', () => {
    for (const id of ['openrouter', 'grok', 'opr', 'opr-zero', 'glm', 'codex-opr']) {
      expect(isOpenRouterRoute(id, 'deepseek/deepseek-v4-pro')).toBe(true);
    }
    expect(isOpenRouterRoute('codex-native-strict', 'anything')).toBe(false);
    expect(isOpenRouterRoute('claude', 'sonnet')).toBe(false);
    expect(isOpenRouterRoute(undefined)).toBe(false);
  });

  test('normalizeRepoSlug + isCustomerRepo recognize the three customer repos', () => {
    expect(normalizeRepoSlug('git@github.com:thinmansoftware/lspro-react.git')).toBe(
      'thinmansoftware/lspro-react'
    );
    expect(normalizeRepoSlug('https://github.com/thinmansoftware/Shopops')).toBe(
      'thinmansoftware/shopops'
    );
    expect(normalizeRepoSlug('not a remote at all!')).toBeNull();
    for (const repo of CUSTOMER_REPOS) {
      expect(isCustomerRepo(repo)).toBe(true);
    }
    expect(isCustomerRepo('thinmansoftware/bdc-harness')).toBe(false);
    expect(isCustomerRepo(null)).toBe(false);
  });

  test('isNoPrivateEndpointError matches data-policy refusals only', () => {
    expect(isNoPrivateEndpointError('No endpoints found matching your data policy (zdr)')).toBe(
      true
    );
    expect(
      isNoPrivateEndpointError('No allowed providers satisfy the data_collection policy')
    ).toBe(true);
    expect(isNoPrivateEndpointError('rate limit exceeded')).toBe(false);
    expect(isNoPrivateEndpointError(undefined)).toBe(false);
  });
});

describe('scanDiffForOpenRouter patterns', () => {
  // Test 2: customer email in a fixture reroutes (hit), value never surfaced.
  test('Test 2: customer email in tests/fixtures/orders.json is an email hit', async () => {
    const diff = [
      'diff --git a/tests/fixtures/orders.json b/tests/fixtures/orders.json',
      '--- a/tests/fixtures/orders.json',
      '+++ b/tests/fixtures/orders.json',
      '@@ -1,1 +1,2 @@',
      ' {',
      '+  email: "jane.customer@gmail.com"',
    ].join('\n');
    const result = await scanDiffForOpenRouter(diff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.verdict).toBe('hit');
    expect(result.hits.some(h => h.kind === 'email')).toBe(true);
    const emailHit = result.hits.find(h => h.kind === 'email');
    expect(emailHit?.file).toBe('tests/fixtures/orders.json');
    // The matched value must never appear anywhere in the result.
    expect(JSON.stringify(result)).not.toContain('jane.customer');
  });

  // Test 3: phone, Stripe and tenant slug kinds + ignores.
  test('Test 3: phone / stripe_id / tenant_slug kinds, with ignores', async () => {
    const phone = await scanDiffForOpenRouter('+1  +  phone: 555-867-5309\n', {
      mode: 'prompt',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(phone.hits.some(h => h.kind === 'phone')).toBe(true);

    const stripe = await scanDiffForOpenRouter('+  id: cus_N1x2Y3z4W5v6\n', {
      mode: 'prompt',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(stripe.hits.some(h => h.kind === 'stripe_id')).toBe(true);

    const seedDiff = [
      '+++ b/seed/tenants.sql',
      '@@ -0,0 +1,1 @@',
      "+INSERT INTO tenants (slug) VALUES ('mutant-market');",
    ].join('\n');
    const slug = await scanDiffForOpenRouter(seedDiff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(slug.hits.some(h => h.kind === 'tenant_slug')).toBe(true);

    // Same slug in a non-fixture path (src/app.ts) is NOT a tenant_slug hit.
    const appDiff = [
      '+++ b/src/app.ts',
      '@@ -0,0 +1,1 @@',
      "+const tenant = 'mutant-market';",
    ].join('\n');
    const notSlug = await scanDiffForOpenRouter(appDiff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(notSlug.hits.some(h => h.kind === 'tenant_slug')).toBe(false);

    // Ignored addresses/domains are not email hits.
    const ignored = await scanDiffForOpenRouter(
      '+ noreply@anthropic.com and a@example.com and b@example.org',
      { mode: 'prompt', tenantSlugs: SLUGS, gitleaksRunner: cleanGitleaks }
    );
    expect(ignored.hits.some(h => h.kind === 'email')).toBe(false);
  });

  // Prompt-mode hits must carry the ACTUAL character offset of each match
  // (prompt:<offset>), not the text length. Two patterns at known, distinct
  // offsets in a single prompt body must each report their own offset.
  test('prompt-mode hits record the matched character offset, not text length', async () => {
    const lead = 'Persona reviewer. ';
    const email = 'jane.customer@gmail.com';
    const mid = ' then call ';
    const phone = '555-867-5309';
    const text = `${lead}${email}${mid}${phone}.`;
    const emailOffset = text.indexOf(email);
    const phoneOffset = text.indexOf(phone);

    const result = await scanDiffForOpenRouter(text, {
      mode: 'prompt',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.verdict).toBe('hit');

    const emailHit = result.hits.find(h => h.kind === 'email');
    const phoneHit = result.hits.find(h => h.kind === 'phone');
    expect(emailHit?.file).toBe('prompt');
    expect(emailHit?.line).toBe(emailOffset);
    expect(phoneHit?.line).toBe(phoneOffset);
    // The two offsets differ and neither is the length of the scanned text.
    expect(emailOffset).not.toBe(phoneOffset);
    expect(emailHit?.line).not.toBe(text.length);
    expect(phoneHit?.line).not.toBe(text.length);
    // The event-location contract renders as prompt:<offset>.
    expect(emailHit && formatHitLocation(emailHit)).toBe(`prompt:${emailOffset}`);
    expect(phoneHit && formatHitLocation(phoneHit)).toBe(`prompt:${phoneOffset}`);
  });

  // Test 11 coverage at the fence layer: removed/context lines + prompt text
  // are all scanned (Overseer 0c58a582).
  test('Test 11 (fence): removed and context lines are scanned', async () => {
    const removed = [
      '+++ b/tests/fixtures/orders.json',
      '@@ -1,2 +1,1 @@',
      '-  email: "jane.customer@gmail.com"',
      '   id: cus_N1x2Y3z4W5v6',
    ].join('\n');
    const result = await scanDiffForOpenRouter(removed, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.hits.some(h => h.kind === 'email')).toBe(true);
    expect(result.hits.some(h => h.kind === 'stripe_id')).toBe(true);
  });

  test('deleted fixture: removed lines keep the old-side path so a tenant slug is a hit', async () => {
    // Deleting seed/tenants.sql: `+++ /dev/null` must not leave the removed
    // lines attributed to the previous file (Overseer f90adfec).
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      'diff --git a/seed/tenants.sql b/seed/tenants.sql',
      'deleted file mode 100644',
      '--- a/seed/tenants.sql',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      "-INSERT INTO tenants (slug) VALUES ('mutant-market');",
      '-SELECT 1;',
    ].join('\n');
    const result = await scanDiffForOpenRouter(diff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.verdict).toBe('hit');
    const slugHit = result.hits.find(h => h.kind === 'tenant_slug');
    expect(slugHit?.file).toBe('seed/tenants.sql');
    expect(slugHit?.line).toBe(1);
    expect(JSON.stringify(result)).not.toContain('mutant-market');
  });

  test('deleted fixture with no diff --git header still uses the old-side path', async () => {
    const diff = [
      '--- a/tests/fixtures/tenants.json',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-  "slug": "mutant-market"',
    ].join('\n');
    const result = await scanDiffForOpenRouter(diff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.verdict).toBe('hit');
    expect(result.hits.find(h => h.kind === 'tenant_slug')?.file).toBe(
      'tests/fixtures/tenants.json'
    );
  });

  test('added file: --- /dev/null does not clobber the new-side path', async () => {
    const diff = [
      'diff --git a/seed/new.sql b/seed/new.sql',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/seed/new.sql',
      '@@ -0,0 +1,1 @@',
      "+INSERT INTO tenants (slug) VALUES ('mutant-market');",
    ].join('\n');
    const result = await scanDiffForOpenRouter(diff, {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.hits.find(h => h.kind === 'tenant_slug')?.file).toBe('seed/new.sql');
  });

  // Test 4: gitleaks finding reroutes (real binary; skip with a named reason).
  test('Test 4: a gitleaks finding is a gitleaks hit with its RuleID', async () => {
    if (!(await gitleaksBinaryPresent())) {
      // eslint-disable-next-line no-console
      console.warn('Test 4 skipped: gitleaks binary absent on runner (Test 7 covers fail-closed)');
      return;
    }
    const diff = ['+++ b/config.ts', '@@ -0,0 +1,1 @@', '+const k = "AKIAIOSFODNN7EXAMPLE";'].join(
      '\n'
    );
    const result = await scanDiffForOpenRouter(diff, { mode: 'diff', tenantSlugs: SLUGS });
    expect(result.verdict).toBe('hit');
    const gl = result.hits.find(h => h.kind === 'gitleaks');
    expect(gl).toBeDefined();
    expect(typeof gl?.ruleId).toBe('string');
  });

  // Test 7: fail closed when scan cannot run.
  test('Test 7: gitleaks unavailable -> scan_unavailable (gitleaks_unavailable)', async () => {
    const result = await scanDiffForOpenRouter('+ hello world\n', {
      mode: 'diff',
      tenantSlugs: SLUGS,
      gitleaksRunner: () => Promise.resolve({ available: false, findings: [] }),
    });
    expect(result.verdict).toBe('scan_unavailable');
    expect(result.reason).toBe('gitleaks_unavailable');
  });

  test('Test 7: empty tenant slugs -> scan_unavailable (tenant_slugs_unset)', async () => {
    const result = await scanDiffForOpenRouter('+ hello\n', {
      mode: 'diff',
      tenantSlugs: [],
      gitleaksRunner: cleanGitleaks,
    });
    expect(result.verdict).toBe('scan_unavailable');
    expect(result.reason).toBe('tenant_slugs_unset');
  });
});

describe('OpenRouter client privacy pin', () => {
  beforeEach(() => {
    captured.length = 0;
    mockCreate.mockClear();
    process.env.GLM_API_KEY = 'test-key';
    createImpl = () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'ok' } }], usage: null, model: 'z-ai/glm-5.2' };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: 'z-ai/glm-5.2',
        };
      },
    });
  });
  afterEach(() => {
    delete process.env.GLM_API_KEY;
  });

  // Test 1: clean route pins data_collection:deny + zdr:true on the request.
  test('Test 1: GlmProvider adds provider.data_collection deny + zdr true when pinned', async () => {
    const provider = new GlmProvider();
    for await (const _ of provider.sendQuery('review this', '/tmp/x', undefined, {
      openrouterPrivacyPin: true,
    })) {
      // drain
    }
    expect(captured.length).toBe(1);
    const sent = captured[0]?.body.provider as { data_collection?: string; zdr?: boolean };
    expect(sent?.data_collection).toBe('deny');
    expect(sent?.zdr).toBe(true);
  });

  test('GlmProvider transmits exactly the shared builder output the fence scans', async () => {
    // The executor's fence scans serializeOpenRouterRequestContent(); this
    // proves GlmProvider sends that same content: system prompt, user prompt
    // and the appended outputFormat.schema (Overseer major, PRs 1426/1428).
    const options = {
      systemPrompt: 'You are a careful code reviewer.',
      outputFormat: {
        type: 'json_schema' as const,
        schema: { type: 'object', properties: { contact: { description: 'x@y.example' } } },
      },
      openrouterPrivacyPin: true,
    };
    const provider = new GlmProvider();
    for await (const _ of provider.sendQuery('review this', '/tmp/x', undefined, options)) {
      // drain
    }
    expect(captured.length).toBe(1);
    const messages = captured[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual(buildOpenRouterChatMessages('review this', options));
    expect(messages.map(m => m.content).join('\n\n')).toBe(
      serializeOpenRouterRequestContent('review this', options)
    );
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a careful code reviewer.' });
    expect(messages[1]?.content).toContain('"description":"x@y.example"');
  });

  test('Test 1: no pin -> no provider field on the request body', async () => {
    const provider = new GlmProvider();
    for await (const _ of provider.sendQuery('review this', '/tmp/x', undefined, {})) {
      // drain
    }
    expect(captured[0]?.body.provider).toBeUndefined();
  });

  test('GrokAgentProvider pins data_collection deny + zdr true when pinned', async () => {
    createImpl = () => ({
      model: 'deepseek/deepseek-v4-pro',
      choices: [{ message: { content: 'done', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new GrokAgentProvider({
      assistantConfig: { model: 'deepseek/deepseek-v4-pro' },
    });
    for await (const _ of provider.sendQuery('review this', '/tmp/x', undefined, {
      openrouterPrivacyPin: true,
    })) {
      // drain
    }
    const sent = captured[0]?.body.provider as { data_collection?: string; zdr?: boolean };
    expect(sent?.data_collection).toBe('deny');
    expect(sent?.zdr).toBe(true);
  });
});

describe('no private endpoint fail-closed (Test 8: no unpinned retry)', () => {
  beforeEach(() => {
    captured.length = 0;
    mockCreate.mockClear();
    process.env.GLM_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.GLM_API_KEY;
  });

  test('GlmProvider throws openrouter_no_private_endpoint and does NOT retry unpinned', async () => {
    createImpl = () => {
      throw new Error('No endpoints found matching your data policy (zdr)');
    };
    const provider = new GlmProvider();
    let threw: Error | undefined;
    try {
      for await (const _ of provider.sendQuery('review', '/tmp/x', undefined, {
        openrouterPrivacyPin: true,
      })) {
        // drain
      }
    } catch (e) {
      threw = e as Error;
    }
    expect(threw?.message).toContain('openrouter_no_private_endpoint');
    // Exactly one request: never retried without the pin.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('GrokAgentProvider throws openrouter_no_private_endpoint and does NOT retry unpinned', async () => {
    createImpl = () => {
      throw new Error('No allowed providers satisfy the data_collection:deny policy');
    };
    const provider = new GrokAgentProvider({
      assistantConfig: { model: 'deepseek/deepseek-v4-pro' },
    });
    let threw: Error | undefined;
    try {
      for await (const _ of provider.sendQuery('review', '/tmp/x', undefined, {
        openrouterPrivacyPin: true,
      })) {
        // drain
      }
    } catch (e) {
      threw = e as Error;
    }
    expect(threw?.message).toContain('openrouter_no_private_endpoint');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
