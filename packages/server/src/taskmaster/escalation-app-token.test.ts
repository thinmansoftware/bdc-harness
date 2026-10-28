import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { clearServiceGitHubTokenCache } from '@archon/core/github/service-identity';
import { createRealEscalationDeliveryDeps } from './escalation-delivery';

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_APP_TASKMASTER_ID',
  'GITHUB_APP_TASKMASTER_INSTALLATION_ID',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY',
  'GITHUB_APP_TASKMASTER_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'MERGE_MANAGER_GH_TOKEN',
  'GH_AUTH_TOKEN_INTERNAL',
] as const;

afterEach(() => {
  clearServiceGitHubTokenCache();
  for (const key of ENV_KEYS) delete process.env[key];
});

test('Test 1: taskmaster escalation uses App identity', async () => {
  clearServiceGitHubTokenCache();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_INSTALLATION_ID = '456';
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ url, authorization });
    if (url.includes('/access_tokens')) {
      return Response.json({
        token: 'ghs_minted_installation',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    return new Response('', { status: 201 });
  }) as typeof fetch;

  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const deps = createRealEscalationDeliveryDeps();
    await deps.postIssueComment(
      { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
      'escalation body'
    );
  } catch (error) {
    expect((error as Error).message).not.toBe('taskmaster_github_token_missing');
    throw error;
  } finally {
    globalThis.fetch = original;
  }

  const comment = calls.find(call => call.url.includes('/issues/1/comments'));
  expect(comment?.authorization).toBe('Bearer ghs_minted_installation');
  expect(calls.some(call => call.url.includes('/access_tokens'))).toBe(true);
});
