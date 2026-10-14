import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from './service-identity';
import {
  assertGitHubPoolAvailable,
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

export async function serviceGitHubFetch(options: ServiceGitHubRequestOptions): Promise<Response> {
  const identity = options.identity ?? resolveServiceGitHubAuth(options.service);
  assertGitHubPoolAvailable(identity.poolId, options.resource ?? 'core');
  const token = await getServiceGitHubToken(identity, { fetch: options.fetch });
  const headers = new Headers(options.init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
  const response = await (options.fetch ?? fetch)(options.url, { ...options.init, headers });
  recordGitHubApiCall(
    observationFromResponse(options.service, identity.poolId, response, {
      permissionFallback: options.permissionFallback,
    })
  );
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
  const token = options.fallbackToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) return response;
  return serviceGitHubFetch({
    ...options,
    identity: { kind: 'pat', service: options.service, token, poolId: 'user-pat', distinct: false },
    permissionFallback: true,
  });
}
