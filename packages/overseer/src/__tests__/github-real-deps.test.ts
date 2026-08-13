import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppAuth } from '@octokit/auth-app';
import {
  createRealApprovePullRequest,
  resolveGitHubAppAuth,
  resolveRealOctokitAuthOptions,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import type { PullRequestRef } from '../types.ts';

// WO-HARNESS-OVERSEER-APP-AUTH-01: Overseer authenticates as the Thinman Overseer
// GitHub App (App ID 4574893, installation 153295654) so it can APPROVE pull
// requests without deadlocking required review. These tests pin the auth
// precedence contract (App-if-complete / PAT-if-absent / throw-if-broken) and the
// approve path, all network-free.

// A syntactically PEM-shaped placeholder. resolveGitHubAppAuth only checks for the
// -----BEGIN marker, not RSA validity, so no real key material is needed here.
const FAKE_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIFAKEKEYCONTENTNOTAREALKEY0000000000000000000000000000000000',
  '-----END RSA PRIVATE KEY-----',
  '',
].join('\n');

const APP_ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of APP_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of APP_ENV_KEYS) {
    const prior = savedEnv.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
});

describe('resolveGitHubAppAuth / auth precedence', () => {
  test('App vars complete -> App auth path chosen', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;

    const config = resolveGitHubAppAuth();
    expect(config).not.toBeNull();
    expect(config).toMatchObject({
      appId: '4574893',
      installationId: '153295654',
    });
    expect(config?.privateKey).toContain('-----BEGIN');

    const options = resolveRealOctokitAuthOptions();
    // App auth path: the App strategy is selected, not a plain token string.
    expect('authStrategy' in options).toBe(true);
    if ('authStrategy' in options) {
      expect(options.authStrategy).toBe(createAppAuth);
      expect(options.auth.appId).toBe('4574893');
      expect(options.auth.installationId).toBe('153295654');
      expect(options.auth.privateKey).toContain('-----BEGIN');
    }
  });

  test('App vars absent -> PAT path chosen (no behavior change)', () => {
    process.env.GH_TOKEN = 'ghp_pat_token_value';

    expect(resolveGitHubAppAuth()).toBeNull();

    const options = resolveRealOctokitAuthOptions();
    expect('authStrategy' in options).toBe(false);
    expect(options).toEqual({ auth: 'ghp_pat_token_value' });
  });

  test('App vars partial (private key missing) -> throws naming the var, does NOT fall back to PAT', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    // No GITHUB_APP_PRIVATE_KEY / _PATH.
    // A PAT is ALSO present: proves we fail loudly instead of silently downgrading.
    process.env.GH_TOKEN = 'ghp_pat_token_value';

    expect(() => resolveGitHubAppAuth()).toThrow(/private_key_missing/);
    // resolveRealOctokitAuthOptions must propagate the throw rather than return the PAT.
    expect(() => resolveRealOctokitAuthOptions()).toThrow(/private_key_missing/);
  });

  test('App ID set but installation ID missing -> throws naming the installation var', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;
    process.env.GH_TOKEN = 'ghp_pat_token_value';

    expect(() => resolveGitHubAppAuth()).toThrow(/GITHUB_APP_INSTALLATION_ID/);
    expect(() => resolveRealOctokitAuthOptions()).toThrow(/GITHUB_APP_INSTALLATION_ID/);
  });

  test('malformed private key (no PEM marker) -> throws, does NOT fall back to PAT', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-pem-at-all';
    process.env.GH_TOKEN = 'ghp_pat_token_value';

    expect(() => resolveGitHubAppAuth()).toThrow(/private_key_malformed/);
    expect(() => resolveRealOctokitAuthOptions()).toThrow(/private_key_malformed/);
  });

  test('private key from GITHUB_APP_PRIVATE_KEY_PATH -> newlines survive (Risk 11)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'overseer-app-pem-'));
    const pemPath = join(dir, 'thinman-overseer.pem');
    try {
      writeFileSync(pemPath, FAKE_PEM, 'utf8');
      process.env.GITHUB_APP_ID = '4574893';
      process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = pemPath;

      const config = resolveGitHubAppAuth();
      expect(config).not.toBeNull();
      // Real newlines must be preserved (a PEM with all newlines stripped is unusable).
      expect(config?.privateKey.split('\n').length).toBeGreaterThanOrEqual(3);
      expect(config?.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(config?.privateKey).toContain('-----END RSA PRIVATE KEY-----');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('unreadable GITHUB_APP_PRIVATE_KEY_PATH -> throws naming the path', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/nonexistent/definitely/not/here.pem';

    expect(() => resolveGitHubAppAuth()).toThrow(/private_key_unreadable/);
  });

  test('single-line "\\n"-packed inline PEM is normalized to real newlines', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    // Env managers commonly pack the PEM onto one line with literal backslash-n.
    process.env.GITHUB_APP_PRIVATE_KEY =
      '-----BEGIN RSA PRIVATE KEY-----\\nMIIFAKE\\n-----END RSA PRIVATE KEY-----\\n';

    const config = resolveGitHubAppAuth();
    expect(config?.privateKey.includes('\\n')).toBe(false);
    expect(config?.privateKey.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});

function approveInput(): PullRequestRef {
  return { owner: 'bluedevilcollectibles', repo: 'lspro-react', number: 42 };
}

function octokitWithReview(
  createReview: NonNullable<RealGitHubOctokitLike['pulls']['createReview']>
): RealGitHubOctokitLike {
  return {
    pulls: {
      list: async () => ({ data: [] }),
      get: async () => ({
        data: {
          number: 42,
          title: 't',
          state: 'open',
          html_url: 'u',
          head: { sha: 'a'.repeat(40) },
        },
      }),
      merge: async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }),
      createReview,
    },
    search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  };
}

