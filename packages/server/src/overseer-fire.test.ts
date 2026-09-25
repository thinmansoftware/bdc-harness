import { describe, expect, test } from 'bun:test';
import { createOverseerFireWorkflowRun } from './overseer-fire';

describe('overseer loopback fire', () => {
  test('refuses an ambiguous project shortname', async () => {
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      deps: {
        findCodebasesByName: async () => [{ id: 'a' } as never, { id: 'b' } as never],
      },
    });
    expect(
      await fire({
        workflowName: 'lane',
        woId: 'WO-X',
        project: 'bdc-harness',
        predecessorRunId: 'r1',
      })
    ).toEqual({ ok: false, error: 'project_resolution_failed' });
  });
  test('guards live WOs without posting', async () => {
    let posted = false;
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      deps: {
        findCodebasesByName: async () => [{ id: 'cb' } as never],
        findLiveRunsForWo: async () => [{ id: 'live', status: 'running', workflow_name: 'lane' }],
        fetch: async () => {
          posted = true;
          return new Response();
        },
      },
    });
    expect(
      await fire({
        workflowName: 'lane',
        woId: 'WO-X',
        project: 'bdc-harness',
        predecessorRunId: 'r1',
      })
    ).toEqual({ ok: false, error: 'duplicate_wo_live' });
    expect(posted).toBe(false);
  });
  test('posts the proven message and correlates the successor', async () => {
    let request: RequestInit | undefined;
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      discoverTimeoutMs: 10,
      deps: {
        findCodebasesByName: async () => [{ id: 'cb' } as never],
        findLiveRunsForWo: async () => [],
        fetch: async (_url, init) => {
          request = init;
          return Response.json({ dispatched: true, id: 'parent', conversationId: 'worker' });
        },
        discoverRuns: async () => [
          {
            id: 'r2',
            workflow_name: 'lane',
            parent_conversation_id: 'parent',
            codebase_id: 'cb',
            user_message: '--refire_of=r1',
          },
        ],
      },
    });
    expect(
      await fire({
        workflowName: 'lane',
        woId: 'WO-X',
        project: 'bdc-harness',
        predecessorRunId: 'r1',
      })
    ).toEqual({ ok: true, runId: 'r2', conversationId: 'worker' });
    expect(request?.headers).toEqual(
      expect.objectContaining({ 'x-archon-operator-token': 'secret' })
    );
    expect(request?.body).toContain(
      '/workflow run lane WO_ID=WO-X --project bdc-harness --fired_by=overseer-refire --refire_of=r1'
    );
    expect(request?.body).not.toContain('--expected-spec');
  });

  test('reports indeterminate after dispatch is confirmed but successor discovery times out', async () => {
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      discoverTimeoutMs: 0,
      deps: {
        findCodebasesByName: async () => [{ id: 'cb' } as never],
        findLiveRunsForWo: async () => [],
        fetch: async () =>
          Response.json({ dispatched: true, id: 'parent', conversationId: 'worker' }),
        discoverRuns: async () => [],
      },
    });
    expect(
      await fire({
        workflowName: 'lane',
        woId: 'WO-X',
        project: 'bdc-harness',
        predecessorRunId: 'r1',
      })
    ).toEqual({
      ok: false,
      indeterminate: true,
      error: 'successor_discovery_timeout',
      conversationId: 'worker',
    });
  });
});
