/** Ensure a timestamp string ends with 'Z' for UTC parsing. */
export function ensureUtc(timestamp: string): string {
  return timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';
}

/** Format the duration between two timestamps as a human-readable string. */
export function formatDuration(startedAt: string, completedAt: string | null): string {
  const start = new Date(ensureUtc(startedAt)).getTime();
  const end = completedAt ? new Date(ensureUtc(completedAt)).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/** Format a started_at timestamp as a short locale string (e.g., "Mar 10, 2:30 PM"). */
export function formatStarted(startedAt: string): string {
  const d = new Date(ensureUtc(startedAt));
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a duration in milliseconds as a human-readable string (e.g., "1.2s", "3.5m"). */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format an iteration counter label for loop nodes in the DAG viz.
 * Returns "iter X/MAX" for running (or unspecified) status, "iter X/MAX (done)" for
 * completed / completed_with_warning, and "iter X/MAX (failed)" for failed. Status
 * param accepts WorkflowStepStatus strings.
 */
export function formatIterLabel(
  currentIteration: number,
  maxIterations: number,
  status?: string
): string {
  const base = `iter ${String(currentIteration)}/${String(maxIterations)}`;
  if (status === 'completed' || status === 'completed_with_warning') return `${base} (done)`;
  if (status === 'failed') return `${base} (failed)`;
  return base;
}

/**
 * Short display form of a workflow run id (first 8 chars).
 * DISPLAY ONLY -- never pass the return value to navigation or API calls.
 * GET /api/workflows/runs/<id> requires the full 32-char id; a short prefix 404s.
 */
export function shortRunId(runId: string): string {
  if (!runId) return '';
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

/**
 * Build the client route for a workflow run detail page.
 * Always uses the full run id so graph hydration / GET /api/workflows/runs/:id works.
 */
export function workflowRunDetailPath(runId: string): string {
  const id = (runId ?? '').trim();
  if (!id) {
    throw new Error('workflowRunDetailPath requires a non-empty full run id');
  }
  // Guard against accidental short-id wiring: known sqlite/pg ids are 32 hex chars
  // (no dashes). If someone passes an 8-char display token, fail closed instead of
  // navigating to a permanently-spinning "Loading graph..." detail page.
  if (/^[0-9a-f]{8}$/i.test(id)) {
    throw new Error(
      `workflowRunDetailPath received truncated display id "${id}"; pass the full run id`
    );
  }
  return `/workflows/runs/${encodeURIComponent(id)}`;
}

/**
 * Build the REST path used by getWorkflowRun / cancel / approve / etc.
 * Same full-id requirement as workflowRunDetailPath.
 */
export function workflowRunApiPath(runId: string, suffix = ''): string {
  const id = (runId ?? '').trim();
  if (!id) {
    throw new Error('workflowRunApiPath requires a non-empty full run id');
  }
  if (/^[0-9a-f]{8}$/i.test(id)) {
    throw new Error(
      `workflowRunApiPath received truncated display id "${id}"; pass the full run id`
    );
  }
  const base = `/api/workflows/runs/${encodeURIComponent(id)}`;
  if (!suffix) return base;
  return suffix.startsWith('/') ? `${base}${suffix}` : `${base}/${suffix}`;
}
