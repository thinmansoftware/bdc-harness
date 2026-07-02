/**
 * fire.ts -- Fires a WO on a given workflow lane via the Archon HTTP API.
 *
 * CRITICAL: POST /api/workflows/:name/run returns { accepted, status } ONLY.
 * It does NOT return a runId. The runId must be resolved by a discovery poll
 * via GET /api/workflows/runs/by-worker/{conversationId} after the fire call.
 *
 * Secret boundary: apiBaseUrl comes from env; never hardcoded in source.
 */

import { randomUUID } from 'crypto';
import type { FireResult } from './types.js';

interface FireTierOptions {
  workflowName: string;
  woId: string;
  /** Full message to send (may include prior attempt context). */
  message: string;
  /** Archon API base URL, e.g. http://localhost:3090. */
  apiBaseUrl: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env. */
  token?: string;
  /** How long to wait for run discovery before giving up (ms). Default: 30000. */
  discoverTimeoutMs?: number;
  /** Poll interval for discovery (ms). Default: 3000. */
  discoverIntervalMs?: number;
}

/**
 * Fire a WO run on the given workflow lane.
 *
 * Steps:
 * 1. Generate a fresh conversationId (UUID).
 * 2. POST /api/workflows/{workflowName}/run with { conversationId, message }.
 * 3. On HTTP error: return infra-error FireResult immediately.
 * 4. On HTTP 200: poll GET /api/workflows/runs/by-worker/{conversationId}
 *    until the run row appears or discovery times out.
 *
 * @returns FireResult with ok=true and resolved runId, or ok=false with infraError.
 */
export async function fireTier(opts: FireTierOptions): Promise<FireResult> {
  const {
    workflowName,
    message,
    apiBaseUrl,
    token: tokenOverride,
    discoverTimeoutMs = 30_000,
    discoverIntervalMs = 3_000,
  } = opts;

  const token = tokenOverride ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
  const conversationId = randomUUID();

  // Step 1: Fire the run
  let fireRes: Response;
  try {
    fireRes = await fetch(`${apiBaseUrl}/api/workflows/${encodeURIComponent(workflowName)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': token },
      body: JSON.stringify({ conversationId, message }),
    });
  } catch (err) {
    const msg = `[smart-cauldron/fire] network error on POST /api/workflows/${workflowName}/run: ${(err as Error).message}`;
    return { ok: false, runId: null, conversationId, infraError: msg };
  }

  if (!fireRes.ok) {
    let body = '';
    try {
      body = await fireRes.text();
    } catch {
      // ignore body read error
    }
    const msg = `HTTP ${fireRes.status}: ${body.slice(0, 200)}`;
    return { ok: false, runId: null, conversationId, infraError: msg };
  }

  // Step 2: Discover the runId via by-worker endpoint
  const runId = await discoverRunId(
    conversationId,
    apiBaseUrl,
    discoverTimeoutMs,
    discoverIntervalMs,
    token
  );
  if (runId === null) {
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError: `run discovery timeout after ${discoverTimeoutMs}ms for conversationId ${conversationId}`,
    };
  }

  return { ok: true, runId, conversationId, infraError: null };
}

/**
 * Poll GET /api/workflows/runs/by-worker/{conversationId} until the run appears.
 * Returns the runId string on success, or null on timeout.
 */
async function discoverRunId(
  conversationId: string,
  apiBaseUrl: string,
  timeoutMs: number,
  intervalMs: number,
  token: string
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/workflows/runs/by-worker/${encodeURIComponent(conversationId)}`,
        { headers: { 'x-archon-operator-token': token } }
      );
      if (res.ok) {
        const body = (await res.json()) as { run?: { id?: string } };
        const id = body.run?.id;
        if (id && typeof id === 'string') {
          return id;
        }
      }
      // 404 or no run yet -- wait and retry
    } catch {
      // Network error during discovery -- wait and retry
    }

    // Wait before next poll
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }

  return null;
}

/**
 * Build a message string for firing a WO, optionally including prior attempt context
 * so the next tier starts informed rather than blind.
 */
export function buildFireMessage(
  woId: string,
  project: string,
  priorAttemptContext?: string
): string {
  const base = `${woId} --project ${project}`;
  if (!priorAttemptContext) {
    return base;
  }
  return `${base}\n\n## Prior attempt context\n${priorAttemptContext}`;
}
