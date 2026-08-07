import { readFile } from 'fs/promises';

export async function readDispatchSecretFile(path: string | undefined): Promise<string> {
  if (!path || !path.startsWith('/run/bdc-secrets/')) throw new Error('dispatch_secret_file_required');
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error('dispatch_secret_file_empty');
  return value;
}

export async function sendTelegramEscalation(_messageId: string): Promise<void> {
  await readDispatchSecretFile(process.env.DISPATCH_TELEGRAM_TOKEN_FILE);
  throw new Error('dispatch_telegram_notifier_not_configured');
}

export async function sendSmsEscalation(_messageId: string): Promise<void> {
  await readDispatchSecretFile(process.env.DISPATCH_SMS_TOKEN_FILE);
  throw new Error('dispatch_sms_notifier_not_configured');
}
