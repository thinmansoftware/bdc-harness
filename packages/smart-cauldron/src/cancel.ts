/**
 * cancel.ts -- Best-effort cancellation of a hung workflow run via the Archon API.
 *
 * Used by the cascade's progress-timeout path: when pollForTerminal's watchdog
 * fires (TimeoutError), the cascade cancels the hung run before climbing to the
 * next tier so it doesn't keep burning tokens in the background.
 *
 * Mirrors fire.ts's error-handling style: never throws, always returns a result
 * object so the caller can log-and-continue without the cancel call blocking
 * the climb.
 *
 * Secret boundary: token comes from the ARCHON_OPERATOR_TOKEN env var (or an
 * explicit override); never hardcoded in source.
 */

export interface CancelResult {
  ok: boolean;
  error: string | null;
}

export interface CancelRunOptions {
  runId: string;
  apiBaseUrl: string;
  /** Overrides ARCHON_OPERATOR_TOKEN env var. */
  token?: string;
  /**
   * Human-readable reason recorded on the run_cancelled event (data.reason).
   * REQUIRED and validated non-empty. The cancel route reads this body field and
   * persists it, so a non-empty reason here is what makes
   * `run_cancelled.data.reason` non-empty instead of "" (WO-HARNESS-CONDUCTOR-
   * STALL-DETECTOR-FIX-01, Scope IN item 4). cancelRun refuses to POST when the
   * reason is missing or blank -- it returns { ok: false } rather than sending
   * the forbidden empty reason.
   */
  reason: string;
}

/**
 * Cancel a hung run via POST /api/workflows/runs/:id/cancel.
 *
 * @returns { ok: true, error: null } on HTTP 2xx; { ok: false, error } otherwise.
 *          Never throws -- network errors are caught and returned as a result.
 */
export async function cancelRun(opts: CancelRunOptions): Promise<CancelResult> {
  const { runId, apiBaseUrl, reason } = opts;
  const token = opts.token ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';

  // Scope IN item 4: a conductor cancel MUST carry a non-empty reason. Refuse to
  // POST a blank reason rather than persisting the forbidden empty
  // run_cancelled.data.reason. Fail-closed, consistent with the never-throw
  // result contract (typeof guard also covers JS callers that pass undefined
  // despite the required type).
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason.length === 0) {
    return {
      ok: false,
      error: `[smart-cauldron/cancel] refusing to cancel run ${runId} with an empty reason (run_cancelled.data.reason must be non-empty)`,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'x-archon-operator-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: trimmedReason }),
    });
  } catch (err) {
    const msg = `[smart-cauldron/cancel] network error on POST /api/workflows/runs/${runId}/cancel: ${(err as Error).message}`;
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore body read error
    }
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  return { ok: true, error: null };
}
