import { readFile } from 'fs/promises';
import { createLogger } from '@archon/paths';
import { posix } from 'path';

const log = createLogger('dispatch/notifiers');
type EscalationLeg = 'telegram' | 'sms';

function refuseEscalation(leg: EscalationLeg, refusalReason: string): false {
  log.warn({ leg, refusalReason }, 'dispatch_escalation_refused');
  return false;
}

function escalationLegEnabled(leg: EscalationLeg): boolean {
  if (process.env.DISPATCH_SENDER_AUTH_MODE !== 'enforce') {
    return refuseEscalation(leg, 'sender_auth_not_enforced');
  }
  const flag =
    leg === 'telegram' ? process.env.DISPATCH_TELEGRAM_ENABLED : process.env.DISPATCH_SMS_ENABLED;
  if (flag !== 'true') return refuseEscalation(leg, 'leg_disabled');
  return true;
}

const DISPATCH_SECRETS_DIRECTORY = '/run/bdc-secrets';

export async function readDispatchSecretFile(path: string | undefined): Promise<string> {
  if (!path || !posix.isAbsolute(path)) throw new Error('dispatch_secret_file_required');
  const pathSegments = path.split('/');
  if (pathSegments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('dispatch_secret_file_required');
  }
  const resolvedPath = posix.normalize(path);
  if (posix.dirname(resolvedPath) !== DISPATCH_SECRETS_DIRECTORY || !posix.basename(resolvedPath)) {
    throw new Error('dispatch_secret_file_required');
  }
  const value = (await readFile(resolvedPath, 'utf8')).trim();
  if (!value) throw new Error('dispatch_secret_file_empty');
  return value;
}

export async function sendTelegramEscalation(messageId: string): Promise<boolean> {
  if (!escalationLegEnabled('telegram')) return false;
  const chatId = process.env.DISPATCH_TELEGRAM_CHAT_ID;
  if (!chatId) return refuseEscalation('telegram', 'destination_missing');
  const token = await readDispatchSecretFile(process.env.DISPATCH_TELEGRAM_TOKEN_FILE);
  if (!escalationLegEnabled('telegram')) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `Unaddressed XO blocker: ${messageId}` }),
  });
  if (!response.ok) throw new Error(`dispatch_telegram_delivery_failed:${response.status}`);
  return true;
}

export async function sendSmsEscalation(messageId: string): Promise<boolean> {
  if (!escalationLegEnabled('sms')) return false;
  const endpoint = process.env.DISPATCH_SMS_ENDPOINT;
  const recipient = process.env.DISPATCH_SMS_RECIPIENT;
  if (!endpoint || !recipient) return refuseEscalation('sms', 'destination_missing');
  const token = await readDispatchSecretFile(process.env.DISPATCH_SMS_TOKEN_FILE);
  if (!escalationLegEnabled('sms')) return false;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ to: recipient, message: `Unaddressed XO blocker: ${messageId}` }),
  });
  if (!response.ok) throw new Error(`dispatch_sms_delivery_failed:${response.status}`);
  return true;
}
