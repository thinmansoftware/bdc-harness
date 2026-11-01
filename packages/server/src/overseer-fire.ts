import { listCodebases } from '@archon/core/db/codebases';
import { listWorkflowRuns } from '@archon/core/db/workflows';
import { findLiveRunsForWo } from './routes/wo-fire-guard';

export interface OverseerFireInput {
  workflowName: string;
  woId: string;
  project: string;
  runId: string;
}
export type OverseerFireResult =
  | { ok: true; runId: string; conversationId: string }
  | { ok: false; error: string };

export function createOverseerFireWorkflowRun(config: {
  port: number;
  operatorToken: string;
  fetch?: typeof fetch;
  listCodebases?: typeof listCodebases;
  findLiveRuns?: typeof findLiveRunsForWo;
  discoverRuns?: typeof listWorkflowRuns;
  discoverTimeoutMs?: number;
  discoverIntervalMs?: number;
}): (input: OverseerFireInput) => Promise<OverseerFireResult> {
  const request = config.fetch ?? fetch;
  const findCodebases = config.listCodebases ?? listCodebases;
  const findLiveRuns = config.findLiveRuns ?? findLiveRunsForWo;
  const discoverRuns = config.discoverRuns ?? listWorkflowRuns;
  return async input => {
    const matches = (await findCodebases()).filter(codebase => codebase.name === input.project);
    if (matches.length !== 1) return { ok: false, error: 'project_not_unique' };
    const codebase = matches[0];
    if ((await findLiveRuns(input.woId)).length > 0)
      return { ok: false, error: 'duplicate_wo_live' };
    const message = `/workflow run ${input.workflowName} WO_ID=${input.woId} --project ${input.project} --fired_by=overseer-refire --refire_of=${input.runId}`;
    let response: Response;
    try {
      response = await request(`http://127.0.0.1:${config.port}/api/conversations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-archon-operator-token': config.operatorToken,
        },
        body: JSON.stringify({ codebaseId: codebase.id, message }),
      });
    } catch (error) {
      return { ok: false, error: `fire_failed:${(error as Error).message}` };
    }
    if (!response.ok) return { ok: false, error: `fire_http_${response.status}` };
    const body = (await response.json()) as {
      dispatched?: boolean;
      id?: string;
      conversationId?: string;
      error?: string;
    };
    if (body.dispatched !== true || !body.id || !body.conversationId)
      return { ok: false, error: body.error ?? 'dispatch_not_proven' };
    const deadline = Date.now() + (config.discoverTimeoutMs ?? 30_000);
    do {
      const runs = await discoverRuns({ limit: 100 });
      const successor = runs.find(
        run =>
          run.parent_conversation_id === body.id &&
          run.workflow_name === input.workflowName &&
          run.codebase_id === codebase.id
      );
      if (successor) return { ok: true, runId: successor.id, conversationId: body.conversationId };
      await new Promise(resolve => setTimeout(resolve, config.discoverIntervalMs ?? 250));
    } while (Date.now() < deadline);
    return { ok: false, error: 'successor_discovery_timeout' };
  };
}
