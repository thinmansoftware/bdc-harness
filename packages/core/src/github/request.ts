import {
  getServiceGitHubToken,
  legacyGitHubUserPat,
  reportGitHubCredentialRefreshFailure,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from './service-identity';
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
}

export function isAppPermissionDenied(response: Response, body: string): boolean {
  return response.status === 403 && /resource not accessible by integration/i.test(body);
}

function isReusableBody(body: NonNullable<RequestInit['body']>): boolean {
  return (
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof FormData !== 'undefined' && body instanceof FormData)
  );
}

/** Buffer a one-shot body so a single 401 retry can send it again. */
async function reusableRequestInit(init?: RequestInit): Promise<RequestInit | undefined> {
  if (!init?.body || isReusableBody(init.body)) return init;
  if (typeof Blob !== 'undefined' && init.body instanceof Blob) {
    return { ...init, body: new Uint8Array(await init.body.arrayBuffer()) };
  }
  return { ...init, body: new Uint8Array(await new Response(init.body).arrayBuffer()) };
}

export async function serviceGitHubFetch(options: ServiceGitHubRequestOptions): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const path = new URL(String(options.url), 'https://api.github.com').pathname;
  const resource =
    options.resource ??
    (path === '/graphql' ? 'graphql' : path.startsWith('/search/') ? 'search' : 'core');
  await assertPersistedGitHubPoolAvailable(identity.poolId, [resource]);
  const init = await reusableRequestInit(options.init);
  const send = async (token: string): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
    const response = await (options.fetch ?? fetch)(options.url, { ...init, headers });
    const observation = observationFromResponse(options.service, identity.poolId, response, {
      permissionFallback: options.permissionFallback,
    });
    if (!response.headers.has('x-ratelimit-resource')) observation.resource = resource;
    recordGitHubApiCall(observation);
    if (observation.rateLimited) await flushGitHubApiMeter();
    return response;
  };

  const token = await getServiceGitHubToken(identity, { fetch: options.fetch });
  const response = await send(token);
  if (response.status !== 401) return response;

  if (identity.kind !== 'app') {
    await reportGitHubCredentialRefreshFailure(identity.service);
    throw new Error(`github_request_unauthorized:${identity.service}`);
  }

  const refreshed = await getServiceGitHubToken(identity, { fetch: options.fetch, force: true });
  const retry = await send(refreshed);
  if (retry.status === 401) {
    await reportGitHubCredentialRefreshFailure(identity.service);
    throw new Error(`github_request_unauthorized:${identity.service}`);
  }
  return retry;
}

export async function serviceGitHubFetchWithPermissionFallback(
  options: ServiceGitHubRequestOptions
): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  const response = await serviceGitHubFetch({ ...options, identity });
  if (identity.kind !== 'app' || response.status !== 403) return response;
  const body = await response.clone().text();
  if (!isAppPermissionDenied(response, body)) return response;
  const token = options.fallbackToken ?? legacyGitHubUserPat();
  if (!token) return response;
  return serviceGitHubFetch({
    ...options,
    identity: { kind: 'pat', service: options.service, token, poolId: 'user-pat', distinct: false },
    permissionFallback: true,
  });
}
