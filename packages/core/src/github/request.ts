import {
  getServiceGitHubToken,
  clearServiceGitHubTokenCache,
  resolveServiceGitHubAuth,
  resolveServiceGitHubPatFallback,
  serviceGitHubCredentialName,
  type GitHubService,
  type ServiceGitHubAuth,
} from './service-identity';
import {
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  observationFromResponse,
  recordGitHubApiCall,
} from './metering';
import { emitGitHubCredentialAlert } from './credential-alerts';

export interface ServiceGitHubRequestOptions {
  service: GitHubService;
  url: string | URL;
  init?: RequestInit;
  fetch?: typeof fetch;
  identity?: ServiceGitHubAuth;
  resource?: string;
  permissionFallback?: boolean;
  fallbackToken?: string;
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
    const token = await getServiceGitHubToken(identity, { fetch: options.fetch });
    const headers = new Headers(options.init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
    return (options.fetch ?? fetch)(options.url, { ...options.init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    clearServiceGitHubTokenCache(identity.poolId);
    response = await send();
    if (response.status === 401) {
      const credential = serviceGitHubCredentialName(identity);
      await emitGitHubCredentialAlert({
        subjectKey: `credential:${credential}`,
        credential,
        service: identity.service,
        failureClass: 'unauthorized',
        detail: 'github_request_unauthorized_after_refresh',
      });
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
  const fallbackIdentity = options.fallbackToken
    ? {
        kind: 'pat' as const,
        service: options.service,
        token: options.fallbackToken,
        poolId: 'user-pat' as const,
        distinct: false,
      }
    : resolveServiceGitHubPatFallback(options.service);
  if (!fallbackIdentity) return response;
  return serviceGitHubFetch({
    ...options,
    identity: fallbackIdentity,
    permissionFallback: true,
  });
}
