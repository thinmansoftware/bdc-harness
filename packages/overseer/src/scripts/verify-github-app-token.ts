/**
 * GitHub App installation-token verification for Merge Manager / overseer.
 *
 * Purpose (WO-HARNESS-MM-THINMAN-APP-WIRE-01, done-when #2 + #3):
 *   Give the "installation token mints successfully" and "Checks API returns
 *   HTTP 200" claims a RUNNABLE command instead of a manual assertion. This
 *   script is what an operator runs INSIDE archon-app-1 after deploy:
 *
 *     bun run verify-github-app        # from packages/overseer/
 *     docker exec archon-app-1 bun run verify-github-app
 *
 * It resolves the Thinman Overseer GitHub App auth (App ID 4574893,
 * installation 153295654) via the SAME precedence chain the Merge Manager uses
 * (resolveGitHubAppAuth -> createRealOctokitClient), constructs a real Octokit
 * client, and calls the Checks API against a known repo. Because the App auth
 * strategy mints the installation token lazily on the first signed API call, a
 * successful Checks call proves BOTH the mint (#2) and the 200 response (#3).
 *
 * Redaction contract: NEVER logs the PEM, the private key, or the raw
 * installation token. It logs only non-secret identifiers (appId, installationId,
 * owner/repo/ref) and outcome. appId/installationId are public App coordinates,
 * not secrets.
 *
 * Loudness contract: resolveGitHubAppAuth() throws loudly when App vars are
 * partially set (never silently downgrades to the PAT). This script surfaces
 * that failure and exits NON-ZERO so it is a genuine CI/operator-checkable
 * command (Rule 4). When App vars are entirely absent it reports
 * "not configured" DISTINCTLY from an auth failure.
 *
 * Network-free by construction: runGitHubAppVerification() takes injectable deps
 * so tests can pass a mock Octokit-like object without hitting GitHub. The
 * default deps wire the real resolver + client.
 */
import { createLogger } from '@archon/paths';
import {
  createRealOctokitClient,
  resolveGitHubAppAuth,
  type GitHubAppAuthConfig,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps';

const log = createLogger('verify-github-app');

/**
 * Defensively mask any GitHub token-like substring before it can reach a log or
 * a returned reason. Octokit error messages normally do NOT echo the token, but
 * the redaction contract is absolute -- an arbitrary upstream error string must
 * never leak `ghs_`/`ghp_`/PAT material. Covers App installation tokens (`ghs_`),
 * classic/OAuth/user/refresh tokens (`gh[opur]_`), and fine-grained PATs.
 */
export function redactTokens(input: string): string {
  return input
    .replace(/gh[posur]_[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_TOKEN]');
}

/** Known repo + ref the verification call is made against. */
export const DEFAULT_VERIFY_OWNER = 'thinmansoftware';
export const DEFAULT_VERIFY_REPO = 'bdc-harness';
export const DEFAULT_VERIFY_REF = 'dev';

export interface GitHubAppVerificationDeps {
  /** Resolve App auth config, or null when App vars are entirely absent. */
  resolveAppAuth?: () => GitHubAppAuthConfig | null;
  /** Construct the real Octokit client (App-preferred auth). */
  createClient?: () => RealGitHubOctokitLike;
  owner?: string;
  repo?: string;
  ref?: string;
  logger?: Pick<ReturnType<typeof createLogger>, 'info' | 'warn' | 'error'>;
}

export interface GitHubAppVerificationResult {
  /** True only when a real Checks API call succeeded with the App token. */
  ok: boolean;
  /** True when App auth is configured (vars present + PEM valid). */
  appConfigured: boolean;
  /** Machine-readable outcome tag. */
  outcome: 'verified' | 'not-configured' | 'auth-failed' | 'api-failed';
  /** Human-readable reason for a non-ok result. */
  reason?: string;
  /** Number of check runs returned by the Checks API on success. */
  checksTotal?: number;
}

/**
 * Verify the GitHub App installation token can mint and call the Checks API.
 *
 * Distinct outcomes:
 *  - `not-configured`: no GITHUB_APP_* vars set -> App auth unavailable. This is
 *    NOT an auth failure; it means the container has not been wired yet.
 *  - `auth-failed`: App vars partially set / PEM malformed -> resolveAppAuth
 *    threw. Loud failure (this is the exact half-config the WO exists to catch).
 *  - `api-failed`: token minted / client built but the Checks API call threw
 *    (bad installation, network, 4xx/5xx). Loud failure.
 *  - `verified`: Checks API returned successfully -> token minted (#2) and the
 *    call returned 200 (#3).
 */
export async function runGitHubAppVerification(
  deps: GitHubAppVerificationDeps = {}
): Promise<GitHubAppVerificationResult> {
  const resolveAppAuth = deps.resolveAppAuth ?? resolveGitHubAppAuth;
  const createClient = deps.createClient ?? createRealOctokitClient;
  const owner = deps.owner ?? DEFAULT_VERIFY_OWNER;
  const repo = deps.repo ?? DEFAULT_VERIFY_REPO;
  const ref = deps.ref ?? DEFAULT_VERIFY_REF;
  const logger = deps.logger ?? log;

  // Step 1: resolve App auth. A partial/broken config throws loudly here; we do
  // NOT swallow it into a generic failure -- surface the specific message.
  let appAuth: GitHubAppAuthConfig | null;
  try {
    appAuth = resolveAppAuth();
  } catch (err) {
    const reason = redactTokens((err as Error).message);
    logger.error({ outcome: 'auth-failed', reason }, 'github_app_verify_failed');
    return { ok: false, appConfigured: false, outcome: 'auth-failed', reason };
  }

  if (appAuth === null) {
    const reason =
      'GitHub App auth not configured: set GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, ' +
      'and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH). Merge Manager requires these.';
    logger.warn({ outcome: 'not-configured', reason }, 'github_app_verify_not_configured');
    return { ok: false, appConfigured: false, outcome: 'not-configured', reason };
  }

  // Non-secret coordinates only. Never log appAuth.privateKey.
  logger.info(
    { appId: appAuth.appId, installationId: appAuth.installationId, owner, repo, ref },
    'github_app_verify_started'
  );

  // Step 2 + 3: build the App-authed client and make a real Checks API call.
  // The App auth strategy mints the installation token lazily on this first
  // signed request, so success here proves both the mint and the 200 response.
  try {
    const octokit = createClient();
    const response = await octokit.checks.listForRef({ owner, repo, ref });
    const checksTotal = response.data.check_runs.length;
    logger.info(
      {
        appId: appAuth.appId,
        installationId: appAuth.installationId,
        owner,
        repo,
        ref,
        checksTotal,
      },
      'github_app_verify_completed'
    );
    return { ok: true, appConfigured: true, outcome: 'verified', checksTotal };
  } catch (err) {
    const reason = redactTokens((err as Error).message);
    logger.error(
      { appId: appAuth.appId, installationId: appAuth.installationId, owner, repo, ref, reason },
      'github_app_verify_failed'
    );
    return { ok: false, appConfigured: true, outcome: 'api-failed', reason };
  }
}

async function main(): Promise<void> {
  const result = await runGitHubAppVerification();
  // Exit non-zero on ANY non-verified outcome so this is a real gate: an operator
  // or CI treats a failure as a failure, not a silent pass.
  process.exit(result.ok ? 0 : 1);
}

// Only run when invoked directly (not when imported by the test file).
if (import.meta.main) {
  void main().catch(err => {
    log.error({ err: (err as Error).message }, 'github_app_verify_unexpected');
    process.exit(1);
  });
}
