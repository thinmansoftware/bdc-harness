import { appendOverseerCapabilityEvent } from '@archon/core/db/overseer-capabilities';
import type { M31ActionPermit } from './m31-substrate';
import { authorizeOverseerAction, readOverseerActionPolicyFromEnv } from './action-policy';

export type AuthorizedEscalationResult =
  | {
      readonly accepted: true;
      readonly reason: 'escalation_authorized';
      readonly mutation_sent: false;
    }
  | { readonly accepted: false; readonly reason: string; readonly mutation_sent: false };

export interface AuthorizedEscalationOptions {
  readonly permit: M31ActionPermit | null;
  readonly actor: string;
}

/**
 * Shared authorization boundary for watcher, workflow, and cascade escalation
 * callers. It authorizes the escalation against the persistent M31 action
 * policy and records the authorization attempt in the capability event ledger.
 *
 * This function does NOT itself perform the escalation side effect -- the caller
 * performs it (the watcher writes a real operator card once this returns
 * accepted). `mutation_sent: false` reflects that THIS boundary sends no
 * mutation; it is an authorization + audit step, not an inert one.
 * De-faked under WO-HARNESS-OVERSEER-UNBURY-GATES-01: the audit ledger no longer
 * labels the outcome with an inert/"fake" reason or adapter for a decision the
 * caller acts on for real. Accepted authorizations record reason
 * 'escalation_authorized' and adapter 'operator-card-escalation'.
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
      reason: 'escalation_authorized',
      actor: options.actor,
      correlation_id: runId,
      proposal_id: options.permit.proposal_id,
      execution_id: options.permit.execution_id,
      policy_digest: authorization.policy_digest,
      verifier_registry_digest: authorization.verifier_registry_digest,
      details: {
        adapter: 'operator-card-escalation',
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
  return { accepted: true, reason: 'escalation_authorized', mutation_sent: false };
}
