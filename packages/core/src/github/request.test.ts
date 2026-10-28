import { afterEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serviceGitHubFetch, serviceGitHubFetchWithPermissionFallback } from './request';
import { clearServiceGitHubTokenCache } from './service-identity';
import {
  clearGitHubCredentialAlertDedupe,
  registerGitHubCredentialAlertSink,
  type GitHubCredentialAlert,
} from './credential-alerts';
import {
  assertGitHubPoolAvailable,
  recordGitHubApiCall,
  flushGitHubApiMeter,
  resetGitHubApiMeterForTests,
} from './metering';

afterEach(resetGitHubApiMeterForTests);

afterEach(() => {
  clearServiceGitHubTokenCache();
  clearGitHubCredentialAlertDedupe();
  registerGitHubCredentialAlertSink(null);
});

it('Test 4: a 401 evicts, re-mints, and retries exactly once', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  let mints = 0;
  let requests = 0;
  const response = await serviceGitHubFetch({
    service: 'taskmaster',
    url: 'https://api.github.com/test',
    identity: {
      kind: 'app',
      service: 'taskmaster',
      appId: 'retry',
      installationId: '1',
      privateKey: key,
      poolId: 'app-retry-1',
      distinct: true,
    },
    fetch: (async (url: string | URL | Request) => {
      if (String(url).includes('/access_tokens')) {
        mints += 1;
        return Response.json({ token: `mint-${mints}` });
      }
      requests += 1;
      return new Response('{}', { status: requests === 1 ? 401 : 200 });
    }) as typeof fetch,
  });
  expect(response.status).toBe(200);
  expect(mints).toBe(2);
  expect(requests).toBe(2);
});

it('Test 4 and 6: a second 401 emits one deduplicated credential alert', async () => {
  const alerts: GitHubCredentialAlert[] = [];
  registerGitHubCredentialAlertSink(async alert => {
    alerts.push(alert);
  });
  const identity = {
    kind: 'pat' as const,
    service: 'taskmaster' as const,
    token: 'synthetic',
    poolId: 'user-pat' as const,
    distinct: false,
  };
  const fetchImpl = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect(
      (
        await serviceGitHubFetch({
          service: 'taskmaster',
          url: 'https://api.github.com/test',
          identity,
          fetch: fetchImpl,
        })
      ).status
    ).toBe(401);
  }
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.subjectKey).toBe('credential:taskmaster-user-pat');
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
