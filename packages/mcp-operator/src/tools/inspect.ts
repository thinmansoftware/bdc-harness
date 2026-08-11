import { z } from 'zod';
import {
  operatorRequest,
  toolResult,
  type OperatorClientOptions,
  type ToolResult,
} from '../client.js';

export const getRunInput = { runId: z.string().min(1) };
export const getNodeEventsInput = { runId: z.string().min(1), nodeId: z.string().min(1) };
export const listDashboardRunsInput = {
  status: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
};

export async function getRun(
  { runId }: { runId: string },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return toolResult(
    await operatorRequest(
      'inspect',
      `/api/workflows/runs/${encodeURIComponent(runId)}`,
      {},
      options
    )
  );
}

export async function getNodeEvents(
  { runId, nodeId }: { runId: string; nodeId: string },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  return toolResult(
    await operatorRequest(
      'inspect',
      `/api/workflows/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/events`,
      {},
      options
    )
  );
}

export async function listDashboardRuns(
  input: { status?: string; limit?: number; offset?: number },
  options?: OperatorClientOptions
): Promise<ToolResult> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) query.set(key, String(value));
  const suffix = query.size ? `?${query}` : '';
  return toolResult(await operatorRequest('inspect', `/api/dashboard/runs${suffix}`, {}, options));
}
