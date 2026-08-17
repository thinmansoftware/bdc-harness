import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import {
  runGitHubAppVerification,
  DEFAULT_VERIFY_OWNER,
  DEFAULT_VERIFY_REPO,
  DEFAULT_VERIFY_REF,
} from '../scripts/verify-github-app-token.ts';
import { resolveRealOctokitAuthOptions } from '../adapters/github-real-deps.ts';
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

// WO-HARNESS-MM-THINMAN-APP-WIRE-01 (IN scope: "Tests for mint/refresh failure
// loudness"): the describe above injects resolveAppAuth to pin the four script
// outcomes, but that alone never exercises the REAL GitHub App auth resolution --
// the mint PRECONDITION. These tests drive the script's DEFAULT resolver
// (resolveGitHubAppAuth) via process.env, so a partial/broken App config is
// proven to fail LOUDLY through the real wiring and never silently downgrade to
// the PAT. `createClient` is a guard that throws if ever constructed: in every
// failing case the client must NOT be built (the failure happens before any
// token-mint/network attempt), which keeps the suite network-free and
// deterministic while still testing the real auth path.
describe('runGitHubAppVerification with the REAL default resolver (env-driven mint precondition)', () => {
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

  const clientMustNotBuild = (): RealGitHubOctokitLike => {
    throw new Error(
      'octokit client constructed before App auth resolved -- mint precondition not enforced'
    );
  };

  test('App vars entirely absent -> real resolver returns null -> not-configured, PAT NOT silently used, no client built', async () => {
    // A PAT is present: the script must still report not-configured rather than
    // quietly minting/using the admin PAT identity.
    process.env.GH_TOKEN = 'ghp_pat_value_present';
    const { logger } = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      createClient: clientMustNotBuild, // resolveAppAuth defaults to the REAL resolver
      logger,
    });

    expect(result.appConfigured).toBe(false);
    expect(result.outcome).toBe('not-configured');
    expect(result.outcome).not.toBe('auth-failed');
    expect(result.ok).toBe(false);
  });

  test('App vars partial (installation id missing) -> real resolver throws loudly -> auth-failed, not swallowed, PAT not used', async () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;
    // A PAT is ALSO present -- must NOT be used in place of the half-configured App.
    process.env.GH_TOKEN = 'ghp_pat_value_present';
    const { logger } = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      createClient: clientMustNotBuild,
      logger,
    });

    expect(result.outcome).toBe('auth-failed');
    expect(result.appConfigured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('GITHUB_APP_INSTALLATION_ID');
  });

  test('malformed private key -> real resolver rejects at construction -> auth-failed (a bad key can never mint a token)', async () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-pem-at-all';
    process.env.GH_TOKEN = 'ghp_pat_value_present';
    const { logger } = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      createClient: clientMustNotBuild,
      logger,
    });

    expect(result.outcome).toBe('auth-failed');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('private_key_malformed');
  });

  test('App vars complete + valid PEM -> real chain selects the App MINT strategy (createAppAuth), not the PAT', () => {
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;
    // A PAT is present but must be bypassed in favor of the App installation identity.
    process.env.GH_TOKEN = 'ghp_pat_value_present';

    // resolveRealOctokitAuthOptions() is exactly what createRealOctokitClient()
    // hands to Octokit. Asserting it selects createAppAuth (with the resolved
    // installation id) proves the real client would MINT an installation token
    // for thinman-overseer[bot] on its first signed request -- not send the PAT.
    const options = resolveRealOctokitAuthOptions();
    expect('authStrategy' in options).toBe(true);
    if ('authStrategy' in options) {
      expect(options.authStrategy).toBe(createAppAuth);
      expect(options.auth.appId).toBe('4574893');
      expect(options.auth.installationId).toBe('153295654');
      expect(options.auth.privateKey).toContain('-----BEGIN');
    }
  });
});

