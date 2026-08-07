export interface DispatchEscalationNotifierConfig {
  telegramUrl?: string;
  smsUrl?: string;
  fetchImpl?: typeof fetch;
}

async function send(url: string | undefined, payload: Record<string, unknown>, fetchImpl = fetch): Promise<boolean> {
  if (!url) return false;
  const response = await fetchImpl(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`dispatch_escalation_delivery_failed:${response.status}`);
  return true;
}

export function sendTelegramEscalation(
  payload: Record<string, unknown>, config: DispatchEscalationNotifierConfig
): Promise<boolean> {
  return send(config.telegramUrl, payload, config.fetchImpl);
}

export function sendSmsEscalation(
  payload: Record<string, unknown>, config: DispatchEscalationNotifierConfig
): Promise<boolean> {
  return send(config.smsUrl, payload, config.fetchImpl);
}
