export const DISPATCH_SENDER_AUTH_MODE = 'DISPATCH_SENDER_AUTH_MODE';
export const DISPATCH_TELEGRAM_ENABLED = 'DISPATCH_TELEGRAM_ENABLED';
export const DISPATCH_SMS_ENABLED = 'DISPATCH_SMS_ENABLED';

export type DispatchNotificationChannel = 'telegram' | 'sms';

export interface DispatchNotifierConfig {
  senderAuthMode: string;
  telegramEnabled: boolean;
  smsEnabled: boolean;
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function readDispatchNotifierConfig(
  env: NodeJS.ProcessEnv = process.env
): DispatchNotifierConfig {
  return {
    senderAuthMode: env[DISPATCH_SENDER_AUTH_MODE]?.trim().toLowerCase() ?? '',
    telegramEnabled: enabled(env[DISPATCH_TELEGRAM_ENABLED]),
    smsEnabled: enabled(env[DISPATCH_SMS_ENABLED]),
  };
}

export function dispatchSenderAuthIsRequired(config: DispatchNotifierConfig): boolean {
  return config.senderAuthMode === 'required';
}

export function dispatchNotifierIsEnabled(
  channel: DispatchNotificationChannel,
  config: DispatchNotifierConfig
): boolean {
  if (!dispatchSenderAuthIsRequired(config)) return false;
  return channel === 'telegram' ? config.telegramEnabled : config.smsEnabled;
}
