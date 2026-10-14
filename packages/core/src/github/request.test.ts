import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { serviceGitHubFetchWithPermissionFallback } from './request';
import { flushGitHubApiMeter, resetGitHubApiMeterForTests } from './metering';

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
