/**
 * Taskmaster Slice 1 -- outbound effect guard (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * Two code-level gates on every proposed effect (never a prompt instruction):
 *   1. Effect allowlist -- Slice 1 authorizes EXACTLY three verbs. Anything else
 *      (a smuggled excluded capability) is rejected and journalled, never sent.
 *   2. Content guard -- reuses the ratified M-10.2 content assessment from core
 *      (assessDispatchMessageBody): outbound bodies must not carry repo-mutating
 *      INSTRUCTIONS. We reuse the proven guard rather than re-porting a second copy.
 */
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import type { TaskmasterProposal } from './rules';

/** The only effect verbs authorized in Slice 1 (M-133). */
export const ALLOWED_EFFECTS: ReadonlySet<string> = new Set([
  'deliver_ruling',
  'nudge',
  'escalate',
]);

export interface GuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate a proposal before actuation. Rejection is terminal for this proposal:
 * the caller journals the rejection and makes NO send.
 */
export function validate(proposal: TaskmasterProposal): GuardResult {
  if (!ALLOWED_EFFECTS.has(proposal.actionType)) {
    return { allowed: false, reason: `forbidden_effect:${proposal.actionType}` };
  }

  // Taskmaster sends ride the dispatch bus as agent_message; the content guard is
  // applied against that task type so a body cannot smuggle a mutation instruction.
  const content = assessDispatchMessageBody('agent_message', proposal.body);
  if (!content.allowed) {
    return { allowed: false, reason: content.reason ?? 'content_guard_rejected' };
  }

  return { allowed: true };
}
