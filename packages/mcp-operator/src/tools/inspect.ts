import { operatorRequest, type OperatorRequestOptions } from './fire';

export function getRun(options: OperatorRequestOptions, runId: string): Promise<unknown> {
  return operatorRequest(options, `/api/workflows/runs/${encodeURIComponent(runId)}`, 'GET');
}

export function getNodeEvents(
  options: OperatorRequestOptions,
  input: { runId: string; nodeId: string; limit?: number }
): Promise<unknown> {
  const query = input.limit === undefined ? '' : `?limit=${encodeURIComponent(input.limit)}`;
  return operatorRequest(
    options,
    `/api/workflows/runs/${encodeURIComponent(input.runId)}/nodes/${encodeURIComponent(input.nodeId)}/events${query}`,
    'GET'
  );
}

export function listDashboardRuns(
  options: OperatorRequestOptions,
  query?: Record<string, string>
): Promise<unknown> {
  const params = new URLSearchParams(query);
  const suffix = params.size === 0 ? '' : `?${params.toString()}`;
  return operatorRequest(options, `/api/dashboard/runs${suffix}`, 'GET');
}
