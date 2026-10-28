import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase } from '@archon/core/db/connection';
import { clearServiceGitHubTokenCache } from '@archon/core/github/service-identity';
import {
  flushGitHubApiMeter,
  recordGitHubApiCall,
  resetGitHubApiMeterForTests,
} from '@archon/core/github/metering';
import {
  createDefaultReconcileDeps,
  runReconcileOnce,
  type ReconcileDeps,
  type ReconcileMergedPullRequest,
} from '../reconcile';

const envNames = [
  'ARCHON_HOME',
  'DATABASE_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_OVERSEER_ID',
  'GITHUB_APP_OVERSEER_INSTALLATION_ID',
  'GITHUB_APP_OVERSEER_PRIVATE_KEY',
  'GITHUB_APP_OVERSEER_PRIVATE_KEY_PATH',
] as const;
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const testHome = mkdtempSync(join(tmpdir(), 'reconcile-app-auth-'));
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const issue = {
  owner: 'fixture',
  repo: 'tracker',
  number: 1,
  title: 'fixture',
  state: 'open' as const,
};
const pr = {
  owner: 'fixture',
  repo: 'product',
  number: 2,
  title: 'fixture',
  htmlUrl: 'https://example.test/pr/2',
};
let calls: { auth: string; method: string; body: string; url: string }[];

beforeEach(async () => {
  await closeDatabase();
  clearServiceGitHubTokenCache();
  resetGitHubApiMeterForTests();
  for (const name of envNames) delete process.env[name];
  process.env.ARCHON_HOME = mkdtempSync(join(testHome, 'case-'));
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearServiceGitHubTokenCache();
  resetGitHubApiMeterForTests();
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(closeDatabase);

function app(): void {
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_INSTALLATION_ID = '456';
  process.env.GITHUB_APP_PRIVATE_KEY = key;
}
function transport(reply: (auth: string, method: string, url: string) => Response): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/access_tokens')) {
      return Response.json({
        token: 'fixture-app',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    calls.push({
      auth,
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      url: String(url),
    });
    return reply(auth, init?.method ?? 'GET', String(url));
  }) as typeof fetch;
}

test('reconciliation reads use the configured App with no PAT present', async () => {
  app();
  transport(() => Response.json([{ filename: 'src/example.ts' }]));
  const deps = createDefaultReconcileDeps();
  expect(await deps.listPullRequestFiles?.(pr)).toEqual(['src/example.ts']);
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
  await flushGitHubApiMeter();
  const usage = await getDatabase().query<{ service: string; pool_id: string }>(
    'SELECT service, pool_id FROM github_api_usage'
  );
  expect(usage.rows.some(row => row.service === 'overseer' && row.pool_id === 'app-123-456')).toBe(
    true
  );
});

for (const operation of ['comment', 'label', 'close'] as const)
  test(`tracker ${operation} retries exactly once on explicit App permission denial`, async () => {
    app();
    process.env.GITHUB_TOKEN = 'fixture-pat';
    transport((auth, method) =>
      method !== 'GET' && auth.includes('fixture-app')
        ? Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
        : Response.json([])
    );
    const deps = createDefaultReconcileDeps();
    if (operation === 'comment')
      await deps.addTrackerEvidenceComment({ issue, body: 'fixture evidence' });
    else if (operation === 'close') await deps.closeTrackerIssue({ issue });
    else await deps.addTrackerLabel({ issue, label: 'wo:done' });
    expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app', 'Bearer fixture-pat']);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[0]?.body).toContain(
      operation === 'comment' ? 'fixture evidence' : operation === 'close' ? 'closed' : 'wo:done'
    );
    await deps.listPullRequestFiles?.(pr);
    expect(calls[2]?.auth).toBe('Bearer fixture-app');
  });

for (const status of [401, 403, 429])
  test(`tracker write HTTP ${status} without permission denial does not fall back to the PAT`, async () => {
    app();
    process.env.GITHUB_TOKEN = 'fixture-pat';
    transport(() => Response.json({ message: 'fixture refusal' }, { status }));
    await expect(
      createDefaultReconcileDeps().addTrackerLabel({ issue, label: 'wo:done' })
    ).rejects.toThrow();
    // A 401 for an App identity re-mints and retries exactly once through the
    // shared provider (WO-HARNESS-GITHUB-TOKEN-PROVIDER-REFRESH-01) -- still the
    // App identity, never the PAT. 403/429 are returned as-is with no retry. In
    // no case does the write fall back to fixture-pat.
    const expectedAppCalls = status === 401 ? 2 : 1;
    expect(calls.map(call => call.auth)).toEqual(
      Array(expectedAppCalls).fill('Bearer fixture-app')
    );
  });

