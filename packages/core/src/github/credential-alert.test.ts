import { afterEach, describe, expect, it, mock } from 'bun:test';
import { alertCredentialFailure, resetCredentialAlertsForTests } from './credential-alert';

afterEach(resetCredentialAlertsForTests);

describe('Test 6: credential alert dedupe', () => {
  it('queues one operator message per credential in six hours', async () => {
    const send = mock(async () => ({}) as never);
    for (let index = 0; index < 10; index += 1) {
      await alertCredentialFailure('app-1-2', new Error('mint failed'), {
        now: () => 1_000,
        send: send as never,
      });
    }
    expect(send).toHaveBeenCalledTimes(1);
    const data = send.mock.calls[0]?.[1] as { recipient: string; subject_key: string };
    expect(data.recipient).toBe('operator');
    expect(data.subject_key).toBe('credential:app-1-2');
  });
});
