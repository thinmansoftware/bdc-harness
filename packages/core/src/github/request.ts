import {
  clearServiceGitHubToken,
  getServiceGitHubToken,
  resolveLegacyGitHubToken,
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

export interface GitHubCredentialAlert {
  credential: string;
  subjectKey: string;
  error: unknown;
}

export type GitHubCredentialAlertSink = (alert: GitHubCredentialAlert) => void | Promise<void>;
const credentialAlertedAt = new Map<string, number>();
const CREDENTIAL_ALERT_DEDUPE_MS = 6 * 60 * 60_000;
let defaultAlertSink: GitHubCredentialAlertSink | undefined;

export function setGitHubCredentialAlertSink(sink: GitHubCredentialAlertSink | undefined): void {
  defaultAlertSink = sink;
}

async function alertCredential(
  credential: string,
  error: unknown,
  sink: GitHubCredentialAlertSink | undefined,
  now: () => number
): Promise<void> {
  if (!sink) return;
  const timestamp = now();
  const last = credentialAlertedAt.get(credential) ?? 0;
  if (timestamp - last < CREDENTIAL_ALERT_DEDUPE_MS) return;
  credentialAlertedAt.set(credential, timestamp);
  await sink({ credential, subjectKey: `credential:${credential}`, error });
}

export interface ServiceGitHubRequestOptions {
  service: GitHubService;
  url: string | URL;
  init?: RequestInit;
  fetch?: typeof fetch;
  identity?: ServiceGitHubAuth;
  resource?: string;
  permissionFallback?: boolean;
  fallbackToken?: string;
  alertSink?: GitHubCredentialAlertSink;
  now?: () => number;
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
  const now = options.now ?? Date.now;
  const mintOptions = {
    fetch: options.fetch,
    now,
    onMintFailure: async (_identity: unknown, error: unknown): Promise<void> =>
      alertCredential(identity.poolId, error, options.alertSink ?? defaultAlertSink, now),
  };
  let token = await getServiceGitHubToken(identity, mintOptions);
  const request = async (): Promise<Response> => {
    const headers = new Headers(options.init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('accept')) headers.set('accept', 'application/vnd.github+json');
    return (options.fetch ?? fetch)(options.url, { ...options.init, headers });
  };
  let response = await request();
  if (response.status === 401 && identity.kind === 'app') {
    clearServiceGitHubToken(identity);
    token = await getServiceGitHubToken(identity, mintOptions);
    response = await request();
    if (response.status === 401) {
      await alertCredential(
        identity.poolId,
        new Error('github_credential_unauthorized'),
        options.alertSink ?? defaultAlertSink,
        now
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
  const token = options.fallbackToken ?? resolveLegacyGitHubToken();
  if (!token) return response;
  return serviceGitHubFetch({
    ...options,
    identity: { kind: 'pat', service: options.service, token, poolId: 'user-pat', distinct: false },
    permissionFallback: true,
  });
}
