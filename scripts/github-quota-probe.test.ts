import { describe, expect, test } from 'bun:test';
import { probeGitHubQuotas } from './github-quota-probe';

describe('Test 1: quota probe separates identities', () => {
  test('reports independent PAT and App quotas without emitting credentials', async () => {
    const seenAuthorization: string[] = [];
    const results = await probeGitHubQuotas({
      env: {
        GH_TOKEN: 'ghp_super_secret_pat',
        GITHUB_APP_ID: '4574893',
        GITHUB_APP_INSTALLATION_ID: '153295654',
        GITHUB_APP_PRIVATE_KEY:
          '-----BEGIN PRIVATE KEY-----\\nsecret-pem\\n-----END PRIVATE KEY-----',
      },
      mintAppToken: async () => 'ghs_super_secret_app_token',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        seenAuthorization.push(authorization);
        const app = authorization.includes('ghs_');
        return new Response('{}', {
          headers: {
            'x-ratelimit-limit': app ? '15000' : '5000',
            'x-ratelimit-remaining': app ? '14776' : '499',
            'x-ratelimit-resource': 'core',
            'x-ratelimit-reset': app ? '1800000001' : '1800000000',
          },
        });
      }) as typeof fetch,
    });

    expect(results).toEqual([
      { identity: 'user-pat', limit: 5000, remaining: 499, resource: 'core', reset: 1800000000 },
      {
        identity: 'overseer-app',
        limit: 15000,
        remaining: 14776,
        resource: 'core',
        reset: 1800000001,
      },
    ]);
    expect(seenAuthorization).toEqual([
      'Bearer ghp_super_secret_pat',
      'Bearer ghs_super_secret_app_token',
    ]);
    const output = JSON.stringify(results);
    expect(output).not.toContain('ghp_');
    expect(output).not.toContain('ghs_');
    expect(output).not.toContain('PRIVATE KEY');
    expect(output).not.toContain('secret-pem');
  });

  test('sanitizes credential-bearing transport errors', async () => {
    await expect(
      probeGitHubQuotas({
        env: { GH_TOKEN: 'ghp_never_print_this' },
        fetch: (async () => {
          throw new Error('authorization: Bearer ghp_never_print_this');
        }) as typeof fetch,
      })
    ).rejects.toThrow('Quota probe failed for user-pat');
  });
});
