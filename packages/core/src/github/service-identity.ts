import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLogger } from '@archon/paths';
import { alertCredentialFailure } from './credential-alert';

const log = createLogger('github/service-identity');

/**
 * The legacy merge-manager PAT env var name. Declared here (the single place
 * allowed to name GitHub token env vars) so no other source file carries the
 * bare `MERGE_MANAGER_GH_TOKEN` string. Exported for the merge-identity tests.
 */
export const MERGE_MANAGER_GH_TOKEN_ENV = 'MERGE_MANAGER_GH_TOKEN' as const;

export type GitHubService =
  | 'overseer'
  | 'pr_discovery'
  | 'merge_manager'
  | 'taskmaster'
  | 'duty_officer'
  | 'smart_cauldron'
  | 'run_nodes';

export const SERVICE_GITHUB_AUTH_PRECEDENCE = {
  overseer: ['service_app', 'shared_overseer_app', 'pat'],
  pr_discovery: ['service_app', 'shared_overseer_app', 'pat'],
  merge_manager: ['service_app', 'merge_manager_pat', 'hold'],
  taskmaster: ['service_app', 'taskmaster_app_alias', 'shared_overseer_app', 'pat'],
  duty_officer: ['service_app', 'taskmaster_app_alias', 'shared_overseer_app', 'pat'],
  smart_cauldron: ['service_app', 'pat'],
  run_nodes: ['service_app', 'pat'],
} as const satisfies Record<GitHubService, readonly string[]>;

export interface GitHubAppIdentity {
  kind: 'app';
  service: GitHubService;
  appId: string;
  installationId: string;
  privateKey: string;
  poolId: string;
  distinct: true;
}

export interface GitHubPatIdentity {
  kind: 'pat';
  service: GitHubService;
  token: string;
  poolId: 'user-pat' | 'merge-manager-pat';
  distinct: boolean;
}

export interface GitHubHeldIdentity {
  kind: 'none';
  service: 'merge_manager';
  poolId: 'none';
  distinct: false;
}

export type ServiceGitHubAuth = GitHubAppIdentity | GitHubPatIdentity | GitHubHeldIdentity;
type Env = Record<string, string | undefined>;

function servicePrefix(service: GitHubService): string {
  return `GITHUB_APP_${service.toUpperCase()}_`;
}

function resolveApp(prefix: string, service: GitHubService, env: Env): GitHubAppIdentity | null {
  const idName = `${prefix}ID`;
  const installationName = `${prefix}INSTALLATION_ID`;
  const keyName = `${prefix}PRIVATE_KEY`;
  const pathName = `${prefix}PRIVATE_KEY_PATH`;
  const appId = env[idName]?.trim() ?? '';
  const installationId = env[installationName]?.trim() ?? '';
  const inlineKey = env[keyName] ?? '';
  const keyPath = env[pathName]?.trim() ?? '';
  const any = Boolean(appId || installationId || inlineKey.trim() || keyPath);
  if (!any) return null;

  const missing: string[] = [];
  if (!appId) missing.push(idName);
  if (!installationId) missing.push(installationName);
  if (!inlineKey.trim() && !keyPath) missing.push(`${keyName} or ${pathName}`);
  if (missing.length) throw new Error(`github_app_auth_incomplete: missing ${missing.join(', ')}`);

  let privateKey = inlineKey;
  if (!privateKey.trim()) {
    try {
      privateKey = readFileSync(keyPath, 'utf8');
    } catch {
      throw new Error(`github_app_auth_private_key_unreadable: ${pathName}`);
    }
  }
  privateKey = privateKey.replace(/\\n/g, '\n').trim();
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error(`github_app_auth_private_key_malformed: ${keyName} or ${pathName}`);
  }
  return {
    kind: 'app',
    service,
    appId,
    installationId,
    privateKey,
    poolId: `app-${appId}-${installationId}`,
    distinct: true,
  };
}

function pat(
  service: GitHubService,
  token: string,
  poolId: GitHubPatIdentity['poolId'],
  distinct: boolean
): GitHubPatIdentity {
  return { kind: 'pat', service, token, poolId, distinct };
}

