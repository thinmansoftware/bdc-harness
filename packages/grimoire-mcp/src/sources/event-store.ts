/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDatabase } from '@archon/core/db/connection';
import { listExpectations } from '@archon/core/db/taskmaster';
import type { IDatabase } from '@archon/core/db/adapters/types';
import type { CauldronRun, SourceStatus } from '../card-types';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function firstLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.split(/\r?\n/, 1)[0] || null;
}

export async function readEventStore(
  input: { owner: string; repo: string; number: number; headRef: string },
  database: IDatabase = getDatabase()
): Promise<{ runs: CauldronRun[]; status: SourceStatus }> {
  try {
    const urls = [
      `https://github.com/${input.owner}/${input.repo}/pull/${input.number}`,
      `https://github.com/bluedevilcollectibles/${input.repo}/pull/${input.number}`,
    ];
    const rows = await database.query<any>(
      `SELECT r.id, r.workflow_name, r.status, r.started_at,
        (SELECT e.step_name FROM remote_agent_workflow_events e WHERE e.workflow_run_id = r.id AND e.event_type = 'node_failed' ORDER BY e.created_at ASC LIMIT 1) AS failing_node,
        (SELECT e.data FROM remote_agent_workflow_events e WHERE e.workflow_run_id = r.id AND e.event_type = 'node_failed' ORDER BY e.created_at ASC LIMIT 1) AS failure_data
       FROM remote_agent_workflow_runs r
       WHERE r.started_at >= $1 AND (r.user_message LIKE $2 OR r.metadata LIKE $2 OR EXISTS (
         SELECT 1 FROM remote_agent_workflow_events e WHERE e.workflow_run_id = r.id
         AND e.step_name IN ('open-pr-if-needed','patch-pr-body') AND (e.data LIKE $3 OR e.data LIKE $4)))
       ORDER BY r.started_at DESC LIMIT 3`,
      [
        new Date(Date.now() - 30 * 86400000).toISOString(),
        `%${input.headRef}%`,
        `%${urls[0]}%`,
        `%${urls[1]}%`,
      ]
    );
    return {
      status: 'ok',
      runs: rows.rows.map((row: any) => {
        let error: unknown = null;
        try {
          error =
            typeof row.failure_data === 'string'
              ? JSON.parse(row.failure_data).error
              : row.failure_data?.error;
        } catch {
          error = row.failure_data;
        }
        return {
          id: String(row.id),
          workflow: String(row.workflow_name),
          status: String(row.status),
          started_at: String(row.started_at),
          failing_node: row.failing_node ?? null,
          error_line: firstLine(error),
        };
      }),
    };
  } catch (error) {
    return { runs: [], status: `unavailable: ${reason(error)}` };
  }
}

export async function readTaskmaster(input: {
  owner: string;
  repo: string;
  number: number;
}): Promise<{ recipient: string | null; status: SourceStatus }> {
  try {
    const result = await listExpectations({ status: 'pending', limit: 100 });
    const url = `https://github.com/${input.owner}/${input.repo}/pull/${input.number}`;
    const gh = `gh:${input.owner}/${input.repo}#${input.number}`;
    const match = result.rows.find(
      row =>
        row.dispatch_ref.includes(url) ||
        row.dispatch_ref.includes(gh) ||
        row.evidence_json.includes(url) ||
        row.evidence_json.includes(gh)
    );
    return { recipient: match?.recipient ?? null, status: 'ok' };
  } catch (error) {
    return { recipient: null, status: `unavailable: ${reason(error)}` };
  }
}
