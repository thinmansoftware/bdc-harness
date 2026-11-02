import { appendOverseerCapabilityEvent } from '@archon/core/db/overseer-capabilities';
import type { M31ActionPermit } from './m31-substrate';
import { authorizeOverseerAction, readOverseerActionPolicyFromEnv } from './action-policy';

export type AuthorizedEscalationResult =
  | {
      readonly accepted: true;
      readonly reason: 'notification_only_no_mutation';
      readonly mutation_sent: false;
    }
  | { readonly accepted: false; readonly reason: string; readonly mutation_sent: false };

export interface AuthorizedEscalationOptions {
  readonly permit: M31ActionPermit | null;
  readonly actor: string;
}

/**
 * Shared authorization boundary for watcher, workflow, and cascade callers.
 * It records the authorized notification attempt; the caller remains responsible
 * for sending the operator notification after this check succeeds.
 */
export async function runAuthorizedEscalation(
  runId: string,
  options: AuthorizedEscalationOptions
): Promise<AuthorizedEscalationResult> {
  if (!options.permit) {
    return { accepted: false, reason: 'permit_missing', mutation_sent: false };
  }

  const authorization = await authorizeOverseerAction(
    {
      requested_capability: 'escalation',
      permit: options.permit,
      actor: options.actor,
      correlation_id: runId,
    },
    {
      getPolicy: async (): Promise<ReturnType<typeof readOverseerActionPolicyFromEnv>> =>
        readOverseerActionPolicyFromEnv(),
    }
  );
  if (!authorization.allowed) {
    return { accepted: false, reason: authorization.reason, mutation_sent: false };
  }

  try {
    await appendOverseerCapabilityEvent({
      capability: 'escalation',
      event_type: 'adapter_attempt',
      reason: 'notification_only_no_mutation',
      actor: options.actor,
      correlation_id: runId,
      proposal_id: options.permit.proposal_id,
      execution_id: options.permit.execution_id,
      policy_digest: authorization.policy_digest,
      verifier_registry_digest: authorization.verifier_registry_digest,
      details: {
        adapter: 'escalation-notify-only',
        accepted: true,
        mutation_sent: false,
        permit_id: options.permit.permit_id,
        repository: options.permit.repository,
        action_kind: options.permit.action_kind,
      },
    });
  } catch {
    return { accepted: false, reason: 'attempt_audit_failed', mutation_sent: false };
  }
  return { accepted: true, reason: 'notification_only_no_mutation', mutation_sent: false };
}