test('ambiguous write transport failure does not retry with PAT', async () => {
  app();
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() => {
    throw new Error('fixture lost response');
  });
  await expect(createDefaultReconcileDeps().closeTrackerIssue({ issue })).rejects.toThrow(
    'fixture lost response'
  );
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
});

test('read permission denial does not fall back to the PAT', async () => {
  app();
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() =>
    Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
  );
  await expect(createDefaultReconcileDeps().listPullRequestFiles?.(pr)).rejects.toThrow();
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
});

test('App exhaustion blocks subsequent HTTP and never falls back', async () => {
  app();
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() =>
    Response.json(
      { message: 'API rate limit exceeded' },
      {
        status: 403,
        headers: {
          'x-ratelimit-resource': 'core',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
        },
      }
    )
  );
  const deps = createDefaultReconcileDeps();
  await expect(deps.addTrackerLabel({ issue, label: 'wo:done' })).rejects.toThrow();
  await expect(
    createDefaultReconcileDeps().addTrackerLabel({ issue, label: 'wo:done' })
  ).rejects.toThrow('github_pool_backoff');
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
});

test('an exhausted fallback PAT is held before its HTTP request', async () => {
  app();
  process.env.GITHUB_TOKEN = 'fixture-pat';
  recordGitHubApiCall({
    service: 'overseer',
    poolId: 'user-pat',
    resource: 'core',
    status: 403,
    rateLimited: true,
    reset: Math.floor(Date.now() / 1000) + 60,
  });
  transport(() =>
    Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
  );
  await expect(
    createDefaultReconcileDeps().addTrackerLabel({ issue, label: 'wo:done' })
  ).rejects.toThrow('github_pool_backoff');
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
});

test('PAT-only installations retain their read route', async () => {
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() => Response.json([]));
  expect(await createDefaultReconcileDeps().listPullRequestFiles?.(pr)).toEqual([]);
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-pat']);
});

test('partial App configuration fails instead of silently using PAT', async () => {
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() => Response.json([]));
  await expect(
    (async () => createDefaultReconcileDeps().listPullRequestFiles?.(pr))()
  ).rejects.toThrow('github_app_auth_incomplete');
  expect(calls).toHaveLength(0);
});

test('absent credentials retain the skip path without network traffic', async () => {
  transport(() => Response.json([]));
  expect(
    await createDefaultReconcileDeps().searchMergedPullRequests({
      org: 'fixture',
      since: '2026-10-17',
    })
  ).toEqual([]);
  expect(calls).toHaveLength(0);
});

test('persisted pool backoff is reported as a rate-limit skip', async () => {
  const warnings: string[] = [];
  const result = await runReconcileOnce({
    deps: {
      ...createDefaultReconcileDeps(),
      readCursor: async () => null,
      searchMergedPullRequests: async () => {
        throw new Error('github_pool_backoff:fixture/core:123');
      },
      log: {
        warn: (_fields, message) => {
          warnings.push(message);
        },
      },
    },
  });
  expect(result.skipped).toBe(true);
  expect(warnings).toEqual(['overseer.reconcile.rate_limit_skip']);
});

const trackerStem = 'WO-HARNESS-REST-TRACKER-01';
function trackerRow(number: number, title = trackerStem, state = 'open') {
  return {
    number,
    title,
    state,
    body: null,
    repository_url: 'https://api.github.com/repos/thinmansoftware/bdc-xo',
    html_url: `https://github.com/thinmansoftware/bdc-xo/issues/${number}`,
  };
}

function trackerTransport(rows: () => ReturnType<typeof trackerRow>[]): void {
  transport((_auth, _method, url) => {
    const path = new URL(url).pathname;
    if (path === '/search/issues') {
      const items = rows();
      return Response.json({ total_count: items.length, incomplete_results: false, items });
    }
    if (path === '/repos/thinmansoftware/bdc-xo/issues') return Response.json(rows());
    throw new Error(`unexpected fixture request: ${path}`);
  });
}

function mergedTrackerPr(number: number): ReconcileMergedPullRequest {
  return {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    number,
    title: 'Fixture implementation',
    body: `WO: ${trackerStem}`,
    htmlUrl: `https://github.com/thinmansoftware/bdc-harness/pull/${number}`,
    state: 'closed',
    merged: true,
    mergeCommitSha: 'a'.repeat(40),
  };
}

