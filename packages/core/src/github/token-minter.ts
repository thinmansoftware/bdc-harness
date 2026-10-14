import { createSign } from 'node:crypto';
import type { ServiceGitHubAuth } from './service-identity';

export interface MintedGitHubToken {
  kind: 'app' | 'pat';
  poolId: string;
  token: string;
  expiresAt: number | null;
}
export interface TokenMinterOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  baseUrl?: string;
}
const cache = new Map<string, Promise<MintedGitHubToken>>();

export async function mintServiceGitHubToken(
  auth: ServiceGitHubAuth,
  options: TokenMinterOptions = {}
): Promise<MintedGitHubToken> {
  if (auth.kind === 'none') throw new Error('No GitHub identity configured');
  if (auth.kind === 'pat')
    return { kind: 'pat', poolId: auth.poolId, token: auth.token, expiresAt: null };
  const now = options.now?.() ?? Date.now();
  const cached = cache.get(auth.poolId);
  if (cached) {
    const value = await cached;
    if (value.expiresAt !== null && value.expiresAt - now > 5 * 60_000) return value;
    cache.delete(auth.poolId);
  }
  const pending = (async () => {
    const epoch = Math.floor(now / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: epoch - 60, exp: epoch + 540, iss: auth.appId })}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    const jwt = `${unsigned}.${signer.sign(auth.privateKey, 'base64url')}`;
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl ?? 'https://api.github.com'}/app/installations/${encodeURIComponent(auth.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'user-agent': 'bdc-harness',
          'x-github-api-version': '2022-11-28',
        },
      }
    );
    if (!response.ok) throw new Error(`GitHub App token mint failed: HTTP ${response.status}`);
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || typeof body.expires_at !== 'string')
      throw new Error('GitHub App token mint returned an invalid response');
    return {
      kind: 'app' as const,
      poolId: auth.poolId,
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    };
  })();
  cache.set(auth.poolId, pending);
  try {
    return await pending;
  } catch (error) {
    cache.delete(auth.poolId);
    throw error;
  }
}

export function clearGitHubTokenCache(): void {
  cache.clear();
}
