import { describe, expect, test } from 'bun:test';
import { fireWorkflow } from './fire.js';

describe('fire_workflow', () => {
  test('passes approval data and the fire-scoped token to the API', async () => {
    let request: Request | undefined;
    await fireWorkflow(
      {
        name: 'major-build',
        conversationId: 'conversation',
        message: 'run it',
        approved_by: 'john',
        approval_reason: 'approved test',
      },
      {
        token: 'fire-token',
        fetch: async (input, init) => {
          request = new Request(input, init);
          return Response.json({ accepted: true });
        },
      }
    );
    expect(request?.url).toEndWith('/api/workflows/major-build/run');
    expect(request?.headers.get('x-archon-operator-token')).toBe('fire-token');
    expect(await request?.json()).toMatchObject({ approved_by: 'john' });
  });

  test('surfaces server-side approval rejection without retrying', async () => {
    let calls = 0;
    await expect(
      fireWorkflow(
        {
          name: 'major-build',
          conversationId: 'conversation',
          message: 'run it',
          approved_by: 'unknown',
          approval_reason: 'not approved',
        },
        {
          token: 'fire-token',
          fetch: async () => {
            calls++;
            return Response.json({ error: 'Fire approval is missing or invalid' }, { status: 403 });
          },
        }
      )
    ).rejects.toThrow('403');
    expect(calls).toBe(1);
  });
});
