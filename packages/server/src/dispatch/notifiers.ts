import { readFile } from 'fs/promises';

export async function readDispatchSecretFile(path: string | undefined): Promise<string> {
  if (!path || !path.startsWith('/run/bdc-secrets/'))
    throw new Error('dispatch_secret_file_required');
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error('dispatch_secret_file_empty');
  return value;
}

export async function sendTelegramEscalation(messageId: string): Promise<void> {
  const token = await readDispatchSecretFile(process.env.DISPATCH_TELEGRAM_TOKEN_FILE);
  const chatId = process.env.DISPATCH_TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error('dispatch_telegram_chat_id_required');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `Unaddressed XO blocker: ${messageId}` }),
  });
  if (!response.ok) throw new Error(`dispatch_telegram_delivery_failed:${response.status}`);
}

export async function sendSmsEscalation(messageId: string): Promise<void> {
  const token = await readDispatchSecretFile(process.env.DISPATCH_SMS_TOKEN_FILE);
  const endpoint = process.env.DISPATCH_SMS_ENDPOINT;
  const recipient = process.env.DISPATCH_SMS_RECIPIENT;
  if (!endpoint || !recipient) throw new Error('dispatch_sms_configuration_required');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: recipient, message: `Unaddressed XO blocker: ${messageId}` }),
  });
  if (!response.ok) throw new Error(`dispatch_sms_delivery_failed:${response.status}`);
}
