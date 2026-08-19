/**
 * fire.ts -- Fires a WO through Archon's atomic conversation dispatch API.
 *
 * The supported path is one POST /api/conversations containing both the
 * resolved codebaseId and the /workflow run command. The response must prove
 * dispatched:true. The resulting run is discovered by the returned parent
 * conversation database id; no conversation identity is fabricated locally.
 *
 * Secret boundary: apiBaseUrl and token come from the caller or environment.
 */

import type { FireResult } from './types.js';

interface FireTierOptions {
  workflowName: string;
  woId: string;
  /** Registered codebase shortname, for example bdc-harness. */
  project: string;
  /** Workflow arguments, including WO_ID, the explicit project flag, and (when
   *  set) the --dispatch-token flag that the server persists on the run row. */
  message: string;
  /** Archon API base URL, e.g. http://localhost:3090. */
  apiBaseUrl: string;
  /** Operator token for Archon API auth. Defaults to ARCHON_OPERATOR_TOKEN env. */
  token?: string;
  /**
   * Deterministic per-fire dispatch token. When set, run discovery becomes a
   * direct WHERE dispatch_token = <token> lookup, immune to co-fire races. Must
   * match the --dispatch-token value threaded into `message` so the server-side
   * run row carries the same token this lookup queries. When absent, discovery
   * falls back to the deprecated parent-conversation-id scan-and-poll heuristic.
   */
  dispatchToken?: string;
  /** Max token-lookup attempts before giving up. Default: 5. */
  discoverMaxAttempts?: number;
  /**
   * Base backoff between token-lookup attempts (ms). Sleeps grow as
   * base * 2^(attempt-1); with the default 4000 the five attempts span ~60s.
   */
  discoverBackoffBaseMs?: number;
  /** How long to wait for legacy scan discovery before giving up (ms). Default: 30000. */
  discoverTimeoutMs?: number;
  /** Poll interval for legacy scan discovery (ms). Default: 3000. */
  discoverIntervalMs?: number;
}

/**
 * Outcome of run discovery. `runId` is the resolved run id or null; the
 * remaining fields feed the enriched infra-alert message on true failure so we
 * never emit a bare timeout string again.
 */
interface DiscoveryResult {
  runId: string | null;
  token: string | null;
  attempts: number;
  lastQuery: string;
}

interface CodebaseSummary {
  id: string;
  name: string;
}

interface AtomicConversationResponse {
  conversationId?: string;
  id?: string;
  dispatched?: boolean;
  error?: string;
}

interface WorkflowRunSummary {
  id?: string;
  workflow_name?: string;
  parent_conversation_id?: string | null;
  codebase_id?: string | null;
}

interface WorkflowRunByTokenResponse {
  run?: { id?: string } | null;
}

function authHeaders(token: string): Record<string, string> {
  return { 'x-archon-operator-token': token };
}

