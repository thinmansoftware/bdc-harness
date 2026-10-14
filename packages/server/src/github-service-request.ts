import {
  resolvePatFallback,
  resolveServiceGitHubAuth,
  type GitHubService,
} from '@archon/core/github/service-identity';
import { mintServiceGitHubToken } from '@archon/core/github/token-minter';
import { classifyRateLimitError, GitHubPoolBackoff } from '@archon/core/github/rate-limit';
import { GitHubApiMeter } from '@archon/core/github/metering';
import { flushGitHubApiMeter } from '@archon/core/db/github-api';

const backoff = new GitHubPoolBackoff();
const meter = new GitHubApiMeter({ flush: flushGitHubApiMeter });
const permissionGap = (response: Response, body: string) =>
  response.status === 403 && /resource not accessible by integration/i.test(body);

export async function serviceGitHubToken(service: GitHubService): Promise<string | undefined> {
  const auth = resolveServiceGitHubAuth(service);
  return auth.kind === 'none' ? undefined : (await mintServiceGitHubToken(auth)).token;
}

export async function serviceGitHubFetch(
  service: GitHubService,
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const auth = resolveServiceGitHubAuth(service);
  if (auth.kind === 'none') throw new Error(`${service}_github_identity_missing`);
  const minted = await mintServiceGitHubToken(auth);
  await backoff.wait(minted.poolId, 'core');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${minted.token}`);
  headers.set('accept', headers.get('accept') ?? 'application/vnd.github+json');
  let response = await fetchImpl(input, { ...init, headers });
  let body = '';
  if (auth.kind === 'app' && response.status === 403) {
    body = await response.clone().text();
    if (permissionGap(response, body)) {
      const pat = resolvePatFallback();
      meter.record({
        service,
        poolId: auth.poolId,
        resource: response.headers.get('x-ratelimit-resource') ?? 'core',
        status: 403,
        permissionFallback: true,
      });
      if (pat.kind === 'pat') {
        const fallbackHeaders = new Headers(init.headers);
        fallbackHeaders.set('authorization', `Bearer ${pat.token}`);
        fallbackHeaders.set('accept', headers.get('accept')!);
        response = await fetchImpl(input, { ...init, headers: fallbackHeaders });
      }
    }
  }
  const resource = response.headers.get('x-ratelimit-resource') ?? 'core';
  const limit = Number(response.headers.get('x-ratelimit-limit'));
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  const classification = classifyRateLimitError({
    status: response.status,
    message: body,
    response: { headers: response.headers },
  });
  if (classification)
    backoff.note(minted.poolId, resource, Date.now() + classification.retryAfterMs);
  meter.record({
    service,
    poolId: minted.poolId,
    resource,
    status: response.status,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(Number.isFinite(remaining) ? { remaining } : {}),
    ...(Number.isFinite(reset) ? { resetAt: reset } : {}),
    rateLimited: Boolean(classification),
  });
  void meter.flush();
  return response;
}
