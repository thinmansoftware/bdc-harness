import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRealApprovePullRequest,
  createRealOctokitClient,
  resolveGitHubAppAuth,
  resolveGitHubToken,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';

const APP_ENV_VARS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

const FAKE_PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakekeymaterialfortests\n-----END RSA PRIVATE KEY-----\n';

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of APP_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of APP_ENV_VARS) {
    const value = savedEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('resolveGitHubAppAuth', () => {
  test('app vars complete -> App auth config resolved (App path chosen)', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;

    const config = resolveGitHubAppAuth();
    expect(config).not.toBeNull();
    expect(config?.appId).toBe(4574893);
    expect(config?.installationId).toBe(153295654);
    expect(config?.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  test('app vars absent -> resolver returns null and PAT path is used unchanged', () => {
    process.env.GH_TOKEN = 'pat-token-for-test';

    expect(resolveGitHubAppAuth()).toBeNull();
    expect(resolveGitHubToken()).toBe('pat-token-for-test');
    // Construction takes the PAT branch without throwing (no network at construction).
    const client = createRealOctokitClient();
    expect(typeof client.pulls.get).toBe('function');
  });

  test('app vars partial -> throws naming the variable, does NOT fall back to PAT', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GH_TOKEN = 'pat-token-that-must-not-be-used';

    expect(() => resolveGitHubAppAuth()).toThrow(/GITHUB_APP_INSTALLATION_ID/);
    // The construction seam must fail loudly too -- never silently downgrade
    // to John's PAT identity when App vars are present-but-broken.
    expect(() => createRealOctokitClient()).toThrow(/overseer_real_adapter_app_auth_incomplete/);

    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    expect(() => resolveGitHubAppAuth()).toThrow(
      /GITHUB_APP_PRIVATE_KEY.*GITHUB_APP_PRIVATE_KEY_PATH/
    );
  });

  test('inline key with literal backslash-n escapes is normalized; garbage key throws', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIEfake\\n-----END RSA PRIVATE KEY-----\\n';

    const config = resolveGitHubAppAuth();
    expect(config?.privateKey).toContain('\n');
    expect(config?.privateKey).not.toContain('\\n');
    expect(config?.privateKey.split('\n')[0]).toBe('-----BEGIN RSA PRIVATE KEY-----');

    process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-pem-at-all';
    expect(() => resolveGitHubAppAuth()).toThrow(/overseer_real_adapter_app_auth_malformed.*BEGIN/);
  });

  test('private key path is read from disk; unreadable path throws, no PAT fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overseer-app-auth-'));
    try {
      const pemPath = join(dir, 'app.pem');
      writeFileSync(pemPath, FAKE_PEM, 'utf8');
      process.env.GITHUB_APP_ID = '4574893';
      process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;
      process.env.GH_TOKEN = 'pat-token-that-must-not-be-used';

      const config = resolveGitHubAppAuth();
      expect(config?.privateKey).toBe(FAKE_PEM);

      process.env.GITHUB_APP_PRIVATE_KEY_PATH = join(dir, 'missing.pem');
      expect(() => resolveGitHubAppAuth()).toThrow(
        /overseer_real_adapter_app_auth_malformed.*GITHUB_APP_PRIVATE_KEY_PATH/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed numeric ids throw naming the variable', () => {
    process.env.GITHUB_APP_ID = 'not-a-number';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;
    expect(() => resolveGitHubAppAuth()).toThrow(/GITHUB_APP_ID/);

    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '-5';
    expect(() => resolveGitHubAppAuth()).toThrow(/GITHUB_APP_INSTALLATION_ID/);
  });
});

function createOctokitMock(
  createReview: RealGitHubOctokitLike['pulls']['createReview']
): RealGitHubOctokitLike {
  return {
    pulls: {
      list: async () => ({ data: [] }),
      get: async () => ({
        data: {
          number: 42,
          title: 'WO-42 approval test',
          state: 'open',
          mergeable: true,
          html_url: 'https://github.test/pull/42',
          head: { sha: 'a'.repeat(40) },
        },
      }),
      merge: async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }),
      createReview,
    },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: [] } }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
  };
}

describe('createRealApprovePullRequest', () => {
  const ref = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 };

  test('success path calls pulls.createReview with event APPROVE', async () => {
    const createReview = mock(async () => ({
      data: { id: 7, state: 'APPROVED', html_url: 'https://github.test/pull/42#review-7' },
    }));
    const approve = createRealApprovePullRequest(createOctokitMock(createReview));

    const result = await approve(ref);
    expect(createReview).toHaveBeenCalledWith({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(result.approved).toBe(true);
    expect(result.message).toBe('APPROVED');
  });

  test('self-approval 422 surfaces a usable named error, not a raw API error', async () => {
    const createReview = mock(async () =>
      Promise.reject(
        Object.assign(new Error('Can not approve your own pull request'), { status: 422 })
      )
    );
    const approve = createRealApprovePullRequest(createOctokitMock(createReview));

    await expect(approve(ref)).rejects.toThrow(
      /overseer_real_adapter_self_approval_rejected.*Can not approve your own pull request/
    );
  });

  test('missing createReview API on the client throws loudly', async () => {
    const approve = createRealApprovePullRequest(createOctokitMock(undefined));
    await expect(approve(ref)).rejects.toThrow(/overseer_real_adapter_missing_create_review_api/);
  });
});
