import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { runQuotaProbe } from './github-quota-probe';

describe('Test 1: quota probe separates identities without secrets', () => {
  it('exposes only sanitized quota fields', async () => {
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = String(
        (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
      );
      if (String(_url).includes('access_tokens'))
        return Response.json({
          token: 'installation-secret',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      const app = auth.includes('installation-secret');
      return new Response('{}', {
        headers: {
          'x-ratelimit-limit': app ? '15000' : '5000',
          'x-ratelimit-remaining': app ? '14900' : '4900',
          'x-ratelimit-resource': 'core',
          'x-ratelimit-reset': '123',
        },
      });
    }) as typeof fetch;
    try {
      const result = await runQuotaProbe({
        GH_TOKEN: 'pat-secret',
        GITHUB_APP_ID: '1',
        GITHUB_APP_INSTALLATION_ID: '2',
        GITHUB_APP_PRIVATE_KEY: pem,
      });
      expect(result.map(row => row.limit)).toEqual([5000, 15000]);
      expect(Object.keys(result[0])).toEqual([
        'identity',
        'limit',
        'remaining',
        'resource',
        'reset',
      ]);
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
