import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('fs/promises', () => ({
  readFile: mock(async (path: string) => {
    if (!path.startsWith('/run/bdc-secrets/')) throw new Error('unexpected secret path');
    return 'file-token\n';
  }),
}));
const { readDispatchSecretFile, sendSmsEscalation, sendTelegramEscalation } =
  await import('./notifiers');
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('dispatch notifiers', () => {
  test('rejects secrets outside the mounted secret directory', async () => {
    expect(readDispatchSecretFile('/tmp/token')).rejects.toThrow('dispatch_secret_file_required');
  });

  test('reads file credentials and sends both configured legs', async () => {
    process.env.DISPATCH_TELEGRAM_TOKEN_FILE = '/run/bdc-secrets/telegram';
    process.env.DISPATCH_TELEGRAM_CHAT_ID = '123';
    process.env.DISPATCH_SMS_TOKEN_FILE = '/run/bdc-secrets/sms';
    process.env.DISPATCH_SMS_ENDPOINT = 'https://sms.invalid/send';
    process.env.DISPATCH_SMS_RECIPIENT = '+15555550100';
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await sendTelegramEscalation('m1');
    await sendSmsEscalation('m1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fetchMock.mock.calls)).toContain('file-token');
  });
});
