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
import { createDefaultReconcileDeps, runReconcileOnce } from '../reconcile';

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
let calls: { auth: string; method: string; body: string }[];

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
function transport(reply: (auth: string, method: string) => Response): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/access_tokens')) {
      return Response.json({
        token: 'fixture-app',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    calls.push({ auth, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return reply(auth, init?.method ?? 'GET');
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
  test(`tracker write HTTP ${status} without permission denial does not fall back`, async () => {
    app();
    process.env.GITHUB_TOKEN = 'fixture-pat';
    transport(() => Response.json({ message: 'fixture refusal' }, { status }));
    await expect(
      createDefaultReconcileDeps().addTrackerLabel({ issue, label: 'wo:done' })
    ).rejects.toThrow();
    expect(calls.map(call => call.auth)).toEqual(['Bearer fixture-app']);
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
