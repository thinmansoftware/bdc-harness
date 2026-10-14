export interface RateLimitClassification {
  retryAfterMs: number;
  retryAfter: string;
  source: 'retry_after_header' | 'reset_header' | 'default';
  kind: 'primary' | 'secondary';
}
export const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
export const MAX_RATE_LIMIT_RETRY_MS = 3_600_000;
function header(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers && typeof headers === 'object') {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === 'function')
      return (getter.call(headers, name) as string | null | undefined) ?? undefined;
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return value === undefined ? undefined : String(value);
  }
  return undefined;
}
export function classifyRateLimitError(
  error: unknown,
  now = new Date()
): RateLimitClassification | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as {
    status?: number;
    message?: string;
    response?: { status?: number; headers?: unknown };
    headers?: unknown;
  };
  const status = value.status ?? value.response?.status;
  if (status !== 403 && status !== 429) return null;
  const headers = value.headers ?? value.response?.headers;
  const remaining = header(headers, 'x-ratelimit-remaining');
  const retry = header(headers, 'retry-after');
  const reset = header(headers, 'x-ratelimit-reset');
  const message = (value.message ?? '').toLowerCase();
  const primary = Number(remaining) === 0;
  if (
    status === 403 &&
    !primary &&
    retry === undefined &&
    !message.includes('rate limit') &&
    !message.includes('abuse detection')
  )
    return null;
  let retryAfterMs = DEFAULT_RATE_LIMIT_RETRY_MS;
  let source: RateLimitClassification['source'] = 'default';
  if (retry && Number(retry) > 0) {
    retryAfterMs = Number(retry) * 1000;
    source = 'retry_after_header';
  } else if (reset && Number(reset) > 0) {
    retryAfterMs = Number(reset) * 1000 - now.getTime();
    source = 'reset_header';
  }
  retryAfterMs = Math.min(MAX_RATE_LIMIT_RETRY_MS, Math.max(1, Math.ceil(retryAfterMs)));
  return {
    retryAfterMs,
    retryAfter: new Date(now.getTime() + retryAfterMs).toISOString(),
    source,
    kind: primary ? 'primary' : 'secondary',
  };
}
export const isRateLimitError = (error: unknown): boolean => classifyRateLimitError(error) !== null;

export class GitHubPoolBackoff {
  private readonly until = new Map<string, number>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms =>
      new Promise(resolve => setTimeout(resolve, ms))
  ) {}
  async wait(poolId: string, resource: string): Promise<void> {
    const delay = (this.until.get(`${poolId}\0${resource}`) ?? 0) - this.now();
    if (delay > 0) await this.sleep(delay);
  }
  note(poolId: string, resource: string, resetAt: number): void {
    this.until.set(`${poolId}\0${resource}`, resetAt);
  }
}
