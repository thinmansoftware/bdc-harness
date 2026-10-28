import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { clearServiceGitHubTokenCache } from '@archon/core/github/service-identity';
import { githubToken } from '../dispatch/duty-officer-clock';

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_TASKMASTER_ID',
  'GITHUB_APP_TASKMASTER_INSTALLATION_ID',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY_PATH',
  'GITHUB_APP_DUTY_OFFICER_ID',
  'GITHUB_APP_DUTY_OFFICER_INSTALLATION_ID',
  'GITHUB_APP_DUTY_OFFICER_PRIVATE_KEY',
  'GITHUB_APP_DUTY_OFFICER_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

afterEach(() => {
  clearServiceGitHubTokenCache();
  for (const key of ENV_KEYS) delete process.env[key];
});

test('Test 2: no sync accessor returns null for an App', async () => {
  clearServiceGitHubTokenCache();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_INSTALLATION_ID = '456';
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/access_tokens')) {
      return Response.json({
        token: 'ghs_duty_officer_installation',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const pending = githubToken();
    expect(pending).toBeInstanceOf(Promise);
    expect(pending).not.toBeNull();
    expect(await pending).toBe('ghs_duty_officer_installation');
  } finally {
    globalThis.fetch = original;
  }
});
