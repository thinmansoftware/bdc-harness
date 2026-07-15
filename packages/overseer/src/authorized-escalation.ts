import type { M31ActionPermit } from './m31-substrate';
import {
  authorizeOverseerAction,
  readOverseerActionPolicyFromEnv,
  type AuthorizeOverseerActionDeps,
} from './action-policy';
import { runEscalation, type EscalationContext } from './escalate';
import type { DecisionResult } from './decide';

export type AuthorizedEscalationResult =
  | { readonly executed: true; readonly reason: 'allowed' }
  | { readonly executed: false; readonly reason: string };

export interface AuthorizedEscalationOptions {
  readonly permit: M31ActionPermit | null;
  readonly actor: string;
  readonly authorizationDeps?: AuthorizeOverseerActionDeps;
  readonly perform?: typeof runEscalation;
}

/** Shared fail-closed boundary for watcher, workflow, and cascade escalation callers. */
export async function runAuthorizedEscalation(
  runId: string,
  decision: DecisionResult,
  context: EscalationContext,
  options: AuthorizedEscalationOptions
): Promise<AuthorizedEscalationResult> {
  if (!options.permit) return { executed: false, reason: 'permit_missing' };

  const authorization = await authorizeOverseerAction(
    {
      requested_capability: 'escalation',
      permit: options.permit,
      actor: options.actor,
      correlation_id: runId,
    },
    options.authorizationDeps ?? {
      getPolicy: async (): Promise<ReturnType<typeof readOverseerActionPolicyFromEnv>> =>
        readOverseerActionPolicyFromEnv(),
    }
  );
  if (!authorization.allowed) {
    return { executed: false, reason: authorization.reason };
  }

  await (options.perform ?? runEscalation)(runId, decision, context);
  return { executed: true, reason: 'allowed' };
}
