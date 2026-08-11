import { describe, expect, test } from 'bun:test';
import {
  ackMessage,
  addressMessage,
  cancelMessage,
  claimMessage,
  postResult,
  sendMessage,
} from './dispatch.js';

describe('dispatch tools', () => {
  test('preserves the send-claim-result-ack-address-cancel REST sequence', async () => {
    const paths: string[] = [];
    const options = {
      token: 'message-token',
      fetch: async (input: string | URL | Request) => {
        paths.push(new URL(input instanceof Request ? input.url : input).pathname);
        return Response.json({ ok: true });
      },
    };
    await sendMessage({ body: { recipient: 'worker' } }, options);
    await claimMessage({ id: 'm1', body: { worker_id: 'w1' } }, options);
    await postResult({ id: 'm1', body: { fencing_token: 1 } }, options);
    await ackMessage({ id: 'm1', body: { principal_id: 'p1' } }, options);
    await addressMessage({ id: 'm1', body: { principal_id: 'p1' } }, options);
    await cancelMessage({ id: 'm1', body: { principal_id: 'p1' } }, options);
    expect(paths).toEqual([
      '/api/dispatch/messages',
      '/api/dispatch/messages/m1/claim',
      '/api/dispatch/messages/m1/result',
      '/api/dispatch/messages/m1/ack',
      '/api/dispatch/messages/m1/address',
      '/api/dispatch/messages/m1/cancel',
    ]);
  });

  test('passes fencing conflicts through', async () => {
    await expect(
      claimMessage(
        { id: 'm1', body: { worker_id: 'w1' } },
        {
          token: 'message-token',
          fetch: async () => Response.json({ error: 'stale' }, { status: 409 }),
        }
      )
    ).rejects.toThrow('409');
  });
});
