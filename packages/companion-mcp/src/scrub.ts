const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const GITHUB_PAT_PATTERN = /github_pat_[A-Za-z0-9_]{8,}/g;
const GITHUB_CLASSIC_PATTERN = /\bgh[pous]_[A-Za-z0-9]{8,}/g;
const ANTHROPIC_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const STRIPE_SECRET_PATTERN = /sk_(?:live|test)_[A-Za-z0-9]{8,}/g;
const STRIPE_RESTRICTED_PATTERN = /rk_live_[A-Za-z0-9]{8,}/g;
const GENERIC_SK_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}/g;
const SLACK_PATTERN = /\bxox[a-z]-[A-Za-z0-9-]{8,}/g;
const AWS_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const AUTH_HEADER_PATTERN = /Authorization:\s*Bearer\s+\S+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/g;
const USERINFO_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s]*/gi;
const GITHUB_TOKEN_URL_PATTERN = /https:\/\/[^/\s:@]+@github\.com[^\s]*/gi;

const PATTERNS: readonly RegExp[] = [
  PEM_PATTERN,
  GITHUB_PAT_PATTERN,
  GITHUB_CLASSIC_PATTERN,
  ANTHROPIC_PATTERN,
  STRIPE_SECRET_PATTERN,
  STRIPE_RESTRICTED_PATTERN,
  GENERIC_SK_PATTERN,
  SLACK_PATTERN,
  AWS_PATTERN,
  JWT_PATTERN,
  AUTH_HEADER_PATTERN,
  BEARER_PATTERN,
  USERINFO_URL_PATTERN,
  GITHUB_TOKEN_URL_PATTERN,
];

export function scrub(value: string): string {
  let next = value;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, '[REDACTED]');
  }
  return next;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrub(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubDeep(item));
  }
  if (typeof value === 'object' && value !== null && isPlainObject(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = scrubDeep(item);
    }
    return next;
  }
  return value;
}
