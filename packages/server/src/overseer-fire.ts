import { findCodebasesByName } from '@archon/core/db/codebases';
import { listWorkflowRuns } from '@archon/core/db/workflows';
import { findLiveRunsForWo } from './routes/wo-fire-guard';

export interface OverseerFireInput {
  workflowName: string;
  woId: string;
  project: string;
  predecessorRunId: string;
}

export type OverseerFireResult =
  | { ok: true; runId: string; conversationId: string }
  | { ok: false; indeterminate: true; error: string; conversationId: string }
  | { ok: false; error: string };

interface FireDeps {
  findCodebasesByName: typeof findCodebasesByName;
  findLiveRunsForWo: typeof findLiveRunsForWo;
  fetch: typeof fetch;
  discoverRuns: (codebaseId: string) => Promise<
    readonly {
      id: string;
      workflow_name: string;
      parent_conversation_id: string | null;
      codebase_id: string | null;
      user_message?: string | null;
    }[]
  >;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

export function createOverseerFireWorkflowRun(options: {
  port: number;
  operatorToken: string;
  discoverTimeoutMs?: number;
  discoverIntervalMs?: number;
  deps?: Partial<FireDeps>;
}): (input: OverseerFireInput) => Promise<OverseerFireResult> {
  const deps: FireDeps = {
    findCodebasesByName,
    findLiveRunsForWo,
    fetch,
    discoverRuns: async codebaseId => {
      const rows = await listWorkflowRuns({ codebaseId, limit: 100 });
      return rows.map(row => ({
        id: row.id,
        workflow_name: row.workflow_name,
        parent_conversation_id: row.parent_conversation_id,
        codebase_id: row.codebase_id,
        user_message: row.user_message,
      }));
    },
    now: Date.now,
    wait: ms => new Promise(resolveWait => setTimeout(resolveWait, ms)),
    ...options.deps,
  };
  const timeout = options.discoverTimeoutMs ?? 30_000;
  const interval = options.discoverIntervalMs ?? 250;

  return async input => {
    if (
      !/^[A-Za-z0-9._-]+$/.test(input.workflowName) ||
      /deploy|production|release/i.test(input.workflowName)
    ) {
      return { ok: false, error: 'forbidden_workflow_target' };
    }
    const codebases = await deps.findCodebasesByName(input.project);
    if (codebases.length !== 1) return { ok: false, error: 'project_resolution_failed' };
    const codebase = codebases[0]!;
    if ((await deps.findLiveRunsForWo(input.woId)).length > 0) {
      return { ok: false, error: 'duplicate_wo_live' };
    }
    const message = `/workflow run ${input.workflowName} WO_ID=${input.woId} --project ${input.project} --fired_by=overseer-refire --refire_of=${input.predecessorRunId}`;
    let response: Response;
    try {
      response = await deps.fetch(`http://127.0.0.1:${options.port}/api/conversations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-archon-operator-token': options.operatorToken,
        },
        body: JSON.stringify({ codebaseId: codebase.id, message }),
      });
    } catch (error) {
      return { ok: false, error: `fire_network_error:${(error as Error).message}` };
    }
    if (!response.ok) return { ok: false, error: `fire_http_${response.status}` };
    const body = (await response.json()) as {
      dispatched?: boolean;
      id?: string;
      conversationId?: string;
      error?: string;
    };
    if (body.dispatched !== true || !body.id || !body.conversationId) {
      return { ok: false, error: body.error ?? 'dispatch_not_proven' };
    }
    const deadline = deps.now() + timeout;
    do {
      const runs = await deps.discoverRuns(codebase.id);
      const run = runs.find(
        candidate =>
          candidate.parent_conversation_id === body.id &&
          candidate.workflow_name === input.workflowName &&
          candidate.codebase_id === codebase.id &&
          (candidate.user_message ?? '').includes(`--refire_of=${input.predecessorRunId}`)
      );
      if (run) return { ok: true, runId: run.id, conversationId: body.conversationId };
      if (deps.now() >= deadline) break;
      await deps.wait(interval);
    } while (deps.now() <= deadline);
    return {
      ok: false,
      indeterminate: true,
      error: 'successor_discovery_timeout',
      conversationId: body.conversationId,
    };
  };
}
