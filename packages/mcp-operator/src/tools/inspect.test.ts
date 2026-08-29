import { describe, expect, test } from 'bun:test';
import { getNodeEvents, getRun, listDashboardRuns } from './inspect';

describe('inspect tools', () => {
  test('map inputs to inspect REST routes and return JSON unchanged', async () => {
    const urls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ status: 'running', workflow_name: 'major-build' });
    };
    const options = { baseUrl: 'http://operator', token: 'inspect', fetch };
    expect(await getRun(options, 'run/1')).toEqual({
      status: 'running',
      workflow_name: 'major-build',
    });
    await getNodeEvents(options, { runId: 'run/1', nodeId: 'plan one', limit: 5 });
    await listDashboardRuns(options, { status: 'running' });
    expect(urls).toEqual([
      'http://operator/api/workflows/runs/run%2F1',
      'http://operator/api/workflows/runs/run%2F1/nodes/plan%20one/events?limit=5',
      'http://operator/api/dashboard/runs?status=running',
    ]);
  });
});
