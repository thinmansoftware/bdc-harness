export interface CanaryTelegramAlertInput {
  readonly level: 'red' | 'warn' | 'l2-red';
  readonly workflowName: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly bindingKey?: string;
  readonly errorClass: string;
  readonly errorBodyExcerpt: string;
  readonly fetcher?: typeof fetch;
}

export async function sendCanaryTelegramAlert(input: CanaryTelegramAlertInput): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CANARY_TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CANARY_CHAT_ID;
  if (!token || !chatId) return false;

  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: renderCanaryAlert(input),
      disable_web_page_preview: true,
    }),
  });
  return response.ok;
}

export function renderCanaryAlert(input: CanaryTelegramAlertInput): string {
  const prefix =
    input.level === 'red'
      ? '[CANARY PROBE RED]'
      : input.level === 'warn'
        ? '[CANARY PROBE WARN]'
        : '[CANARY L2 RED]';
  const binding = input.bindingKey ? `\nBinding: ${input.bindingKey}` : '';
  const provider =
    input.providerId || input.modelId
      ? `\nProvider/model: ${input.providerId ?? '-'} / ${input.modelId ?? '-'}`
      : '';
  return `${prefix} ${input.workflowName}\nClass: ${input.errorClass}${provider}${binding}\n${input.errorBodyExcerpt}`;
}
