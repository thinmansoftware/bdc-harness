import { afterEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  createRealApprovePullRequest,
  resolveGitHubAppAuth,
  resolveGitHubToken,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';

const authVariables = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;
const originalEnvironment = Object.fromEntries(
  authVariables.map(name => [name, process.env[name]])
);

afterEach(() => {
  for (const name of authVariables) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function clearAuthEnvironment(): void {
  for (const name of authVariables) delete process.env[name];
}

function fixturePrivateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 1024 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

function octokitWithCreateReview(
  createReview: RealGitHubOctokitLike['pulls']['createReview']
): RealGitHubOctokitLike {
  return {
    pulls: {
      list: async () => ({ data: [] }),
      get: async () => ({
        data: {
          number: 42,
          title: 'test',
          state: 'open',
          html_url: 'https://github.test/pull/42',
          head: { sha: 'a'.repeat(40) },
        },
      }),
      merge: async () => ({ data: { merged: true } }),
      createReview,
    },
    search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  };
}

describe('real GitHub App authentication', () => {
  test('complete App vars choose App auth configuration', () => {
    clearAuthEnvironment();
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = fixturePrivateKey();
    process.env.GH_TOKEN = 'pat-must-not-win';

    expect(resolveGitHubAppAuth()).toMatchObject({
      appId: '4574893',
      installationId: '153295654',
    });
  });

  test('absent App vars preserve the PAT path', () => {
    clearAuthEnvironment();
    process.env.GH_TOKEN = 'existing-pat';

    expect(resolveGitHubAppAuth()).toBeNull();
    expect(resolveGitHubToken()).toBe('existing-pat');
  });

  test('partial App vars throw without falling back to PAT', () => {
    clearAuthEnvironment();
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GH_TOKEN = 'must-not-fallback';

    expect(() => resolveGitHubAppAuth()).toThrow('GITHUB_APP_PRIVATE_KEY');
  });

  test('malformed App private key names the broken variable', () => {
    clearAuthEnvironment();
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = 'not a private key';

    expect(() => resolveGitHubAppAuth()).toThrow('malformed_GITHUB_APP_PRIVATE_KEY');
  });

  test('literal newline escapes in an App private key survive env transport', () => {
    clearAuthEnvironment();
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    const key = fixturePrivateKey();
    process.env.GITHUB_APP_PRIVATE_KEY = key.replace(/\n/g, '\\n');

    expect(resolveGitHubAppAuth()?.privateKey).toBe(key);
  });
});

describe('real GitHub pull request approval', () => {
  test('approvePullRequest creates an APPROVE review', async () => {
    const createReview = mock(async () => ({ data: { id: 1, state: 'APPROVED' } }));
    const result = await createRealApprovePullRequest(octokitWithCreateReview(createReview))({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 42,
    });

    expect(createReview).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(result).toEqual({ approved: true });
  });

  test('approvePullRequest surfaces self-approval rejection clearly', async () => {
    const createReview = mock(async () =>
      Promise.reject({ status: 422, message: 'Can not approve your own pull request' })
    );

    await expect(
      createRealApprovePullRequest(octokitWithCreateReview(createReview))({
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        number: 42,
      })
    ).resolves.toEqual({
      approved: false,
      message: 'github_review_self_approval_rejected',
    });
  });
});
