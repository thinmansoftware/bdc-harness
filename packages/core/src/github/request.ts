import {
  clearServiceGitHubTokenCache,
  getServiceGitHubToken,
  resolvePatFallbackToken,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from './service-identity';
import { alertCredentialFailure } from './credential-alert';
import {
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  observationFromResponse,
  recordGitHubApiCall,
} from './metering';

export interface ServiceGitHubRequestOptions {
  service: GitHubService;
  url: string | URL;
  init?: RequestInit;
  fetch?: typeof fetch;
  identity?: ServiceGitHubAuth;
  resource?: string;
  permissionFallback?: boolean;
  fallbackToken?: string;
  /**
   * Injected for tests; defaults to the shared credential-alert sink. Called
   * once with the failing pool id when a 401 survives one re-mint + retry.
   */
  alertSink?: (credential: string) => void | Promise<void>;
}

export function isAppPermissionDenied(response: Response, body: string): boolean {
  return response.status === 403 && /resource not accessible by integration/i.test(body);
}

async function performServiceGitHubFetch(
  options: ServiceGitHubRequestOptions,
  identity: ServiceGitHubAuth,
  resource: string
): Promise<Response> {
  await assertPersistedGitHubPoolAvailable(identity.poolId, [resource]);
  const token = await getServiceGitHubToken(identity, { fetch: options.fetch });
  const headers = new Headers(options.init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
  const response = await (options.fetch ?? fetch)(options.url, { ...options.init, headers });
  const observation = observationFromResponse(options.service, identity.poolId, response, {
    permissionFallback: options.permissionFallback,
  });
  if (!response.headers.has('x-ratelimit-resource')) observation.resource = resource;
  recordGitHubApiCall(observation);
  if (observation.rateLimited) await flushGitHubApiMeter();
  return response;
}

/**
 * Shared GitHub request wrapper. On a 401 for an App identity it clears the
 * cached installation token, re-mints exactly once, and retries the request
 * once. A second 401 (or a 401 for a credential that cannot refresh) raises one
 * credential alert and propagates the error -- a token expiring never silently
 * drops a GitHub call again.
 */
export async function serviceGitHubFetch(options: ServiceGitHubRequestOptions): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const path = new URL(String(options.url), 'https://api.github.com').pathname;
  const resource =
    options.resource ??
    (path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core');

  const response = await performServiceGitHubFetch(options, identity, resource);
  if (response.status !== 401) return response;

  // 401: an App identity gets exactly one re-mint + retry.
  if (identity.kind === 'app') {
    clearServiceGitHubTokenCache();
    const retry = await performServiceGitHubFetch(options, identity, resource);
    if (retry.status !== 401) return retry;
  }

  // Second 401 (or a non-App 401): the credential cannot refresh itself.
  const alert =
    options.alertSink ??
    (async (credential: string): Promise<void> => {
      await alertCredentialFailure(credential);
    });
  await alert(identity.poolId);
  throw new Error(`github_credential_unrefreshable_401:${identity.poolId}`);
}

export async function serviceGitHubFetchWithPermissionFallback(
  options: ServiceGitHubRequestOptions
): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const response = await serviceGitHubFetch({ ...options, identity });
  if (identity.kind !== 'app' || response.status !== 403) return response;
  const body = await response.clone().text();
  if (!isAppPermissionDenied(response, body)) return response;
  const token = options.fallbackToken ?? resolvePatFallbackToken();
  if (!token) return response;
  return serviceGitHubFetch({
    ...options,
    identity: { kind: 'pat', service: options.service, token, poolId: 'user-pat', distinct: false },
    permissionFallback: true,
  });
}
