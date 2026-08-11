import { describe, expect, test } from 'bun:test';
import { claimMessage } from './dispatch';
import { OperatorApiError } from './fire';

describe('dispatch tools', () => {
  test('preserves fenced claim success then conflict without retrying', async () => {
    let calls = 0;
    const fetch = async () =>
      ++calls === 1
        ? Response.json({ id: 'm-1', fencing_token: 4 })
        : Response.json({ error: 'stale fencing token' }, { status: 409 });
    const options = { baseUrl: 'http://operator', token: 'message', fetch };
    expect(await claimMessage(options, 'm-1', { worker_id: 'w-1' })).toEqual({
      id: 'm-1',
      fencing_token: 4,
    });
    try {
      await claimMessage(options, 'm-1', { worker_id: 'w-1' });
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorApiError);
      expect((error as OperatorApiError).status).toBe(409);
    }
    expect(calls).toBe(2);
  });
});
