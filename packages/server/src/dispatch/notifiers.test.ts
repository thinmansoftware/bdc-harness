import { describe, expect, mock, test } from 'bun:test';
import { sendSmsEscalation, sendTelegramEscalation } from './notifiers';

describe('dispatch escalation notifiers', () => {
  test('disabled channels are explicit no-ops', async () => {
    expect(await sendTelegramEscalation({}, {})).toBe(false);
    expect(await sendSmsEscalation({}, {})).toBe(false);
  });

  test('posts JSON to the configured channel', async () => {
    const fetchImpl = mock(async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    expect(await sendTelegramEscalation({ id: 'm1' }, { telegramUrl: 'https://notify.invalid', fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
