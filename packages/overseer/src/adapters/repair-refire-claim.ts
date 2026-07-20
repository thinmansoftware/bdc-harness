import {
  acquireRecoveryExecutionClaim,
  completeRecoveryExecutionClaim,
  releaseRecoveryExecutionClaim,
  validateRecoveryExecutionFence,
} from '@archon/core/db/recovery-execution-claims';
import type { RepairRefireClaimDeps } from '../actions/repair-refire.ts';

export function createRepairRefireClaimAdapter(): RepairRefireClaimDeps {
  return {
    async acquireExecutionClaim(input) {
      const acquired = await acquireRecoveryExecutionClaim(input);
      if (!acquired.ok) {
        return {
          ok: false,
          code: acquired.code,
          message: acquired.message,
          holder: acquired.holder,
        };
      }
      return {
        ok: true,
        claim: {
          claim_id: acquired.claim.claim_id,
          actor_id: acquired.claim.actor_id,
          actor_kind: acquired.claim.actor_kind,
          execution_fencing_token: acquired.claim.execution_fencing_token,
        },
      };
    },
    async validateExecutionFence(input) {
      const validated = await validateRecoveryExecutionFence(input);
      if (!validated.ok) {
        return {
          ok: false,
          code: validated.code,
          message: validated.message,
        };
      }
      return {
        ok: true,
        fence: {
          claim_id: validated.claim_id,
          effect_attempt_id: validated.effect_attempt_id,
          execution_fencing_token: validated.execution_fencing_token,
        },
      };
    },
    async completeExecutionClaim(input) {
      const completed = await completeRecoveryExecutionClaim(input);
      return completed.ok
        ? { ok: true }
        : { ok: false, message: completed.message };
    },
    async releaseExecutionClaim(input) {
      const released = await releaseRecoveryExecutionClaim(input);
      return released.ok ? { ok: true } : { ok: false, message: released.message };
    },
  };
}
