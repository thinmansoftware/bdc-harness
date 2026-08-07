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
  test('reads a POSIX mounted-secret path independently of the host path semantics', async () => {
    await expect(readDispatchSecretFile('/run/bdc-secrets/telegram')).resolves.toBe('file-token');
  });

  test.each([
    undefined,
    '',
    'run/bdc-secrets/telegram',
    '/tmp/token',
    '/run/bdc-secrets',
    '/run/bdc-secrets/',
    '/run/bdc-secrets/nested/telegram',
    '/run/bdc-secrets-other/telegram',
    '/run/bdc-secrets/../../etc/passwd',
    '/run/bdc-secrets/../bdc-secrets/telegram',
    '/run/bdc-secrets/./telegram',
  ])('rejects an invalid mounted-secret path: %p', async path => {
    await expect(readDispatchSecretFile(path)).rejects.toThrow('dispatch_secret_file_required');
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
