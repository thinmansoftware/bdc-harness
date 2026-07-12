export type ProbeErrorClass =
  | 'structural_model_not_supported'
  | 'structural_account_model_incompat'
  | 'structural_unknown_provider'
  | 'transient_rate_limit'
  | 'transient_timeout'
  | 'transient_server_error'
  | 'unknown_400'
  | 'unknown_error';

export type ProbeErrorKind = 'structural' | 'transient' | 'unknown';

export interface ProbeClassification {
  readonly kind: ProbeErrorKind;
  readonly errorClass: ProbeErrorClass;
  readonly httpStatus: number | null;
  readonly errorBodyExcerpt: string;
}

export interface ProbeClassifyInput {
  readonly error?: unknown;
  readonly httpStatus?: number | null;
  readonly body?: string;
}

const STRUCTURAL_MODEL_PATTERNS = [
  'not supported',
  'model is not supported',
  'unsupported model',
  'not available',
  'not found',
  'access denied',
];

const ACCOUNT_INCOMPAT_PATTERNS = ['when using codex with a chatgpt account'];
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const TIMEOUT_PATTERNS = ['timeout', 'timed out', 'etimedout', 'deadline'];
const RESET_PATTERNS = ['connection reset', 'econnreset', 'socket hang up'];

export function classifyProbeError(input: ProbeClassifyInput | unknown): ProbeClassification {
  const normalized = normalizeInput(input);
  const body = normalized.body.toLowerCase();
  const hasModel = body.includes('model');

  if (normalized.httpStatus === 429 || RATE_LIMIT_PATTERNS.some(pattern => body.includes(pattern))) {
    return build('transient', 'transient_rate_limit', normalized);
  }
  if (TIMEOUT_PATTERNS.some(pattern => body.includes(pattern))) {
    return build('transient', 'transient_timeout', normalized);
  }
  if (
    (normalized.httpStatus !== null && normalized.httpStatus >= 500) ||
    RESET_PATTERNS.some(pattern => body.includes(pattern))
  ) {
    return build('transient', 'transient_server_error', normalized);
  }
  if (hasModel && STRUCTURAL_MODEL_PATTERNS.some(pattern => body.includes(pattern))) {
    return build('structural', 'structural_model_not_supported', normalized);
  }
  if (ACCOUNT_INCOMPAT_PATTERNS.some(pattern => body.includes(pattern))) {
    return build('structural', 'structural_account_model_incompat', normalized);
  }
  if (normalized.httpStatus !== null && normalized.httpStatus >= 400 && normalized.httpStatus < 500) {
    return build('unknown', 'unknown_400', normalized);
  }
  return build('unknown', 'unknown_error', normalized);
}

export function isStructuralProbeError(input: ProbeClassifyInput | unknown): boolean {
  return classifyProbeError(input).kind === 'structural';
}

function build(
  kind: ProbeErrorKind,
  errorClass: ProbeErrorClass,
  input: NormalizedProbeError
): ProbeClassification {
  return {
    kind,
    errorClass,
    httpStatus: input.httpStatus,
    errorBodyExcerpt: excerpt(input.body),
  };
}

interface NormalizedProbeError {
  readonly httpStatus: number | null;
  readonly body: string;
}

function normalizeInput(input: ProbeClassifyInput | unknown): NormalizedProbeError {
  if (input && typeof input === 'object' && ('error' in input || 'body' in input || 'httpStatus' in input)) {
    const explicit = input as ProbeClassifyInput;
    const fromError = normalizeError(explicit.error);
    return {
      httpStatus: explicit.httpStatus ?? fromError.httpStatus,
      body: explicit.body ?? fromError.body,
    };
  }
  return normalizeError(input);
}

function normalizeError(error: unknown): NormalizedProbeError {
  if (!error) return { httpStatus: null, body: '' };
  if (typeof error === 'string') return { httpStatus: parseStatus(error), body: error };
  if (error instanceof Error) {
    const record = error as Error & { status?: number; statusCode?: number; response?: unknown; body?: unknown };
    return {
      httpStatus: numberOrNull(record.status ?? record.statusCode ?? readNestedStatus(record.response)),
      body: String(record.body ?? readNestedBody(record.response) ?? error.message),
    };
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const body = record.body ?? record.message ?? record.error ?? JSON.stringify(record);
    return {
      httpStatus: numberOrNull(record.status ?? record.statusCode ?? record.httpStatus),
      body: String(body),
    };
  }
  return { httpStatus: null, body: String(error) };
}

function readNestedStatus(response: unknown): unknown {
  return response && typeof response === 'object' ? (response as Record<string, unknown>).status : undefined;
}

function readNestedBody(response: unknown): unknown {
  return response && typeof response === 'object'
    ? ((response as Record<string, unknown>).body ?? (response as Record<string, unknown>).data)
    : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStatus(value: string): number | null {
  const match = value.match(/\b([45][0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}

function excerpt(value: string): string {
  return value.replace(/[A-Za-z0-9_-]{24,}/g, '[REDACTED]').slice(0, 500);
}
