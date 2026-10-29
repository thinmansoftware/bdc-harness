/**
 * Loud alert for a GitHub credential that cannot mint or refresh itself
 * (WO-HARNESS-GITHUB-TOKEN-PROVIDER-REFRESH-01). Instead of a per-tick error
 * line, a credential that fails refresh raises exactly ONE Dispatch message to
 * the operator with subject_key `credential:<name>`, deduped per credential per
 * 6 hours (in-memory). The Dispatch send is injectable so tests can assert the
 * sink is called exactly once without touching the database.
 */
import {
  createAuthenticatedMessage,
  type CreateAuthenticatedMessageData,
  type DispatchSenderContext,
} from '../db/dispatch';
import { createLogger } from '@archon/paths';

const log = createLogger('github/credential-alert');

/** One alert per credential per this window. */
export const CREDENTIAL_ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000;

const CREDENTIAL_ALERT_SENDER: DispatchSenderContext = { kind: 'system', sender: 'dispatch' };

const lastAlertAt = new Map<string, number>();

export interface CredentialAlertDeps {
  /** Injected for tests; defaults to the real Dispatch createAuthenticatedMessage. */
  send?: (context: DispatchSenderContext, data: CreateAuthenticatedMessageData) => Promise<unknown>;
  now?: () => number;
}

/** Clear the in-memory dedupe state (tests only). */
export function resetCredentialAlertDedupe(): void {
  lastAlertAt.clear();
}

/**
 * Queue one operator Dispatch message naming an unrefreshable credential.
 * Returns true when a message was queued, false when suppressed by the 6h
 * dedupe window. A failed send is logged (not thrown) and does NOT consume the
 * dedupe slot, so the next tick can retry.
 */
export async function alertCredentialFailure(
  credentialName: string,
  deps: CredentialAlertDeps = {}
): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const last = lastAlertAt.get(credentialName);
  if (last !== undefined && now - last < CREDENTIAL_ALERT_DEDUPE_MS) return false;
  lastAlertAt.set(credentialName, now);

  const send =
    deps.send ??
    ((context: DispatchSenderContext, data: CreateAuthenticatedMessageData): Promise<unknown> =>
      createAuthenticatedMessage(context, data));
  try {
    await send(CREDENTIAL_ALERT_SENDER, {
      correlation_id: `credential-alert:${credentialName}`,
      idempotency_key: `credential-alert:${credentialName}:${Math.floor(now / CREDENTIAL_ALERT_DEDUPE_MS)}`,
      task_type: 'agent_message',
      recipient: 'operator',
      priority: 'blocker',
      subject_key: `credential:${credentialName}`,
      body: JSON.stringify({
        kind: 'credential_refresh_failure',
        credential: credentialName,
        detail: `GitHub credential ${credentialName} could not mint or refresh a token and needs manual rotation.`,
      }),
    });
    return true;
  } catch (error) {
    // Do not hold the dedupe slot on a failed send: let the next tick retry.
    lastAlertAt.delete(credentialName);
    log.error({ err: error as Error, credential: credentialName }, 'credential.alert_failed');
    return false;
  }
}