async function responseSummary(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

function matchesProject(codebaseName: string, project: string): boolean {
  const normalizedName = codebaseName.toLowerCase();
  const normalizedProject = project.toLowerCase();
  const shortName = normalizedName.split('/').pop() ?? normalizedName;
  return normalizedName === normalizedProject || shortName === normalizedProject;
}

async function resolveCodebaseId(
  project: string,
  apiBaseUrl: string,
  token: string
): Promise<{ codebaseId: string | null; error: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/api/codebases`, {
      headers: authHeaders(token),
    });
  } catch (error) {
    return {
      codebaseId: null,
      error: `[smart-cauldron/fire] network error resolving project ${project}: ${(error as Error).message}`,
    };
  }

  if (!response.ok) {
    return {
      codebaseId: null,
      error: `HTTP ${response.status} resolving project ${project}: ${await responseSummary(response)}`,
    };
  }

  let codebases: CodebaseSummary[];
  try {
    codebases = (await response.json()) as CodebaseSummary[];
  } catch (error) {
    return {
      codebaseId: null,
      error: `invalid codebase response while resolving project ${project}: ${(error as Error).message}`,
    };
  }

  const matches = Array.isArray(codebases)
    ? codebases.filter(
        codebase =>
          typeof codebase.id === 'string' &&
          typeof codebase.name === 'string' &&
          matchesProject(codebase.name, project)
      )
    : [];

  if (matches.length !== 1) {
    return {
      codebaseId: null,
      error: `project ${project} resolved to ${String(matches.length)} codebases; exactly one is required`,
    };
  }

  return { codebaseId: matches[0]?.id ?? null, error: null };
}

/** Fire a WO and return only after its workflow run row is discoverable. */
export async function fireTier(opts: FireTierOptions): Promise<FireResult> {
  const {
    workflowName,
    woId,
    project,
    message,
    apiBaseUrl,
    token: tokenOverride,
    dispatchToken,
    discoverMaxAttempts = 5,
    discoverBackoffBaseMs = 4_000,
    discoverTimeoutMs = 30_000,
    discoverIntervalMs = 3_000,
  } = opts;

  const token = tokenOverride ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
  const binding = await resolveCodebaseId(project, apiBaseUrl, token);
  if (binding.codebaseId === null) {
    return { ok: false, runId: null, conversationId: null, infraError: binding.error };
  }

  const requiredPrefix = `WO_ID=${woId} --project ${project}`;
  if (!message.startsWith(requiredPrefix)) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `fire message must start with ${requiredPrefix}`,
    };
  }

  let fireResponse: Response;
  try {
    fireResponse = await fetch(`${apiBaseUrl}/api/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(token),
      },
      body: JSON.stringify({
        codebaseId: binding.codebaseId,
        message: `/workflow run ${workflowName} ${message}`,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `[smart-cauldron/fire] network error on POST /api/conversations: ${(error as Error).message}`,
    };
  }

  if (!fireResponse.ok) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `HTTP ${fireResponse.status}: ${await responseSummary(fireResponse)}`,
    };
  }

  let fireBody: AtomicConversationResponse;
  try {
    fireBody = (await fireResponse.json()) as AtomicConversationResponse;
  } catch (error) {
    return {
      ok: false,
      runId: null,
      conversationId: null,
      infraError: `invalid atomic conversation response: ${(error as Error).message}`,
    };
  }

  const conversationId =
    typeof fireBody.conversationId === 'string' ? fireBody.conversationId : null;
  const parentConversationId = typeof fireBody.id === 'string' ? fireBody.id : null;
  if (fireBody.dispatched !== true || conversationId === null || parentConversationId === null) {
    const detail = typeof fireBody.error === 'string' ? `: ${fireBody.error}` : '';
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError: `atomic conversation did not prove dispatched:true${detail}`,
    };
  }

  const discovery = await discoverRunId({
    dispatchToken,
    parentConversationId,
    workflowName,
    codebaseId: binding.codebaseId,
    apiBaseUrl,
    maxAttempts: discoverMaxAttempts,
    backoffBaseMs: discoverBackoffBaseMs,
    timeoutMs: discoverTimeoutMs,
    intervalMs: discoverIntervalMs,
    token,
  });
  if (discovery.runId === null) {
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError:
        `run discovery failed for parent conversation ${parentConversationId}: ` +
        `token=${discovery.token ?? 'none'} attempts=${String(discovery.attempts)} ` +
        `lastQuery=${discovery.lastQuery}`,
    };
  }

  return { ok: true, runId: discovery.runId, conversationId, infraError: null };
}

/**
 * Resolve the run created by this fire.
 *
 * Primary path (deterministic): when a dispatch token is present, query
 * GET /api/workflows/runs/by-dispatch-token/<token> with bounded retry/backoff.
 * A token uniquely identifies this fire's run, so concurrent co-fires can never
 * cross-link. If every token attempt comes up empty, fall back to a SINGLE pass
 * of the deprecated parent-conversation-id scan before declaring failure.
 *
 * Fallback path (no token): the legacy scan-and-poll heuristic, retained only
 * for callers that do not yet thread a dispatch token.
 */
async function discoverRunId(opts: {
  dispatchToken?: string;
  parentConversationId: string;
  workflowName: string;
  codebaseId: string;
  apiBaseUrl: string;
  maxAttempts: number;
  backoffBaseMs: number;
  timeoutMs: number;
  intervalMs: number;
  token: string;
}): Promise<DiscoveryResult> {
  if (opts.dispatchToken) {
    const byToken = await discoverByDispatchToken(opts.dispatchToken, opts);
    if (byToken.runId !== null) return byToken;

    // Token lookup exhausted: one deprecated scan pass before honest failure.
    const legacyRunId = await legacyScanOnce(opts);
    return {
      runId: legacyRunId,
      token: opts.dispatchToken,
      attempts: byToken.attempts,
      lastQuery: byToken.lastQuery,
    };
  }

  return legacyScanPoll(opts);
}

