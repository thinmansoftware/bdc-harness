import { describe, expect, test } from 'bun:test';
import { fireWorkflow, OperatorApiError } from './fire';

describe('fireWorkflow', () => {
  test('sends the fire token and approval fields', async () => {
    let request: Request | undefined;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json({ run_id: 'run-1' });
    };
    const result = await fireWorkflow(
      { baseUrl: 'http://operator', token: 'fire-token', fetch },
      {
        name: 'major-build',
        conversationId: 'c-1',
        message: 'build',
        approved_by: 'john',
        approval_reason: 'approved for WO',
      }
    );
    expect(request?.headers.get('x-archon-operator-token')).toBe('fire-token');
    expect(await request?.json()).toEqual({
      conversationId: 'c-1',
      message: 'build',
      approved_by: 'john',
      approval_reason: 'approved for WO',
    });
    expect(result).toEqual({ run_id: 'run-1' });
  });

  test('surfaces API rejection', async () => {
    const fetch = async () => Response.json({ error: 'approval denied' }, { status: 403 });
    await expect(
      fireWorkflow(
        { baseUrl: 'http://operator', token: 'fire-token', fetch },
        { name: 'x', conversationId: 'c', message: 'm', approved_by: 'x', approval_reason: 'x' }
      )
    ).rejects.toBeInstanceOf(OperatorApiError);
  });
});
