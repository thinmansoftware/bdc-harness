import { describe, expect, test } from 'bun:test';
import { getNodeEvents, getRun, listDashboardRuns } from './inspect.js';

describe('inspect tools', () => {
  test('returns the API run JSON unchanged', async () => {
    const run = { id: 'run-1', status: 'completed', workflow_name: 'major-build' };
    const result = await getRun(
      { runId: 'run-1' },
      { token: 'inspect-token', fetch: async () => Response.json(run) }
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual(run);
  });

  test('requests node events with encoded path parameters', async () => {
    let requestedUrl = '';
    await getNodeEvents(
      { runId: 'run/1', nodeId: 'build step' },
      {
        token: 'inspect-token',
        fetch: async input => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return Response.json([]);
        },
      }
    );
    expect(new URL(requestedUrl).pathname).toBe(
      '/api/workflows/runs/run%2F1/nodes/build%20step/events'
    );
  });

  test('passes dashboard run filters as query parameters', async () => {
    let requestedUrl = '';
    await listDashboardRuns(
      { status: 'running', limit: 25, offset: 50 },
      {
        token: 'inspect-token',
        fetch: async input => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return Response.json([]);
        },
      }
    );
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/api/dashboard/runs');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'running',
      limit: '25',
      offset: '50',
    });
  });
});
