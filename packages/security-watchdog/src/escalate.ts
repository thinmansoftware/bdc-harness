import { redactObject } from './report';
import type { Finding, ScanReport } from './types';

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

function renderCriticalMessage(runId: string, findings: readonly Finding[]): string {
  const redacted = redactObject(findings);
  return [
    `Security Watchdog CRITICAL: ${runId}`,
    ...redacted.map(finding => `${finding.module} ${finding.target} ${finding.reason_code}`),
  ].join('\n');
}

export async function escalateCriticalFindings(
  report: ScanReport,
  options: { readonly sender?: TelegramSender; readonly token?: string } = {}
): Promise<number> {
  const criticals = report.findings.filter(finding => finding.severity === 'CRITICAL');
  if (criticals.length === 0) return 0;
  const token = options.token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_required');
  const sender = options.sender ?? defaultTelegramSender;
  await sender({
    token,
    chatId: JOHN_TELEGRAM_CHAT_ID,
    text: renderCriticalMessage(report.runId, criticals),
  });
  return criticals.length;
}
