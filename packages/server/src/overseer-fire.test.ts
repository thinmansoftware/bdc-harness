import { describe, expect, mock, test } from 'bun:test';
import { createOverseerFireWorkflowRun } from './overseer-fire';

describe('overseer fire loopback', () => {
  test('refuses a live duplicate without POST', async () => {
    const request = mock(async () => new Response());
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      fetch: request as never,
      listCodebases: async () => [{ id: 'c1', name: 'bdc-harness' }] as never,
      findLiveRuns: async () => [{ id: 'live', status: 'running', workflow_name: 'lane' }],
    });
    expect(
      await fire({ workflowName: 'lane', woId: 'WO-X-01', project: 'bdc-harness', runId: 'r1' })
    ).toEqual({ ok: false, error: 'duplicate_wo_live' });
    expect(request).not.toHaveBeenCalled();
  });
  test('posts the proven body and discovers successor', async () => {
    const request = mock(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'x-archon-operator-token': 'secret' });
      expect(JSON.parse(String(init.body))).toEqual({
        codebaseId: 'c1',
        message:
          '/workflow run lane WO_ID=WO-X-01 --project bdc-harness --fired_by=overseer-refire --refire_of=r1',
      });
      return Response.json({ dispatched: true, id: 'parent', conversationId: 'web-1' });
    });
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      fetch: request as never,
      listCodebases: async () => [{ id: 'c1', name: 'bdc-harness' }] as never,
      findLiveRuns: async () => [],
      discoverRuns: async () =>
        [
          { id: 'r2', parent_conversation_id: 'parent', workflow_name: 'lane', codebase_id: 'c1' },
        ] as never,
    });
    expect(
      await fire({ workflowName: 'lane', woId: 'WO-X-01', project: 'bdc-harness', runId: 'r1' })
    ).toEqual({ ok: true, runId: 'r2', conversationId: 'web-1' });
  });
  test('refuses duplicate project shortnames without POST', async () => {
    const request = mock(async () => new Response());
    const fire = createOverseerFireWorkflowRun({
      port: 3090,
      operatorToken: 'secret',
      fetch: request as never,
      listCodebases: async () =>
        [
          { id: 'c1', name: 'bdc-harness' },
          { id: 'c2', name: 'bdc-harness' },
        ] as never,
    });
    expect(
      await fire({ workflowName: 'lane', woId: 'WO-X-01', project: 'bdc-harness', runId: 'r1' })
    ).toEqual({ ok: false, error: 'project_not_unique' });
    expect(request).not.toHaveBeenCalled();
  });
});
