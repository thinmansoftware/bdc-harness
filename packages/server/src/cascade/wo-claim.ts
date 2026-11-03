/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01 Amendment 5 A5.0: the database-backed WO
 * claim, plugged into runCascade's existing WO-lock seam
 * (`deps.acquireWoLock` / `deps.releaseWoLock`). BOTH in-process cascade
 * callers -- Taskmaster (taskmaster/loop.ts) and the T3 command consumer
 * (dispatch/cauldron-fire-consumer.ts) -- pass this pair, so a Taskmaster
 * cascade and a T3 cascade can never run the same WO at once, including between
 * tiers and during discovery. Keyed by the canonical WO id only (not project).
 * Taskmaster's tm_fire_admissions budget is untouched.
 */
import type { IDatabase } from '@archon/core';
import { acquireWoClaim, releaseWoClaim } from '@archon/core/db/cascade-wo-claims';
import type { CascadeDeps } from '@archon/smart-cauldron/cascade';
import type { AcquireWoLockResult } from '@archon/smart-cauldron/wo-lock';

export function cascadeWoClaimDeps(
  holder: string,
  db?: IDatabase
): Required<Pick<CascadeDeps, 'acquireWoLock' | 'releaseWoLock'>> {
  return {
    acquireWoLock: async (woId, project, cascadeId): Promise<AcquireWoLockResult> => {
      const now = new Date().toISOString();
      const result = await acquireWoClaim({ woId, project, cascadeId, holder, now }, db);
      const claim = result.claim;
      return {
        acquired: result.acquired,
        path: `db:cascade_wo_claims:${woId}`,
        record: {
          woId,
          project: claim?.project ?? project,
          cascadeId: claim?.cascade_id ?? cascadeId,
          status: 'running',
          createdAt: claim?.claimed_at ?? now,
          updatedAt: now,
        },
      };
    },
    releaseWoLock: async (woId, _project, cascadeId): Promise<void> => {
      await releaseWoClaim({ woId, cascadeId, now: new Date().toISOString() }, db);
    },
  };
}
