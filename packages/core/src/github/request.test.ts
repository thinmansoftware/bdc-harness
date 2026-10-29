import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serviceGitHubFetch, serviceGitHubFetchWithPermissionFallback } from './request';
import { clearServiceGitHubTokenCache } from './service-identity';
import {
  assertGitHubPoolAvailable,
  recordGitHubApiCall,
  flushGitHubApiMeter,
  resetGitHubApiMeterForTests,
} from './metering';

afterEach(() => {
  resetGitHubApiMeterForTests();
  clearServiceGitHubTokenCache();
});

it('Test 5: production packages contain no direct legacy GitHub token reads', async () => {
  const root = resolve(import.meta.dir, '../../../..');
  const prohibited =
    /process\.env\.(?:GH_TOKEN|GITHUB_TOKEN|MERGE_MANAGER_GH_TOKEN|GH_AUTH_TOKEN_INTERNAL)/;
  const matches: string[] = [];
  for await (const relative of new Bun.Glob('packages/**/*.ts').scan(root)) {
    if (relative.endsWith('.test.ts') || relative.endsWith('service-identity.ts')) continue;
    if (prohibited.test(await readFile(resolve(root, relative), 'utf8'))) matches.push(relative);
  }
  expect(matches).toEqual([]);
});

it('Test 7: credential inventory contains every required credential', async () => {
  const inventory = await readFile(
    resolve(import.meta.dir, '../../../../docs/credentials-inventory.md'),
    'utf8'
  );
  for (const credential of [
    'GITHUB_APP_ID',
    'GITHUB_APP_MERGE_MANAGER_',
    'GITHUB_APP_RUN_NODES_',
    'GITHUB_APP_TASKMASTER_',
    'GH_TOKEN',
    'CURSOR_API_KEY',
    '/home/appuser/.codex/auth.json',
    '/home/appuser/.claude/.credentials.json',
    'XAI_API_KEY',
  ]) {
    expect(inventory).toContain(credential);
  }
});

it('Test 4 and Test 6: retries one 401 and dedupes repeated credential alerts', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const identity = {
    kind: 'app' as const,
    service: 'taskmaster' as const,
    appId: '401',
    installationId: '1',
    privateKey: key,
    poolId: 'app-401-1',
    distinct: true as const,
  };
  let mints = 0;
  let requests = 0;
  let alerts = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).includes('/access_tokens')) {
      mints += 1;
      return Response.json({ token: `mint-${mints}` });
    }
    requests += 1;
    return new Response('{}', { status: 401 });
  }) as typeof fetch;
  const run = () =>
    serviceGitHubFetch({
      service: 'taskmaster',
      identity,
      url: 'https://api.github.com/user',
      fetch: fetchImpl,
      alertSink: () => {
        alerts += 1;
      },
    });
  expect((await run()).status).toBe(401);
  expect((await run()).status).toBe(401);
  expect({ mints, requests, alerts }).toEqual({ mints: 3, requests: 4, alerts: 1 });
});

it('consults the fallback PAT search pool before sending a permission retry', async () => {
  resetGitHubApiMeterForTests();
  recordGitHubApiCall({
    service: 'overseer',
    poolId: 'user-pat',
    resource: 'search',
    status: 403,
    rateLimited: true,
    reset: Math.floor(Date.now() / 1000) + 60,
  });
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  let requests = 0;
  let failure: unknown;
  try {
    await serviceGitHubFetchWithPermissionFallback({
      service: 'duty_officer',
      url: 'https://api.github.com/search/issues',
      identity: {
        kind: 'app',
        service: 'duty_officer',
        appId: '3',
        installationId: '4',
        privateKey: key,
        poolId: 'app-3-4',
        distinct: true,
      },
      fallbackToken: 'synthetic',
      fetch: (async (url: string | URL | Request) => {
        if (String(url).includes('/access_tokens'))
          return Response.json({ token: 'synthetic-app' });
        requests += 1;
        return new Response('Resource not accessible by integration', { status: 403 });
      }) as typeof fetch,
    });
  } catch (error) {
    failure = error;
  }
  expect((failure as Error)?.message).toContain('user-pat/search');
  expect(requests).toBe(1);
  expect(() => assertGitHubPoolAvailable('app-3-4', 'search')).not.toThrow();
});

describe('Test 5: App permission fallback', () => {
  it('retries one call through PAT and records the fallback', async () => {
    resetGitHubApiMeterForTests();
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/access_tokens'))
        return Response.json({
          token: 'app-marker',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      calls.push(auth);
      return auth.includes('app-marker')
        ? new Response('{"message":"Resource not accessible by integration"}', { status: 403 })
        : new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const response = await serviceGitHubFetchWithPermissionFallback({
        service: 'duty_officer',
        url: 'https://example.test',
        fetch: fetchImpl,
        identity: {
          kind: 'app',
          service: 'duty_officer',
          appId: '1',
          installationId: '2',
          privateKey: key,
          poolId: 'app-1-2',
          distinct: true,
        },
        fallbackToken: 'pat-marker',
      });
      expect(response.status).toBe(200);
      expect(calls).toEqual(['Bearer app-marker', 'Bearer pat-marker']);
    } finally {
    }
    void flushGitHubApiMeter;
  });
});