describe('createRealApprovePullRequest', () => {
  test('success path -> submits an APPROVE review and returns approved', async () => {
    const createReview = mock(async () => ({ data: { id: 999, state: 'APPROVED' } }));
    const result = await createRealApprovePullRequest(octokitWithReview(createReview))(
      approveInput()
    );

    expect(createReview).toHaveBeenCalledWith({
      owner: 'bluedevilcollectibles',
      repo: 'lspro-react',
      pull_number: 42,
      event: 'APPROVE',
    });
    expect(result).toEqual({ approved: true });
  });

  test('self-approval rejection -> surfaces a usable message, does not throw', async () => {
    // GitHub returns 422 with a body message containing "own pull request" when an
    // identity tries to approve a PR it authored. An App cannot approve its own PR.
    const createReview = mock(async () => {
      throw Object.assign(
        new Error('Unprocessable Entity: Can not approve your own pull request'),
        {
          status: 422,
        }
      );
    });

    const result = await createRealApprovePullRequest(octokitWithReview(createReview))(
      approveInput()
    );

    expect(result.approved).toBe(false);
    expect(result.message).toBe('github_review_self_approval_rejected');
  });

  test('other 422 -> unprocessable message, not self-approval', async () => {
    const createReview = mock(async () => {
      throw Object.assign(new Error('Unprocessable Entity: something else entirely'), {
        status: 422,
      });
    });
    const result = await createRealApprovePullRequest(octokitWithReview(createReview))(
      approveInput()
    );
    expect(result).toEqual({ approved: false, message: 'github_review_unprocessable' });
  });

  test('transport error -> ambiguous message', async () => {
    const createReview = mock(async () => {
      throw new Error('socket closed');
    });
    const result = await createRealApprovePullRequest(octokitWithReview(createReview))(
      approveInput()
    );
    expect(result).toEqual({ approved: false, message: 'github_review_transport_ambiguous' });
  });

  test('missing createReview API -> throws loudly', async () => {
    const octokit: RealGitHubOctokitLike = {
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({
          data: {
            number: 42,
            title: 't',
            state: 'open',
            html_url: 'u',
            head: { sha: 'a'.repeat(40) },
          },
        }),
        merge: async () => ({ data: { merged: true, sha: 'a'.repeat(40) } }),
        // no createReview
      },
      search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    };
    await expect(createRealApprovePullRequest(octokit)(approveInput())).rejects.toThrow(
      /overseer_real_adapter_missing_review_api/
    );
  });
});
