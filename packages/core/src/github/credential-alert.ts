import { createAuthenticatedMessage } from '../db/dispatch';

const ALERT_DEDUPE_MS = 6 * 60 * 60_000;
const lastAlerts = new Map<string, number>();

export async function alertCredentialFailure(
  credentialName: string,
  error: Error,
  options: { now?: () => number; send?: typeof createAuthenticatedMessage } = {}
): Promise<void> {
  const now = (options.now ?? Date.now)();
  const previous = lastAlerts.get(credentialName);
  if (previous !== undefined && now - previous < ALERT_DEDUPE_MS) return;
  lastAlerts.set(credentialName, now);
  try {
    await (options.send ?? createAuthenticatedMessage)(
      { kind: 'system', sender: 'dispatch' },
      {
        correlation_id: `credential:${credentialName}`,
        idempotency_key: `credential:${credentialName}:${Math.floor(now / ALERT_DEDUPE_MS)}`,
        task_type: 'agent_message',
        recipient: 'operator',
        priority: 'blocker',
        subject_key: `credential:${credentialName}`,
        body: JSON.stringify({
          kind: 'credential_refresh_failure',
          credential: credentialName,
          error: error.message,
        }),
      }
    );
  } catch {
    // Alert delivery must never replace the credential failure being reported.
  }
}

export function resetCredentialAlertsForTests(): void {
  lastAlerts.clear();
}
