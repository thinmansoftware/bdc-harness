/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — failure classification.
 *
 * Turns a raw node `error` string into a short class label + full detail.
 * The class label renders on the node face ("codex 400: model not supported")
 * so the operator can read WHY a node failed without opening the JSONL log;
 * the full error string is preserved on hover and in the NodePeekPanel.
 *
 * Pure: no React, no DOM, no I/O. Testable in isolation.
 */

export interface FailureClassification {
  /** Short, human-readable label suitable for a tight node face slot. */
  label: string;
  /** The original error string, unmodified. */
  detail: string;
}

/**
 * Classify an error string into a stable label. Pattern matching is
 * case-insensitive and falls through to `unknown` if no patterns match.
 *
 * Ordering is significant — more specific patterns (codex 400 vs generic 400)
 * are tested first.
 */
export function classifyFailure(error: string | undefined | null): FailureClassification {
  const detail = error ?? '';
  if (!detail) return { label: 'unknown', detail };

  const lc = detail.toLowerCase();

  // Codex 4xx model-not-supported: the lived incident the WO was named for.
  if (
    (lc.includes('codex') || lc.includes('gpt-')) &&
    /\b4\d{2}\b/.test(lc) &&
    (lc.includes('not supported') || lc.includes('model'))
  ) {
    return { label: 'codex 400: model not supported', detail };
  }

  // Auth: 401 / Unauthorized / Invalid token / API key.
  if (
    /\b401\b/.test(lc) ||
    lc.includes('unauthorized') ||
    lc.includes('invalid token') ||
    lc.includes('invalid api key') ||
    lc.includes('forbidden') ||
    /\b403\b/.test(lc)
  ) {
    return { label: 'auth: invalid token', detail };
  }

  // Rate-limit.
  if (/\b429\b/.test(lc) || lc.includes('rate limit') || lc.includes('rate-limit')) {
    return { label: 'rate-limit', detail };
  }

  // Crash / OOM / signal.
  if (
    lc.includes('sigkill') ||
    lc.includes('sigsegv') ||
    lc.includes('sigterm') ||
    lc.includes('oom') ||
    lc.includes('out of memory') ||
    lc.includes('crash')
  ) {
    return { label: 'crash', detail };
  }

  // Timeout.
  if (lc.includes('timeout') || lc.includes('timed out') || lc.includes('etimedout')) {
    return { label: 'timeout', detail };
  }

  // Generic 5xx server error.
  if (/\b5\d{2}\b/.test(lc)) {
    return { label: 'server error', detail };
  }

  return { label: 'unknown', detail };
}
