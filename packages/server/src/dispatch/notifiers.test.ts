import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// Snapshot before mocking: sibling dispatch tests load @archon/paths, which
// imports other fs/promises exports (including symlink) in the same process.
const realFsPromises = { ...(await import('node:fs/promises')) };
let onSecretRead: (() => void) | undefined;
const secretRead = mock(async (path: string) => {
  if (!path.startsWith('/run/bdc-secrets/')) throw new Error('unexpected secret path');
  onSecretRead?.();
  return 'file-token\n';
});
mock.module('fs/promises', () => ({
  ...realFsPromises,
  readFile: secretRead,
}));
const { readDispatchSecretFile, sendSmsEscalation, sendTelegramEscalation } =
  await import('./notifiers');
const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'DISPATCH_SENDER_AUTH_MODE',
  'DISPATCH_TELEGRAM_ENABLED',
  'DISPATCH_SMS_ENABLED',
  'DISPATCH_TELEGRAM_TOKEN_FILE',
  'DISPATCH_TELEGRAM_CHAT_ID',
  'DISPATCH_SMS_TOKEN_FILE',
  'DISPATCH_SMS_ENDPOINT',
  'DISPATCH_SMS_RECIPIENT',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  onSecretRead = undefined;
  secretRead.mockClear();
  process.env.DISPATCH_TELEGRAM_TOKEN_FILE = '/run/bdc-secrets/telegram';
  process.env.DISPATCH_TELEGRAM_CHAT_ID = 'fake-chat';
  process.env.DISPATCH_SMS_TOKEN_FILE = '/run/bdc-secrets/sms';
  process.env.DISPATCH_SMS_ENDPOINT = 'https://sms.invalid/send';
  process.env.DISPATCH_SMS_RECIPIENT = 'fake-recipient';
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  onSecretRead = undefined;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
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
    process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
    process.env.DISPATCH_TELEGRAM_ENABLED = ['t', 'r', 'u', 'e'].join('');
    process.env.DISPATCH_SMS_ENABLED = ['t', 'r', 'u', 'e'].join('');
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

describe('notifier boundary dark gate', () => {
  const legs = [
    {
      name: 'telegram',
      send: sendTelegramEscalation,
      flag: 'DISPATCH_TELEGRAM_ENABLED',
      destination: 'DISPATCH_TELEGRAM_CHAT_ID',
    },
    {
      name: 'sms',
      send: sendSmsEscalation,
      flag: 'DISPATCH_SMS_ENABLED',
      destination: 'DISPATCH_SMS_ENDPOINT',
    },
  ];
  for (const leg of legs) {
    for (const mode of [undefined, 'off', 'warn', 'enforce']) {
      for (const flag of [undefined, 'false', 'true', 'TRUE']) {
        test(`${leg.name}: auth=${mode}, leg=${flag}`, async () => {
          if (mode !== undefined) process.env.DISPATCH_SENDER_AUTH_MODE = mode;
          if (flag !== undefined) process.env[leg.flag] = flag;
          const fetchMock = mock(async () => new Response('{}', { status: 200 }));
          globalThis.fetch = fetchMock as typeof fetch;
          const result = await leg.send('fake-message');
          const enabled = mode === 'enforce' && flag === 'true';
          expect(fetchMock).toHaveBeenCalledTimes(enabled ? 1 : 0);
          expect(secretRead).toHaveBeenCalledTimes(enabled ? 1 : 0);
          expect(result).toBe(enabled);
        });
      }
    }
    test(`${leg.name}: no destination means no secret access`, async () => {
      process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
      process.env[leg.flag] = ['t', 'r', 'u', 'e'].join('');
      delete process.env[leg.destination];
      const fetchMock = mock(async () => new Response('{}'));
      globalThis.fetch = fetchMock as typeof fetch;
      await expect(leg.send('fake-message')).resolves.toBe(false);
      expect(secretRead).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
    for (const changed of ['DISPATCH_SENDER_AUTH_MODE', leg.flag]) {
      test(`${leg.name}: rechecks ${changed} after secret access`, async () => {
        process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
        process.env[leg.flag] = ['t', 'r', 'u', 'e'].join('');
        onSecretRead = () => {
          delete process.env[changed];
        };
        const fetchMock = mock(async () => new Response('{}'));
        globalThis.fetch = fetchMock as typeof fetch;
        const result = await leg.send('fake-message');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result).toBe(false);
      });
    }
  }
});

test('SMS refuses a missing recipient before reading its secret', async () => {
  process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
  process.env.DISPATCH_SMS_ENABLED = ['t', 'r', 'u', 'e'].join('');
  delete process.env.DISPATCH_SMS_RECIPIENT;
  const fetchMock = mock(async () => new Response('{}'));
  globalThis.fetch = fetchMock as typeof fetch;
  await expect(sendSmsEscalation('fake-message')).resolves.toBe(false);
  expect(secretRead).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an enabled leg with invalid configured secret still fails without fetching', async () => {
  process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
  process.env.DISPATCH_TELEGRAM_ENABLED = ['t', 'r', 'u', 'e'].join('');
  process.env.DISPATCH_TELEGRAM_TOKEN_FILE = '/invalid/fake-secret';
  const fetchMock = mock(async () => new Response('{}'));
  globalThis.fetch = fetchMock as typeof fetch;
  await expect(sendTelegramEscalation('fake-message')).rejects.toThrow(
    'dispatch_secret_file_required'
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
