export type ProbeErrorClass =
  | 'structural_model_not_supported'
  | 'structural_account_model_incompat'
  | 'transient_rate_limit'
  | 'transient_timeout'
  | 'transient_server_error'
  | 'unknown_400'
  | 'unknown';

export type ProbeDecisionKind = 'structural' | 'transient' | 'unknown';

export interface ProbeClassification {
  readonly kind: ProbeDecisionKind;
  readonly errorClass: ProbeErrorClass;
  readonly httpStatus?: number;
  readonly excerpt: string;
}

export interface ClassifiableProbeError {
  readonly httpStatus?: number;
  readonly status?: number;
  readonly statusCode?: number;
  readonly body?: unknown;
  readonly message?: string;
}

const STRUCTURAL_MODEL_PATTERNS = [
  'not supported',
  'model is not supported',
  'unsupported model',
  'not available',
  'not found',
  'access denied',
];

const ACCOUNT_MODEL_PATTERNS = ['when using codex with a chatgpt account'];
const TRANSIENT_PATTERNS = [
  'rate limit',
  'too many requests',
  '429',
  'timeout',
  'timed out',
  'connection reset',
  'econnreset',
  'overloaded',
];

function stringifyBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === undefined || body === null) return '';
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

export function errorExcerpt(error: unknown, limit = 500): string {
  const err = error as ClassifiableProbeError;
  const raw = [err?.message, stringifyBody(err?.body), String(error)].filter(Boolean).join(' ');
  return raw.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[REDACTED]').slice(0, limit);
}

export function classifyProbeError(error: unknown): ProbeClassification {
  const err = error as ClassifiableProbeError;
  const httpStatus = err?.httpStatus ?? err?.status ?? err?.statusCode;
  const excerpt = errorExcerpt(error);
  const text = excerpt.toLowerCase();

  if (httpStatus === 429 || TRANSIENT_PATTERNS.some(pattern => text.includes(pattern))) {
    return {
      kind: 'transient',
      errorClass: httpStatus === 429 ? 'transient_rate_limit' : 'transient_timeout',
      httpStatus,
      excerpt,
    };
  }

  if (httpStatus !== undefined && httpStatus >= 500) {
    return { kind: 'transient', errorClass: 'transient_server_error', httpStatus, excerpt };
  }

  if (text.includes('model') && STRUCTURAL_MODEL_PATTERNS.some(pattern => text.includes(pattern))) {
    return {
      kind: 'structural',
      errorClass: 'structural_model_not_supported',
      httpStatus,
      excerpt,
    };
  }

  if (ACCOUNT_MODEL_PATTERNS.some(pattern => text.includes(pattern))) {
    return {
      kind: 'structural',
      errorClass: 'structural_account_model_incompat',
      httpStatus,
      excerpt,
    };
  }

  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return { kind: 'unknown', errorClass: 'unknown_400', httpStatus, excerpt };
  }

  return { kind: 'unknown', errorClass: 'unknown', httpStatus, excerpt };
}

export const classify = classifyProbeError;