function trackerRunDeps(
  deps: ReconcileDeps,
  prs: ReconcileMergedPullRequest[],
  effects: string[]
): ReconcileDeps {
  return {
    ...deps,
    readCursor: async () => null,
    searchMergedPullRequests: async () => prs,
    listPullRequestFiles: async () => ['src/fixture.ts'],
    listOpenPullRequestsReferencingTracker: async () => [],
    hasCloseBeenRecorded: async () => false,
    hasHoldBeenNoted: async () => false,
    addTrackerEvidenceComment: async () => {
      effects.push('comment');
    },
    addTrackerLabel: async () => {
      effects.push('label');
    },
    closeTrackerIssue: async () => {
      effects.push('close');
    },
    insertAction: async () => undefined,
    log: { warn: () => undefined, info: () => undefined },
  };
}

test('tracker REST lookup uses healthy core while Search is exhausted', async () => {
  app();
  recordGitHubApiCall({
    service: 'overseer',
    poolId: 'app-123-456',
    resource: 'search',
    status: 403,
    rateLimited: true,
    remaining: 0,
    reset: Math.floor(Date.now() / 1000) + 60,
  });
  trackerTransport(() => [trackerRow(501)]);
  await expect(createDefaultReconcileDeps().findTrackerIssueByStem(trackerStem)).resolves.toEqual({
    owner: 'thinmansoftware',
    repo: 'bdc-xo',
    number: 501,
    title: trackerStem,
    state: 'open',
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/repos/thinmansoftware/bdc-xo/issues');
  expect(calls[0]!.auth).toBe('Bearer fixture-app');
  await flushGitHubApiMeter();
  const usage = await getDatabase().query<{ resource: string; calls: number }>(
    'SELECT resource, calls FROM github_api_usage WHERE service = $1 AND pool_id = $2',
    ['overseer', 'app-123-456']
  );
  expect(usage.rows.find(row => row.resource === 'core')?.calls).toBe(1);
});

test('tracker REST lookup shares one complete scan for concurrent scoped stems', async () => {
  app();
  const otherStem = 'WO-HARNESS-OTHER-TRACKER-01';
  trackerTransport(() => [trackerRow(501), trackerRow(502, otherStem)]);
  const deps = createDefaultReconcileDeps();
  const scope = {};
  const results = await Promise.all([
    deps.findTrackerIssueByStem(trackerStem, scope),
    deps.findTrackerIssueByStem(otherStem, scope),
  ]);
  expect(results.map(result => result?.number)).toEqual([501, 502]);
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe('/repos/thinmansoftware/bdc-xo/issues');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    state: 'all',
    sort: 'created',
    direction: 'asc',
    per_page: '100',
    page: '1',
  });
});

test('tracker REST lookup direct no-scope reads are fresh', async () => {
  app();
  let reads = 0;
  trackerTransport(() => [trackerRow(501, trackerStem, reads++ === 0 ? 'open' : 'closed')]);
  const deps = createDefaultReconcileDeps();
  expect((await deps.findTrackerIssueByStem(trackerStem))?.state).toBe('open');
  expect((await deps.findTrackerIssueByStem(trackerStem))?.state).toBe('closed');
  expect(calls.map(call => new URL(call.url).pathname)).toEqual([
    '/repos/thinmansoftware/bdc-xo/issues',
    '/repos/thinmansoftware/bdc-xo/issues',
  ]);
});

