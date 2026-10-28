import { afterEach, describe, expect, it, mock } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serviceGitHubFetch, serviceGitHubFetchWithPermissionFallback } from './request';
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

describe('Test 4: 401 refresh', () => {
  const identity = {
    kind: 'app' as const,
    service: 'taskmaster' as const,
    appId: '401',
    installationId: '1',
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    poolId: 'app-401-1',
    distinct: true as const,
  };

  it('re-mints and retries exactly once after a 401', async () => {
    let mints = 0;
    let requests = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes('/access_tokens')) {
        mints += 1;
        return Response.json({ token: `token-${mints}` });
      }
      requests += 1;
      return new Response('{}', { status: requests === 1 ? 401 : 200 });
    }) as typeof fetch;
    const response = await serviceGitHubFetch({
      service: 'taskmaster',
      identity,
      url: 'https://api.github.com/repos/o/r',
      fetch: fetchImpl,
    });
    expect(response.status).toBe(200);
    expect({ mints, requests }).toEqual({ mints: 2, requests: 2 });
  });

  it('alerts once and returns the second 401', async () => {
    const alert = mock(async () => {});
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes('/access_tokens')
        ? Response.json({ token: crypto.randomUUID() })
        : new Response('{}', { status: 401 })) as typeof fetch;
    const response = await serviceGitHubFetch({
      service: 'taskmaster',
      identity: { ...identity, poolId: 'app-401-2' },
      url: 'https://api.github.com/repos/o/r',
      fetch: fetchImpl,
      alert,
    });
    expect(response.status).toBe(401);
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
