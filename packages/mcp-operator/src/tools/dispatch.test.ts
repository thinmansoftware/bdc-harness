import { describe, expect, test } from 'bun:test';
import {
  ackMessage,
  addressMessage,
  cancelMessage,
  claimMessage,
  postResult,
  sendMessage,
} from './dispatch';
import { OperatorApiError } from './fire';

describe('dispatch tools', () => {
  test('constructs the send-claim-result-ack-address chain and cancellation request', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ ok: true });
    };
    const options = { baseUrl: 'http://operator', token: 'message', fetch };

    await sendMessage(options, { sender: 'operator', body: 'investigate' });
    await claimMessage(options, 'message/1', { worker_id: 'worker-1' });
    await postResult(options, 'message/1', { fencing_token: 7, result: 'done' });
    await ackMessage(options, 'message/1', { principal: 'operator' });
    await addressMessage(options, 'message/1', { principal: 'operator' });
    await cancelMessage(options, 'message/1', { sender: 'operator' });

    expect(requests).toEqual([
      {
        url: 'http://operator/api/dispatch/messages',
        method: 'POST',
        body: { sender: 'operator', body: 'investigate' },
      },
      {
        url: 'http://operator/api/dispatch/messages/message%2F1/claim',
        method: 'POST',
        body: { worker_id: 'worker-1' },
      },
      {
        url: 'http://operator/api/dispatch/messages/message%2F1/result',
        method: 'POST',
        body: { fencing_token: 7, result: 'done' },
      },
      {
        url: 'http://operator/api/dispatch/messages/message%2F1/ack',
        method: 'POST',
        body: { principal: 'operator' },
      },
      {
        url: 'http://operator/api/dispatch/messages/message%2F1/address',
        method: 'POST',
        body: { principal: 'operator' },
      },
      {
        url: 'http://operator/api/dispatch/messages/message%2F1/cancel',
        method: 'POST',
        body: { sender: 'operator' },
      },
    ]);
  });

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
