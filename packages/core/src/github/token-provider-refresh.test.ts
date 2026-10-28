import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serviceGitHubFetch } from './request';
import {
  clearServiceGitHubTokenCache,
  getServiceGitHubToken,
  seedServiceGitHubTokenCacheForTests,
  setGitHubCredentialAlertSinkForTests,
  type CredentialRefreshAlert,
  type GitHubAppIdentity,
} from './service-identity';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

function appIdentity(service: GitHubAppIdentity['service'] = 'taskmaster'): GitHubAppIdentity {
  return {
    kind: 'app',
    service,
    appId: '9',
    installationId: '8',
    privateKey,
    poolId: 'app-9-8',
    distinct: true,
  };
}

afterEach(() => {
  clearServiceGitHubTokenCache();
});

test('Test 3: refresh before expiry and single flight', async () => {
  clearServiceGitHubTokenCache();
  const now = 1_700_000_000_000;
  const identity = appIdentity();
  seedServiceGitHubTokenCacheForTests(identity.poolId, 'stale-token', now + 5 * 60_000);
  let mints = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    expect(String(url)).toContain('/app/installations/8/access_tokens');
    mints += 1;
    return Response.json({
      token: 'fresh-token',
      expires_at: new Date(now + 60 * 60_000).toISOString(),
    });
  }) as typeof fetch;

  const [first, second] = await Promise.all([
    getServiceGitHubToken(identity, { fetch: fetchImpl, now: () => now }),
    getServiceGitHubToken(identity, { fetch: fetchImpl, now: () => now }),
  ]);

  expect(mints).toBe(1);
  expect(first).toBe('fresh-token');
  expect(second).toBe('fresh-token');
});

test('Test 4: 401 re-mints once then succeeds', async () => {
  clearServiceGitHubTokenCache();
  const alerts: CredentialRefreshAlert[] = [];
  setGitHubCredentialAlertSinkForTests(async alert => {
    alerts.push(alert);
  });
  let mints = 0;
  const apiAuth: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/access_tokens')) {
      mints += 1;
      return Response.json({
        token: `ghs_${mints}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
    apiAuth.push(new Headers(init?.headers).get('authorization') ?? '');
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    return new Response('ok', { status: apiAuth.length === 1 ? 401 : 200 });
  }) as typeof fetch;

  const response = await serviceGitHubFetch({
    service: 'taskmaster',
    url: 'https://api.github.com/repos/example/example/issues/1/comments',
    identity: appIdentity(),
    fetch: fetchImpl,
    init: { method: 'POST', body: '{"body":"again"}' },
  });

  expect(response.status).toBe(200);
  expect(mints).toBe(2);
  expect(apiAuth).toEqual(['Bearer ghs_1', 'Bearer ghs_2']);
  expect(bodies).toEqual(['{"body":"again"}', '{"body":"again"}']);
  expect(alerts).toHaveLength(0);
});

test('Test 4: second 401 alerts once and does not send a third request', async () => {
  clearServiceGitHubTokenCache();
  const alerts: CredentialRefreshAlert[] = [];
  setGitHubCredentialAlertSinkForTests(async alert => {
    alerts.push(alert);
  });
  let mints = 0;
  let apiCalls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    if (String(url).includes('/access_tokens')) {
      mints += 1;
      return Response.json({
        token: `ghs_${mints}`,
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    }
    apiCalls += 1;
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch;

  await expect(
    serviceGitHubFetch({
      service: 'taskmaster',
      url: 'https://api.github.com/user',
      identity: appIdentity(),
      fetch: fetchImpl,
    })
  ).rejects.toThrow('github_request_unauthorized:taskmaster');

  expect(mints).toBe(2);
  expect(apiCalls).toBe(2);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.subjectKey).toBe('credential:taskmaster');
});

test('PAT 401 alerts once and does not remint', async () => {
  clearServiceGitHubTokenCache();
  const alerts: CredentialRefreshAlert[] = [];
  setGitHubCredentialAlertSinkForTests(async alert => {
    alerts.push(alert);
  });
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch;

  await expect(
    serviceGitHubFetch({
      service: 'overseer',
      url: 'https://api.github.com/user',
      identity: {
        kind: 'pat',
        service: 'overseer',
        token: 'ghp_static',
        poolId: 'user-pat',
        distinct: false,
      },
      fetch: fetchImpl,
    })
  ).rejects.toThrow('github_request_unauthorized:overseer');

  expect(calls).toBe(1);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.subjectKey).toBe('credential:overseer');
});

test('Test 6: alert dedupe queues one operator message for ten mint failures', async () => {
  clearServiceGitHubTokenCache();
  const alerts: CredentialRefreshAlert[] = [];
  setGitHubCredentialAlertSinkForTests(async alert => {
    alerts.push(alert);
  });
  const fetchImpl = (async () => new Response('mint failed', { status: 500 })) as typeof fetch;
  const identity = appIdentity('taskmaster');

  for (let tick = 0; tick < 10; tick += 1) {
    await expect(getServiceGitHubToken(identity, { fetch: fetchImpl })).rejects.toThrow(
      'github_app_token_mint_failed:500'
    );
  }

  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.subjectKey).toBe('credential:taskmaster');
  expect(alerts[0]?.repeatReason).toBe('credential_refresh_failed');
});