/** Direct token lookup with bounded retry/backoff. */
async function discoverByDispatchToken(
  dispatchToken: string,
  opts: { apiBaseUrl: string; maxAttempts: number; backoffBaseMs: number; token: string }
): Promise<DiscoveryResult> {
  const url = `${opts.apiBaseUrl}/api/workflows/runs/by-dispatch-token/${encodeURIComponent(
    dispatchToken
  )}`;
  let attempts = 0;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const response = await fetch(url, { headers: authHeaders(opts.token) });
      if (response.ok) {
        const body = (await response.json()) as WorkflowRunByTokenResponse;
        const runId = body.run?.id;
        if (typeof runId === 'string' && runId.length > 0) {
          return { runId, token: dispatchToken, attempts, lastQuery: url };
        }
      }
      // 404 (run row not persisted yet) or empty body: retry after backoff.
    } catch {
      // A transient discovery read does not invalidate the proven dispatch.
    }

    if (attempt < opts.maxAttempts) {
      const backoff = opts.backoffBaseMs * 2 ** (attempt - 1);
      await new Promise<void>(resolve => setTimeout(resolve, backoff));
    }
  }

  return { runId: null, token: dispatchToken, attempts, lastQuery: url };
}

/** Single deprecated scan pass over the runs list. */
async function legacyScanOnce(opts: {
  parentConversationId: string;
  workflowName: string;
  codebaseId: string;
  apiBaseUrl: string;
  token: string;
}): Promise<string | null> {
  const query = new URLSearchParams({ codebaseId: opts.codebaseId, limit: '50' });
  const url = `${opts.apiBaseUrl}/api/workflows/runs?${query.toString()}`;
  try {
    const response = await fetch(url, { headers: authHeaders(opts.token) });
    if (response.ok) {
      const body = (await response.json()) as { runs?: WorkflowRunSummary[] };
      const run = body.runs?.find(
        candidate =>
          candidate.parent_conversation_id === opts.parentConversationId &&
          candidate.workflow_name === opts.workflowName &&
          candidate.codebase_id === opts.codebaseId &&
          typeof candidate.id === 'string'
      );
      if (run?.id) return run.id;
    }
  } catch {
    // A transient discovery read does not invalidate the proven dispatch.
  }
  return null;
}

/** Deprecated scan-and-poll used only when no dispatch token is supplied. */
async function legacyScanPoll(opts: {
  parentConversationId: string;
  workflowName: string;
  codebaseId: string;
  apiBaseUrl: string;
  timeoutMs: number;
  intervalMs: number;
  token: string;
}): Promise<DiscoveryResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const query = new URLSearchParams({ codebaseId: opts.codebaseId, limit: '50' });
  const url = `${opts.apiBaseUrl}/api/workflows/runs?${query.toString()}`;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    const runId = await legacyScanOnce(opts);
    if (runId !== null) return { runId, token: null, attempts, lastQuery: url };
    await new Promise<void>(resolve => setTimeout(resolve, opts.intervalMs));
  }

  return { runId: null, token: null, attempts, lastQuery: url };
}

/**
 * Build the workflow arguments with an explicit, immutable project binding.
 *
 * When `dispatchToken` is supplied it is appended as a `--dispatch-token` flag
 * immediately after `--project`, so it rides on the first line and the server
 * can persist it on the created run row for deterministic discovery. The
 * `WO_ID=... --project ...` prefix is preserved regardless, so fireTier's
 * required-prefix check still holds.
 */
export function buildFireMessage(
  woId: string,
  project: string,
  priorAttemptContext?: string,
  dispatchToken?: string
): string {
  let base = `WO_ID=${woId} --project ${project}`;
  if (dispatchToken) base += ` --dispatch-token ${dispatchToken}`;
  if (!priorAttemptContext) return base;
  return `${base}\n\n## Prior attempt context\n${priorAttemptContext}`;
}
