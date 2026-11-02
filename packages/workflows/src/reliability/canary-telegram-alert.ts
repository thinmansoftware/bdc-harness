export const JOHN_TELEGRAM_CHAT_ID = '8631463074';

export type TelegramSender = (message: {
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
}) => Promise<void>;

export async function defaultTelegramSender(message: {
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
}): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${message.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: message.chatId, text: message.text }),
  });
  if (!response.ok) throw new Error(`telegram_send_failed:${response.status}`);
}

export function renderCanaryProbeRed(input: {
  readonly workflowName: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly errorClass: string;
}): string {
  return [
    `[CANARY PROBE RED] ${input.workflowName}`,
    `${input.providerId} ${input.modelId}`,
    input.errorClass,
  ].join('\n');
}

export function renderCanaryProbeWarn(input: {
  readonly workflowName: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly errorClass: string;
}): string {
  return [
    `[CANARY PROBE WARN] ${input.workflowName}`,
    `${input.providerId} ${input.modelId}`,
    input.errorClass,
  ].join('\n');
}

export function renderLayer2Red(input: { readonly lane: string; readonly reason: string }): string {
  return [`[L2 RED] ${input.lane}`, input.reason].join('\n');
}

export async function sendCanaryTelegramAlert(
  text: string,
  options: { readonly sender?: TelegramSender; readonly token?: string } = {}
): Promise<void> {
  const token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_required');
  const sender = options.sender ?? defaultTelegramSender;
  await sender({ token, chatId: JOHN_TELEGRAM_CHAT_ID, text });
}
