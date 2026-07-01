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
}

/**
 * Cancel a hung run via POST /api/workflows/runs/:id/cancel.
 *
 * @returns { ok: true, error: null } on HTTP 2xx; { ok: false, error } otherwise.
 *          Never throws -- network errors are caught and returned as a result.
 */
export async function cancelRun(opts: CancelRunOptions): Promise<CancelResult> {
  const { runId, apiBaseUrl } = opts;
  const token = opts.token ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';

  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      headers: { 'x-archon-operator-token': token },
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