// WO-HARNESS-MM-THINMAN-APP-WIRE-01 (IN scope: "Tests for mint/refresh failure
// loudness"). The two describes above stop at CONFIGURATION: they prove the
// resolver validates env vars and that resolveRealOctokitAuthOptions() SELECTS
// createAppAuth. Neither ever EXECUTES a token mint, so mint/refresh failure
// loudness was still unproven -- a mint that silently resolved to a stale or
// empty token would have passed every test above.
//
// These tests drive the REAL @octokit/auth-app strategy end to end: real RS256
// JWT signing with the App private key, the real
// "POST /app/installations/{installation_id}/access_tokens" mint route, and the
// real token cache + refresh path. Only the HTTP transport is injected, so a
// mint and a refresh genuinely execute while nothing touches the network.
describe('real createAppAuth mint + refresh execution (network-free transport)', () => {
  /** The injected Octokit `request` transport type expected by createAppAuth. */
  type AppAuthRequest = NonNullable<Parameters<typeof createAppAuth>[0]['request']>;

  interface MintCall {
    route: string;
    installationId: unknown;
    /** The App JWT the strategy signed for this mint attempt. */
    authorization: string;
  }

  type MintOutcome = { token: string } | Error;

  /**
   * A stand-in for Octokit's HTTP transport. createAppAuth calls it with the
   * real mint route and a real signed App JWT; the handler decides, per attempt,
   * whether that mint succeeds or fails. Every attempt is recorded so a test can
   * assert a mint actually happened (or provably did NOT).
   */
  function makeMintTransport(handler: (attempt: number) => MintOutcome): {
    transport: AppAuthRequest;
    calls: MintCall[];
  } {
    const calls: MintCall[] = [];
    const fn = async (
      route: string,
      payload: Record<string, unknown>
    ): Promise<{ data: Record<string, unknown> }> => {
      const headers = (payload.headers ?? {}) as { authorization?: string };
      calls.push({
        route,
        installationId: payload.installation_id,
        authorization: headers.authorization ?? '',
      });
      const outcome = handler(calls.length);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return {
        data: {
          token: outcome.token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { checks: 'read' },
          repository_selection: 'all',
        },
      };
    };
    return { transport: fn as unknown as AppAuthRequest, calls };
  }

  function makeAppAuth(transport: AppAuthRequest, privateKey: string = FAKE_PEM) {
    return createAppAuth({
      appId: CONFIGURED_AUTH.appId,
      installationId: CONFIGURED_AUTH.installationId,
      privateKey,
      request: transport,
    });
  }

  /**
   * A client that mints lazily on its first API call -- the same shape as the
   * real Octokit auth hook. A mint failure therefore surfaces at the Checks call,
   * exactly where runGitHubAppVerification would encounter it in production.
   */
  function appAuthedChecksClient(
    auth: ReturnType<typeof createAppAuth>,
    options: { refresh?: boolean; onToken?: (token: string) => void } = {}
  ): RealGitHubOctokitLike {
    return {
      checks: {
        listForRef: async () => {
          const authentication = (await auth({
            type: 'installation',
            ...(options.refresh ? { refresh: true } : {}),
          })) as { token: string };
          options.onToken?.(authentication.token);
          return { data: { check_runs: [{ status: 'completed', conclusion: 'success' }] } };
        },
      },
    } as unknown as RealGitHubOctokitLike;
  }

  test('mint EXECUTES: signs a real App JWT and calls the installation access_tokens route', async () => {
    const { transport, calls } = makeMintTransport(() => ({ token: FAKE_TOKEN }));
    const auth = makeAppAuth(transport);
    let tokenUsed = '';
    const { logger } = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => appAuthedChecksClient(auth, { onToken: t => (tokenUsed = t) }),
      logger,
    });

    // A mint really happened -- not merely a strategy selection.
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toContain('/app/installations/{installation_id}/access_tokens');
    // createAppAuth coerces the installation id to a Number internally, so the
    // mint route receives the numeric form of the resolved config value.
    expect(calls[0].installationId).toBe(Number(CONFIGURED_AUTH.installationId));
    // "bearer eyJ..." is an RS256 JWT signed with the App private key. Its
    // presence proves the key material actually signed, not just parsed.
    expect(calls[0].authorization.startsWith('bearer eyJ')).toBe(true);
    // The minted installation token (not a PAT) is what the API call carried.
    expect(tokenUsed).toBe(FAKE_TOKEN);
    expect(result.outcome).toBe('verified');
    expect(result.ok).toBe(true);
  });

  test('mint FAILURE is loud through the script: api-failed, non-ok, token material redacted', async () => {
    const { transport, calls } = makeMintTransport(
      () => new Error(`HTTP 401: Bad credentials minting installation token (token=${FAKE_TOKEN})`)
    );
    const auth = makeAppAuth(transport);
    const capture = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => appAuthedChecksClient(auth),
      logger: capture.logger,
    });

    // The mint was attempted and its failure propagated -- not swallowed into a
    // false "verified", and not silently downgraded to the PAT identity.
    expect(calls).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('api-failed');
    expect(result.appConfigured).toBe(true);
    expect(result.reason).toContain('HTTP 401');
    // Redaction still holds on the mint-failure path.
    expect(result.reason).toContain('[REDACTED_TOKEN]');
    expect(result.reason).not.toContain(FAKE_TOKEN);
    expect(capture.serialized()).not.toContain(FAKE_TOKEN);
  });

  test('mint failure REJECTS at the auth strategy -- it never resolves to a usable token', async () => {
    const { transport, calls } = makeMintTransport(
      () => new Error('HTTP 404: Installation not found')
    );
    const auth = makeAppAuth(transport);

    await expect(auth({ type: 'installation' })).rejects.toThrow('HTTP 404');
    expect(calls).toHaveLength(1);
  });

  test('a malformed key fails AT MINT TIME before any network call is made', async () => {
    const { transport, calls } = makeMintTransport(() => ({ token: FAKE_TOKEN }));
    const auth = makeAppAuth(
      transport,
      '-----BEGIN RSA PRIVATE KEY-----\nnot-real-base64\n-----END RSA PRIVATE KEY-----\n'
    );

    // JWT signing happens before the mint request, so a bad key can NEVER mint.
    await expect(auth({ type: 'installation' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('REFRESH executes: a cached token is reused, and refresh:true forces a second real mint', async () => {
    const { transport, calls } = makeMintTransport(attempt => ({ token: `ghs_MINTED_${attempt}` }));
    const auth = makeAppAuth(transport);

    const first = (await auth({ type: 'installation' })) as { token: string };
    const cached = (await auth({ type: 'installation' })) as { token: string };
    const refreshed = (await auth({ type: 'installation', refresh: true })) as { token: string };

    expect(first.token).toBe('ghs_MINTED_1');
    // Second call is served from the strategy's token cache -- no extra mint.
    expect(cached.token).toBe('ghs_MINTED_1');
    // refresh:true bypasses the cache and mints again.
    expect(refreshed.token).toBe('ghs_MINTED_2');
    expect(calls).toHaveLength(2);
  });

  test('REFRESH FAILURE is loud: it rejects and never falls back to the stale cached token', async () => {
    const { transport, calls } = makeMintTransport(attempt =>
      attempt === 1
        ? { token: 'ghs_MINTED_1' }
        : new Error('HTTP 401: Bad credentials refreshing installation token')
    );
    const auth = makeAppAuth(transport);

    const first = (await auth({ type: 'installation' })) as { token: string };
    expect(first.token).toBe('ghs_MINTED_1');

    // The refresh must throw. The dangerous silent-failure mode would be
    // resolving with the stale ghs_MINTED_1 while the App is actually revoked.
    let staleToken: string | undefined;
    let refreshError: Error | undefined;
    try {
      const refreshed = (await auth({ type: 'installation', refresh: true })) as { token: string };
      staleToken = refreshed.token;
    } catch (err) {
      refreshError = err as Error;
    }

    expect(staleToken).toBeUndefined();
    expect(refreshError).toBeDefined();
    expect(refreshError?.message).toContain('HTTP 401');
    expect(calls).toHaveLength(2);
  });

  test('refresh failure surfaces through the script as api-failed, not a false verified', async () => {
    const { transport, calls } = makeMintTransport(attempt =>
      attempt === 1
        ? { token: 'ghs_MINTED_1' }
        : new Error('HTTP 401: Bad credentials refreshing installation token')
    );
    const auth = makeAppAuth(transport);
    // Prime the cache with a good token, then force the verification call to refresh.
    await auth({ type: 'installation' });
    const { logger } = makeCapturingLogger();

    const result = await runGitHubAppVerification({
      resolveAppAuth: () => CONFIGURED_AUTH,
      createClient: () => appAuthedChecksClient(auth, { refresh: true }),
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('api-failed');
    expect(result.reason).toContain('HTTP 401');
    expect(calls).toHaveLength(2);
  });
});
