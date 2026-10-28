import {
  getServiceGitHubToken,
  clearServiceGitHubTokenCacheForIdentity,
  resolveServiceGitHubAuth,
  resolveServiceGitHubPatFallback,
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
  alert?: typeof alertCredentialFailure;
}

export function isAppPermissionDenied(response: Response, body: string): boolean {
  return response.status === 403 && /resource not accessible by integration/i.test(body);
}

export async function serviceGitHubFetch(options: ServiceGitHubRequestOptions): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const path = new URL(String(options.url), 'https://api.github.com').pathname;
  const resource =
    options.resource ??
    (path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core');
  await assertPersistedGitHubPoolAvailable(identity.poolId, [resource]);
  const send = async (): Promise<Response> => {
    const token = await getServiceGitHubToken(identity, {
      fetch: options.fetch,
      alert: options.alert,
    });
    const headers = new Headers(options.init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
    return (options.fetch ?? fetch)(options.url, { ...options.init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    clearServiceGitHubTokenCacheForIdentity(identity);
    response = await send();
    if (response.status === 401) {
      await (options.alert ?? alertCredentialFailure)(
        identity.poolId,
        new Error(`github_credential_unauthorized:${identity.poolId}`)
      );
    }
  }
  const observation = observationFromResponse(options.service, identity.poolId, response, {
    permissionFallback: options.permissionFallback,
  });
  if (!response.headers.has('x-ratelimit-resource')) observation.resource = resource;
  recordGitHubApiCall(observation);
  if (observation.rateLimited) await flushGitHubApiMeter();
  return response;
}

export async function serviceGitHubFetchWithPermissionFallback(
  options: ServiceGitHubRequestOptions
): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const response = await serviceGitHubFetch({ ...options, identity });
  if (identity.kind !== 'app' || response.status !== 403) return response;
  const body = await response.clone().text();
  if (!isAppPermissionDenied(response, body)) return response;
  const fallbackIdentity = resolveServiceGitHubPatFallback(options.service);
  const token =
    options.fallbackToken ??
    (fallbackIdentity
      ? await getServiceGitHubToken(fallbackIdentity, { alert: options.alert })
      : '');
  if (!token) return response;
  return serviceGitHubFetch({
    ...options,
    identity: { kind: 'pat', service: options.service, token, poolId: 'user-pat', distinct: false },
    permissionFallback: true,
  });
}
