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
import type { ExpectedSpecIdentity } from '@archon/core/workflows/work-order-source';
import { posix, win32 } from 'node:path';
import { workflowDefinitionSchema } from '../../workflows/src/schemas/workflow.js';

interface FireTierOptions {
  workflowName: string;
  woId: string;
  /** Registered codebase shortname, for example bdc-harness. */
  project: string;
  /** Workflow arguments, including WO_ID and the explicit project flag. */
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

interface CodebaseSummary {
  id: string;
  name: string;
  default_cwd?: unknown;
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

export async function resolveCodebaseId(
  project: string,
  apiBaseUrl: string,
  token: string,
  readJson?: (url: string) => Promise<unknown>
): Promise<{ codebaseId: string | null; error: string | null; defaultCwd?: unknown }> {
  if (readJson) {
    const codebases = await readJson(`${apiBaseUrl}/api/codebases`);
    return selectCodebase(codebases, project);
  }
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

  return selectCodebase(codebases, project);
}

function selectCodebase(
  codebases: unknown,
  project: string
): {
  codebaseId: string | null;
  error: string | null;
  defaultCwd?: unknown;
} {
  const matches: CodebaseSummary[] = Array.isArray(codebases)
    ? codebases.filter(
        codebase =>
          codebase !== null &&
          typeof codebase === 'object' &&
          typeof codebase.id === 'string' &&
          codebase.id.length > 0 &&
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

  return { codebaseId: matches[0]?.id ?? null, error: null, defaultCwd: matches[0]?.default_cwd };
}

const CODEX_ONLY_WORKFLOW = 'bdc-feature-development-codex-only';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Two authenticated reads with one deadline, including response body consumption. */
export async function preflightCodexOnly(
  project: string,
  apiBaseUrl: string,
  token: string
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('codex_only_preflight_timeout'));
      controller.abort();
    }, 10_000);
  });
  const readJson = async (url: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await Promise.race([
        fetch(url, {
          headers: authHeaders(token),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch {
      throw new Error(
        controller.signal.aborted ? 'codex_only_preflight_timeout' : 'codex_only_preflight_network'
      );
    }
    if (!response.ok) throw new Error('codex_only_preflight_http');
    try {
      return await Promise.race([response.json(), timeout]);
    } catch {
      throw new Error(
        controller.signal.aborted ? 'codex_only_preflight_timeout' : 'codex_only_preflight_json'
      );
    }
  };
  try {
    const target = await resolveCodebaseId(project, apiBaseUrl, token, readJson);
    if (!target.codebaseId) throw new Error('codex_only_project_unresolved');
    const cwd = target.defaultCwd;
    if (
      typeof cwd !== 'string' ||
      !cwd.trim() ||
      Array.from(cwd).some(character => character.charCodeAt(0) < 32) ||
      !(posix.isAbsolute(cwd) || win32.isAbsolute(cwd))
    ) {
      throw new Error('codex_only_invalid_cwd');
    }
    const body = await readJson(
      `${apiBaseUrl}/api/workflows/${CODEX_ONLY_WORKFLOW}?cwd=${encodeURIComponent(cwd)}`
    );
    if (
      !isObject(body) ||
      body.filename !== `${CODEX_ONLY_WORKFLOW}.yaml` ||
      (body.source !== 'project' && body.source !== 'bundled') ||
      !isObject(body.workflow)
    ) {
      throw new Error('codex_only_workflow_invalid');
    }
    const workflow = body.workflow;
    if (
      workflow.name !== CODEX_ONLY_WORKFLOW ||
      !Array.isArray(workflow.nodes) ||
      !workflow.nodes.length
    ) {
      throw new Error('codex_only_workflow_invalid');
    }
    const checkProvider = (definition: Record<string, unknown>): void => {
      if (
        (definition.provider ?? workflow.provider) !== 'codex' ||
        ('provider' in definition && definition.provider !== 'codex') ||
        ('failover_provider' in definition && definition.failover_provider !== 'codex')
      ) {
        throw new Error('codex_only_provider_forbidden');
      }
    };
    if (workflow.provider !== 'codex') throw new Error('codex_only_provider_forbidden');
    checkProvider(workflow);
    for (const node of workflow.nodes) {
      if (!isObject(node)) {
        throw new Error('codex_only_workflow_invalid');
      }
      checkProvider(node);
    }
    // Validate the actual engine definition without importing/executing its DAG.
    // Raw exact provider checks above precede schema trimming/defaults.
    if (!workflowDefinitionSchema.safeParse(workflow).success) {
      throw new Error('codex_only_workflow_invalid');
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

  const runId = await discoverRunId({
    parentConversationId,
    workflowName,
    codebaseId: binding.codebaseId,
    apiBaseUrl,
    timeoutMs: discoverTimeoutMs,
    intervalMs: discoverIntervalMs,
    token,
  });
  if (runId === null) {
    return {
      ok: false,
      runId: null,
      conversationId,
      infraError: `run discovery timeout after ${discoverTimeoutMs}ms for parent conversation ${parentConversationId}`,
    };
  }

  return { ok: true, runId, conversationId, infraError: null };
}

async function discoverRunId(opts: {
  parentConversationId: string;
  workflowName: string;
  codebaseId: string;
  apiBaseUrl: string;
  timeoutMs: number;
  intervalMs: number;
  token: string;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const query = new URLSearchParams({ codebaseId: opts.codebaseId, limit: '50' });

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${opts.apiBaseUrl}/api/workflows/runs?${query.toString()}`, {
        headers: authHeaders(opts.token),
      });
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

    await new Promise<void>(resolve => setTimeout(resolve, opts.intervalMs));
  }

  return null;
}

/** Build the workflow arguments with an explicit, immutable project binding. */
export function buildFireMessage(
  woId: string,
  project: string,
  priorAttemptContext?: string,
  expectedSpec?: ExpectedSpecIdentity
): string {
  const binding = expectedSpec
    ? ` --expected-spec=${Buffer.from(JSON.stringify(expectedSpec)).toString('base64url')}`
    : '';
  const base = `WO_ID=${woId} --project ${project}${binding}`;
  if (!priorAttemptContext) return base;
  return `${base}\n\n## Prior attempt context\n${priorAttemptContext}`;
}