test('tracker REST lookup reused dependency factory refreshes between invocations', async () => {
  app();
  let currentState = 'open';
  trackerTransport(() => [trackerRow(501, trackerStem, currentState)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  expect((await runReconcileOnce({ deps })).closed).toBe(1);
  currentState = 'closed';
  expect((await runReconcileOnce({ deps })).closed).toBe(0);
  expect(effects).toEqual(['comment', 'label', 'close']);
  expect(calls).toHaveLength(2);
  expect(calls.every(call => !call.url.includes('/search/'))).toBe(true);
});

test('tracker REST lookup closes one tracker only once across merged PRs in an invocation', async () => {
  app();
  trackerTransport(() => [trackerRow(501)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(
    createDefaultReconcileDeps(),
    [mergedTrackerPr(601), mergedTrackerPr(602)],
    effects
  );
  expect(await runReconcileOnce({ deps })).toEqual({ scanned: 2, closed: 1, skipped: false });
  expect(effects).toEqual(['comment', 'label', 'close']);
  expect(calls).toHaveLength(1);
});

test('tracker REST lookup spec-only evidence does not consume later implementation evidence', async () => {
  app();
  trackerTransport(() => [trackerRow(501)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(
    createDefaultReconcileDeps(),
    [mergedTrackerPr(601), mergedTrackerPr(602)],
    effects
  );
  deps.listPullRequestFiles = async pr =>
    pr.number === 601 ? [`docs/work-orders/${trackerStem}.md`] : ['src/fixture.ts'];
  expect((await runReconcileOnce({ deps })).closed).toBe(1);
  expect(effects.filter(effect => effect === 'close')).toHaveLength(1);
});

test('tracker REST lookup completes pagination before selecting a later exact issue', async () => {
  app();
  transport((_auth, _method, rawUrl) => {
    const url = new URL(rawUrl);
    const page = Number(url.searchParams.get('page'));
    expect(url.pathname).toBe('/repos/thinmansoftware/bdc-xo/issues');
    return Response.json(
      page === 1
        ? Array.from({ length: 100 }, (_, i) => trackerRow(i + 1, `Unrelated ${i}`))
        : [trackerRow(501), trackerRow(502, `${trackerStem}-NEAR`)]
    );
  });
  expect((await createDefaultReconcileDeps().findTrackerIssueByStem(trackerStem))?.number).toBe(
    501
  );
  expect(calls.map(call => new URL(call.url).searchParams.get('page'))).toEqual(['1', '2']);
});

test('tracker REST lookup never acts on an early match before a malformed later page', async () => {
  app();
  transport((_auth, _method, url) =>
    Response.json(
      new URL(url).searchParams.get('page') === '1'
        ? [
            trackerRow(501),
            ...Array.from({ length: 99 }, (_, i) => trackerRow(i + 1, `Unrelated ${i}`)),
          ]
        : [{ ...trackerRow(502), state: 'pending' }]
    )
  );
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  await expect(runReconcileOnce({ deps })).rejects.toThrow('tracker issue REST listing');
  expect(calls).toHaveLength(2);
  expect(effects).toEqual([]);
});

test('tracker REST lookup holds a full final page as unknown within the 100-read budget', async () => {
  app();
  transport((_auth, _method, url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json(
      Array.from({ length: 100 }, (_, i) => trackerRow(page * 100 + i, 'Unrelated'))
    );
  });
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  await expect(runReconcileOnce({ deps })).rejects.toThrow('complete-page budget');
  expect(calls).toHaveLength(100);
  expect(effects).toEqual([]);
});

test('tracker REST lookup shares failure within a scope and retries only with a fresh scope', async () => {
  app();
  transport(() => Response.json({ message: 'fixture unavailable' }, { status: 503 }));
  const deps = createDefaultReconcileDeps();
  const scope = {};
  const results = await Promise.allSettled([
    deps.findTrackerIssueByStem(trackerStem, scope),
    deps.findTrackerIssueByStem('WO-HARNESS-OTHER-TRACKER-01', scope),
  ]);
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  await expect(deps.findTrackerIssueByStem(trackerStem, scope)).rejects.toThrow(
    'fixture unavailable'
  );
  expect(calls).toHaveLength(1);
  await expect(deps.findTrackerIssueByStem(trackerStem, {})).rejects.toThrow('fixture unavailable');
  expect(calls).toHaveLength(2);
});

for (const [name, override] of [
  ['zero number', { number: 0 }],
  ['string number', { number: '501' }],
  ['fractional number', { number: 1.5 }],
  ['missing title', { title: null }],
  ['malformed body', { body: 7 }],
  ['invalid state', { state: 'pending' }],
  [
    'foreign repository',
    { repository_url: 'https://api.github.com/repos/thinmansoftware/shopops' },
  ],
  ['disagreeing web URL', { html_url: 'https://github.com/thinmansoftware/bdc-xo/issues/502' }],
  ['malformed PR marker', { pull_request: null }],
] as const) {
  test(`tracker REST lookup rejects ${name} before any tracker effect`, async () => {
    app();
    transport(() => Response.json([{ ...trackerRow(501), ...override }]));
    const effects: string[] = [];
    const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
    await expect(runReconcileOnce({ deps })).rejects.toThrow('tracker issue REST listing');
    expect(effects).toEqual([]);
    expect(calls).toHaveLength(1);
  });
}

for (const [name, data] of [
  ['null page', null],
  ['object page', { items: [] }],
  ['oversized page', Array.from({ length: 101 }, (_, i) => trackerRow(i + 1, 'Unrelated'))],
] as const) {
  test(`tracker REST lookup rejects ${name}`, async () => {
    app();
    transport(() => Response.json(data));
    await expect(createDefaultReconcileDeps().findTrackerIssueByStem(trackerStem)).rejects.toThrow(
      'malformed page'
    );
  });
}

test('tracker REST lookup excludes PR rows and preserves closed issue state', async () => {
  app();
  transport(() =>
    Response.json([
      trackerRow(501, trackerStem, 'closed'),
      trackerRow(501, trackerStem, 'closed'),
      {
        ...trackerRow(502),
        html_url: 'https://github.com/thinmansoftware/bdc-xo/pull/502',
        pull_request: { url: 'https://api.github.com/repos/thinmansoftware/bdc-xo/pulls/502' },
      },
      trackerRow(503, `${trackerStem}-NEAR`),
    ])
  );
  const deps = createDefaultReconcileDeps();
  expect((await deps.findTrackerIssueByStem(trackerStem))?.state).toBe('closed');
  const effects: string[] = [];
  expect(
    (
      await runReconcileOnce({
        deps: trackerRunDeps(deps, [mergedTrackerPr(601)], effects),
      })
    ).closed
  ).toBe(0);
  expect(effects).toEqual([]);
});

test('tracker REST lookup rejects ambiguous exact titles rather than selecting REST order', async () => {
  app();
  trackerTransport(() => [trackerRow(501), trackerRow(502)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  await expect(runReconcileOnce({ deps })).rejects.toThrow('title is ambiguous');
  expect(effects).toEqual([]);
});

test('tracker REST lookup rejects conflicting copies of one issue identity', async () => {
  app();
  trackerTransport(() => [trackerRow(501), trackerRow(501, trackerStem, 'closed')]);
  await expect(createDefaultReconcileDeps().findTrackerIssueByStem(trackerStem)).rejects.toThrow(
    'conflicting copies'
  );
});

test('tracker REST lookup complete empty and near-title snapshots do not close a tracker', async () => {
  app();
  let rows: ReturnType<typeof trackerRow>[] = [];
  trackerTransport(() => rows);
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  expect((await runReconcileOnce({ deps })).closed).toBe(0);
  rows = [trackerRow(501, `${trackerStem}-NEAR`)];
  expect((await runReconcileOnce({ deps })).closed).toBe(0);
  expect(effects).toEqual([]);
});

test('tracker REST lookup open-holder guard does not consume a later eligible close', async () => {
  app();
  trackerTransport(() => [trackerRow(501)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(
    createDefaultReconcileDeps(),
    [mergedTrackerPr(601), mergedTrackerPr(602)],
    effects
  );
  let holderReads = 0;
  deps.listOpenPullRequestsReferencingTracker = async () =>
    holderReads++ === 0
      ? [
          {
            owner: 'thinmansoftware',
            repo: 'shopops',
            number: 999,
            title: trackerStem,
            body: `WO: ${trackerStem}`,
            htmlUrl: 'https://github.com/thinmansoftware/shopops/pull/999',
          },
        ]
      : [];
  expect((await runReconcileOnce({ deps })).closed).toBe(1);
  expect(effects).toEqual(['comment', 'comment', 'label', 'close']);
  expect(calls).toHaveLength(1);
});

test('tracker REST lookup failed close is not remembered as a successful close on a later run', async () => {
  app();
  trackerTransport(() => [trackerRow(501)]);
  const effects: string[] = [];
  const deps = trackerRunDeps(createDefaultReconcileDeps(), [mergedTrackerPr(601)], effects);
  let failClose = true;
  deps.closeTrackerIssue = async () => {
    if (failClose) throw new Error('fixture close failed');
    effects.push('close');
  };
  await expect(runReconcileOnce({ deps })).rejects.toThrow('fixture close failed');
  failClose = false;
  expect((await runReconcileOnce({ deps })).closed).toBe(1);
  expect(effects.filter(effect => effect === 'close')).toHaveLength(1);
  expect(calls).toHaveLength(2);
});

test('tracker REST lookup App read permission denial does not switch to PAT', async () => {
  app();
  process.env.GITHUB_TOKEN = 'fixture-pat';
  transport(() =>
    Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
  );
  await expect(createDefaultReconcileDeps().findTrackerIssueByStem(trackerStem)).rejects.toThrow();
  expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
});