export function resolveServiceGitHubAuth(
  service: GitHubService,
  env: Env = process.env
): ServiceGitHubAuth {
  const own = resolveApp(servicePrefix(service), service, env);
  if (own && service === 'merge_manager') {
    const reviewer =
      resolveApp('GITHUB_APP_OVERSEER_', 'overseer', env) ??
      resolveApp('GITHUB_APP_', 'overseer', env);
    if (reviewer?.appId === own.appId) {
      return { kind: 'none', service: 'merge_manager', poolId: 'none', distinct: false };
    }
  }

  // Builder lanes must never share the reviewer identity or borrow the Taskmaster
  // alias. They resolve their own App (GITHUB_APP_RUN_NODES_* / _SMART_CAULDRON_*)
  // or the PAT -- nothing else. A builder App that equals the reviewer App is a
  // hard error so a lane can never open a PR authored by thinman-overseer[bot].
  if (service === 'run_nodes' || service === 'smart_cauldron') {
    if (own) {
      const reviewer =
        resolveApp('GITHUB_APP_OVERSEER_', 'overseer', env) ??
        resolveApp('GITHUB_APP_', 'overseer', env);
      if (reviewer?.appId === own.appId) {
        throw new Error(
          `builder_identity_equals_reviewer: ${service} App id equals the reviewer App id`
        );
      }
      return own;
    }
    return pat(service, env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '', 'user-pat', false);
  }

  if (own) return own;

  if (service === 'overseer' || service === 'pr_discovery') {
    const shared = resolveApp('GITHUB_APP_', service, env);
    if (shared) return shared;
    const token = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '';
    if (!token) throw new Error(`github_auth_missing: ${service}`);
    return pat(service, token, 'user-pat', false);
  }
  if (service === 'merge_manager') {
    const token = env.MERGE_MANAGER_GH_TOKEN ?? '';
    return token
      ? pat(service, token, 'merge-manager-pat', true)
      : { kind: 'none', service, poolId: 'none', distinct: false };
  }

  const alias = resolveApp('GITHUB_APP_TASKMASTER_', service, env);
  if (alias) return alias;
  const shared = resolveApp('GITHUB_APP_', service, env);
  if (shared) return shared;
  const token =
    service === 'duty_officer'
      ? (env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '')
      : (env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '');
  return pat(service, token, 'user-pat', false);
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
// Single-flight: concurrent callers for the same App pool share one in-flight
// mint instead of each firing their own installation-token request.
const mintInFlight = new Map<string, Promise<string>>();
// Refresh an installation token once fewer than this many ms of its ~1h life
// remain, so a request never carries a token about to expire mid-flight.
const TOKEN_REFRESH_SKEW_MS = 10 * 60_000;
// Throttle the PAT-fallback warning to once per hour per service.
const PAT_WARN_INTERVAL_MS = 60 * 60_000;
const patWarnedAt = new Map<GitHubService, number>();

function warnPatFallback(service: GitHubService, now: number): void {
  const last = patWarnedAt.get(service);
  if (last !== undefined && now - last < PAT_WARN_INTERVAL_MS) return;
  patWarnedAt.set(service, now);
  log.warn(
    { service },
    'github.pat_fallback_used: a long-lived PAT was used for GitHub auth; it cannot self-refresh and should be retired in favor of a GitHub App identity'
  );
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

// Mint a signed GitHub App JWT (RS256) for the given App identity. `now` is a
// resolved epoch-millisecond timestamp; it defaults to the current time. Shared
// by getServiceGitHubToken (installation-token mint) and
// scripts/github-service-login.ts (GET /app slug lookup) so the header/payload/
// signature shape stays in lockstep.
export function buildAppJwt(identity: GitHubAppIdentity, now: number = Date.now()): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
      iss: identity.appId,
    })
  );
  const signature = base64Url(
    sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), identity.privateKey)
  );
  return `${header}.${payload}.${signature}`;
}

