import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serviceGitHubFetch, serviceGitHubFetchWithPermissionFallback } from './request';
import { clearServiceGitHubTokenCache, type GitHubAppIdentity } from './service-identity';
import {
  assertGitHubPoolAvailable,
  recordGitHubApiCall,
  flushGitHubApiMeter,
  resetGitHubApiMeterForTests,
} from './metering';

afterEach(resetGitHubApiMeterForTests);

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

describe('Test 4: 401 re-mints once then alerts', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const appIdentity = (): GitHubAppIdentity => ({
    kind: 'app',
    service: 'overseer',
    appId: '1',
    installationId: '2',
    privateKey: key,
    poolId: 'app-1-2',
    distinct: true,
  });

  afterEach(() => {
    clearServiceGitHubTokenCache();
    resetGitHubApiMeterForTests();
  });

  it('401 then 200: one re-mint, one retry, success', async () => {
    resetGitHubApiMeterForTests();
    clearServiceGitHubTokenCache();
    let mints = 0;
    let apiCalls = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('/access_tokens')) {
        mints += 1;
        return Response.json({
          token: `mint-${mints}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      apiCalls += 1;
      return new Response('{}', { status: apiCalls === 1 ? 401 : 200 });
    }) as typeof fetch;
    const response = await serviceGitHubFetch({
      service: 'overseer',
      url: 'https://api.github.com/user',
      identity: appIdentity(),
      fetch: fetchImpl,
    });
    expect(response.status).toBe(200);
    expect(apiCalls).toBe(2); // one 401 + one retry
    expect(mints).toBe(2); // initial mint + exactly one re-mint
  });

  it('401 then 401: alert sink called once and the error propagates', async () => {
    resetGitHubApiMeterForTests();
    clearServiceGitHubTokenCache();
    const alerts: string[] = [];
    let apiCalls = 0;
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes('/access_tokens')) {
        return Response.json({
          token: 'mint',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      apiCalls += 1;
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    await expect(
      serviceGitHubFetch({
        service: 'overseer',
        url: 'https://api.github.com/user',
        identity: appIdentity(),
        fetch: fetchImpl,
        alertSink: credential => {
          alerts.push(credential);
        },
      })
    ).rejects.toThrow('github_credential_unrefreshable_401');
    expect(apiCalls).toBe(2); // one 401 + one retry, both 401
    expect(alerts).toEqual(['app-1-2']);
  });
});
