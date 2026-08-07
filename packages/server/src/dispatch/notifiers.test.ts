import { describe, expect, test } from 'bun:test';
import { dispatchNotifierIsEnabled, readDispatchNotifierConfig } from './notifiers';

describe('dispatch notifier fail-closed gates', () => {
  test('enables a channel only when sender auth and its feature flag are both set', () => {
    const config = readDispatchNotifierConfig({
      DISPATCH_SENDER_AUTH_MODE: 'required',
      DISPATCH_TELEGRAM_ENABLED: 'true',
      DISPATCH_SMS_ENABLED: 'true',
    });

    expect(dispatchNotifierIsEnabled('telegram', config)).toBe(true);
    expect(dispatchNotifierIsEnabled('sms', config)).toBe(true);
  });

  test('a feature flag alone is insufficient', () => {
    const config = readDispatchNotifierConfig({ DISPATCH_TELEGRAM_ENABLED: 'true' });
    expect(dispatchNotifierIsEnabled('telegram', config)).toBe(false);
  });

  test('sender auth mode alone is insufficient', () => {
    const config = readDispatchNotifierConfig({ DISPATCH_SENDER_AUTH_MODE: 'required' });
    expect(dispatchNotifierIsEnabled('telegram', config)).toBe(false);
    expect(dispatchNotifierIsEnabled('sms', config)).toBe(false);
  });
});