export async function getServiceGitHubToken(
  identity: ServiceGitHubAuth,
  options: {
    fetch?: typeof fetch;
    apiBaseUrl?: string;
    now?: () => number;
    /**
     * Injected for tests; defaults to the shared credential-alert sink. Called
     * once with the failing App pool id when an installation-token mint (initial
     * or refresh) fails, so an unmintable credential raises the same deduped
     * operator Dispatch alert a surviving-401 does.
     */
    alertSink?: (credential: string) => void | Promise<void>;
  } = {}
): Promise<string> {
  const now = (options.now ?? Date.now)();
  if (identity.kind === 'pat') {
    warnPatFallback(identity.service, now);
    return identity.token;
  }
  if (identity.kind === 'none') throw new Error('github_merge_identity_not_distinct');
  const cached = tokenCache.get(identity.poolId);
  if (cached && cached.expiresAt - now > TOKEN_REFRESH_SKEW_MS) return cached.token;

  // Single-flight: if a mint for this pool is already running, await it rather
  // than launching a second installation-token request.
  const existing = mintInFlight.get(identity.poolId);
  if (existing) return existing;

  // Alert once (deduped) when the mint fails, then rethrow: a credential that
  // cannot mint an installation token is just as unusable as one whose minted
  // token is rejected with a 401, so both must raise the operator alert. The
  // alert is wrapped into the single-flight promise so concurrent awaiters
  // share one alert rather than each firing their own.
  const minting = mintInstallationToken(identity, now, options).catch(async (error: unknown) => {
    const alert =
      options.alertSink ??
      (async (credential: string): Promise<void> => {
        await alertCredentialFailure(credential);
      });
    try {
      await alert(identity.poolId);
    } catch (alertError) {
      log.error({ err: alertError as Error, pool: identity.poolId }, 'github.mint_alert_failed');
    }
    throw error;
  });
  mintInFlight.set(identity.poolId, minting);
  try {
    return await minting;
  } finally {
    mintInFlight.delete(identity.poolId);
  }
}

async function mintInstallationToken(
  identity: GitHubAppIdentity,
  now: number,
  options: { fetch?: typeof fetch; apiBaseUrl?: string }
): Promise<string> {
  const jwt = buildAppJwt(identity, now);
  const response = await (options.fetch ?? fetch)(
    `${options.apiBaseUrl ?? 'https://api.github.com'}/app/installations/${identity.installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': 'bdc-harness-service-auth',
        'x-github-api-version': '2022-11-28',
      },
    }
  );
  if (!response.ok) throw new Error(`github_app_token_mint_failed:${response.status}`);
  const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== 'string')
    throw new Error('github_app_token_mint_failed:invalid_response');
  const expiresAt =
    typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : now + 55 * 60_000;
  tokenCache.set(identity.poolId, { token: body.token, expiresAt });
  return body.token;
}

export function clearServiceGitHubTokenCache(): void {
  tokenCache.clear();
  mintInFlight.clear();
}

/**
 * Resolve and mint (or return the cached/PAT) token for a service in one call.
 * This is the single accessor non-Octokit callers use so no file reads
 * GH_TOKEN/GITHUB_TOKEN directly. App identities return a refreshing
 * installation token; PAT identities return the PAT (with a throttled warning).
 */
export async function getGitHubTokenForService(
  service: GitHubService,
  env: Env = process.env
): Promise<string> {
  return getServiceGitHubToken(resolveServiceGitHubAuth(service, env));
}

/**
 * The raw PAT-fallback token from the standard env vars. The ONLY place the bare
 * GH_TOKEN/GITHUB_TOKEN env read is allowed; callers that need the legacy PAT
 * (permission fallback, read-only required-contexts) route through here instead
 * of reading process.env themselves. Returns '' when no PAT is configured.
 */
export function resolvePatFallbackToken(env: Env = process.env): string {
  return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '';
}

/**
 * True when a usable GitHub credential resolves for the service: an App
 * identity, or a PAT with a non-empty token. A 'none' (held) identity, an empty
 * PAT, or an incomplete/invalid App config all resolve to false. Used by
 * presence checks that previously read process.env.GITHUB_TOKEN directly.
 */
export function hasServiceGitHubAuth(service: GitHubService, env: Env = process.env): boolean {
  try {
    const identity = resolveServiceGitHubAuth(service, env);
    if (identity.kind === 'app') return true;
    if (identity.kind === 'pat') return identity.token.trim().length > 0;
    return false;
  } catch {
    return false;
  }
}

/** Preserve service selection and original permission fallback across a CLI shim. */
export async function serviceGitHubCommandEnvironment(
  service: GitHubService,
  env: Env = process.env,
  token: typeof getServiceGitHubToken = getServiceGitHubToken
): Promise<{ env: Env; poolId: string }> {
  const identity = resolveServiceGitHubAuth(service, env);
  const selectedToken = await token(identity);
  return {
    poolId: identity.poolId,
    env: {
      ...env,
      GH_TOKEN: selectedToken,
      GITHUB_TOKEN: selectedToken,
      ARCHON_GITHUB_SERVICE: service,
      ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN:
        env.ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN ?? '',
    },
  };
}
