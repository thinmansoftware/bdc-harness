import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  runGitHubAppVerification,
  DEFAULT_VERIFY_OWNER,
  DEFAULT_VERIFY_REPO,
  DEFAULT_VERIFY_REF,
} from '../scripts/verify-github-app-token.ts';
import type { GitHubAppAuthConfig } from '../adapters/github-real-deps.ts';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps.ts';

// WO-HARNESS-MM-THINMAN-APP-WIRE-01: network-free tests for the operator verify
// command. These pin the four distinct outcomes (verified / not-configured /
// auth-failed / api-failed) plus the redaction contract (no PEM / no raw token
// in any log call). All Octokit + auth calls are injected, so nothing touches
// the network.

// A real, parseable RSA private key so the "configured" fixture mirrors a valid
// resolveGitHubAppAuth() return (which parses the PEM). Never logged by design;
// we assert on that below.
const FAKE_PEM = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const CONFIGURED_AUTH: GitHubAppAuthConfig = {
  appId: '4574893',
  installationId: '153295654',
  privateKey: FAKE_PEM,
};

const FAKE_TOKEN = 'ghs_FAKEINSTALLATIONTOKEN_should_never_be_logged';

// A capturing logger: records every arg passed to info/warn/error so tests can
// assert both the outcome AND that no secret material leaked into a log call.
function makeCapturingLogger(): {
  logger: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
  serialized: () => string;
} {
  const calls: unknown[][] = [];
  const record =
    () =>
    (...args: unknown[]): void => {
      calls.push(args);
    };
  return {
    logger: { info: record(), warn: record(), error: record() },
    serialized: () => JSON.stringify(calls),
  };
}

function okChecksClient(checkRunCount: number): RealGitHubOctokitLike {
  return {
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: Array.from({ length: checkRunCount }, () => ({
            status: 'completed',
            conclusion: 'success',
          })),
        },
      }),
    },
  } as unknown as RealGitHubOctokitLike;
}

function throwingChecksClient(message: string): RealGitHubOctokitLike {
  return {
    checks: {
      listForRef: async () => {
        // Simulate an Octokit HttpError-style rejection. The token string is
        // included to prove the script does NOT echo it into logs.
        throw new Error(`${message} (token=${FAKE_TOKEN})`);
      },
    },
  } as unknown as RealGitHubOctokitLike;
}

describe('runGitHubAppVerification', () => {
  test('App vars complete + Checks API 200 -> verified success', async () => {
    const { logger } = makeCapturingLogger();
    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => okChecksClient(3),
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.appConfigured).toBe(true);
    expect(result.outcome).toBe('verified');
    expect(result.checksTotal).toBe(3);
  });

  test('defaults target the known thinmansoftware/bdc-harness@dev repo/ref', async () => {
    let capturedOwner: string | undefined;
    let capturedRepo: string | undefined;
    let capturedRef: string | undefined;
    const client = {
      checks: {
        listForRef: async (input: Record<string, unknown>) => {
          capturedOwner = input.owner as string;
          capturedRepo = input.repo as string;
          capturedRef = input.ref as string;
          return { data: { check_runs: [] } };
        },
      },
    } as unknown as RealGitHubOctokitLike;

    const { logger } = makeCapturingLogger();
    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => client,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(capturedOwner).toBe(DEFAULT_VERIFY_OWNER);
    expect(capturedRepo).toBe(DEFAULT_VERIFY_REPO);
    expect(capturedRef).toBe(DEFAULT_VERIFY_REF);
  });

  test('App vars complete but Checks API throws -> api-failed, loud, not ok', async () => {
    const { logger } = makeCapturingLogger();
    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => throwingChecksClient('HTTP 401 Bad credentials'),
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.appConfigured).toBe(true);
    expect(result.outcome).toBe('api-failed');
    expect(result.reason).toContain('HTTP 401');
  });

  test('App vars entirely absent -> not-configured, distinct from an auth failure', async () => {
    const { logger } = makeCapturingLogger();
    const result = await runGitHubAppVerification({
      resolveAppAuth: () => null,
      createClient: () => {
        throw new Error('client should not be constructed when App auth is absent');
      },
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.appConfigured).toBe(false);
    expect(result.outcome).toBe('not-configured');
    expect(result.outcome).not.toBe('auth-failed');
    expect(result.reason).toContain('not configured');
  });

  test('App vars partial (resolver throws) -> auth-failed, loud, not swallowed', async () => {
    const { logger } = makeCapturingLogger();
    const result = await runGitHubAppVerification({
      resolveAppAuth: () => {
        throw new Error(
          'overseer_github_app_auth_incomplete: GITHUB_APP_INSTALLATION_ID is missing but other GITHUB_APP_* vars are set'
        );
      },
      createClient: () => {
        throw new Error('client should not be constructed when auth resolution fails');
      },
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('auth-failed');
    expect(result.reason).toContain('overseer_github_app_auth_incomplete');
  });

  test('no log call ever contains PEM material or a raw installation token', async () => {
    // Exercise both the success and the API-failure branch, capturing all logs.
    const success = makeCapturingLogger();
    await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => okChecksClient(1),
      logger: success.logger,
    });

    const failure = makeCapturingLogger();
    await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => throwingChecksClient('HTTP 500 Server Error'),
      logger: failure.logger,
    });

    for (const serialized of [success.serialized(), failure.serialized()]) {
      expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY');
      expect(serialized).not.toContain('BEGIN PRIVATE KEY');
      expect(serialized).not.toContain(FAKE_TOKEN);
      // The private key body should never appear either.
      expect(serialized).not.toContain(FAKE_PEM.slice(40, 80));
    }
    // The failure path's reason carried a token-shaped substring; it must have
    // been masked, proving redaction actively fired (not merely absent by luck).
    expect(failure.serialized()).toContain('[REDACTED_TOKEN]');
  });
});
