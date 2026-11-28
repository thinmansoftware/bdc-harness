/**
 * wo-fire-guard.ts -- Server-side duplicate-fire refusal for POST /run.
 *
 * Blocks a NEW independent fire of a WO while another run for that WO is
 * live (running/pending/paused). Cascade climbs are sequential (prior run
 * already terminal) so they are not blocked. Escalation-packet messages are
 * also allowed through.
 *
 * Anchor: bdc-xo#1546 concurrent multi-lane builds of the same WO.
 */

import { getDatabase } from '@archon/core/db/connection';
import {
  releaseWoRunAdmission,
  reserveWoRunAdmission,
  withWoRunAdmission,
} from '@archon/core/db/wo-run-admissions';
import { createLogger } from '@archon/paths';

export type DeferWoAdmissionRelease = (completion: Promise<void>) => void;

export function extractWoIdFromMessage(message: string): string | null {
  const m = /\b(WO-[A-Z][A-Z0-9-]*-\d+)\b/.exec(message);
  return m?.[1] ?? null;
}

export function isCascadeClimbMessage(message: string): boolean {
  return (
    message.includes('## Prior attempt context') ||
    message.includes('=== ESCALATION PACKET') ||
    message.includes('ESCALATION PACKET')
  );
}

export interface LiveWoRun {
  id: string;
  status: string;
  workflow_name: string;
}

/**
 * Returns live runs whose user_message claims the same WO_ID.
 */
export async function findLiveRunsForWo(woId: string): Promise<LiveWoRun[]> {
  const db = getDatabase();
  const admittedWo =
    db.dialect === 'postgres'
      ? "metadata->>'admitted_wo_id'"
      : "CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.admitted_wo_id') END";
  const { rows: runs } = await db.query<
    LiveWoRun & { user_message: string | null; admitted_wo_id: string | null }
  >(
    `SELECT id, status, workflow_name, user_message, ${admittedWo} AS admitted_wo_id
     FROM remote_agent_workflow_runs
     WHERE status IN ('running', 'pending', 'paused', 'waiting_provider', 'interrupted')`
  );
  const escaped = woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:[^A-Za-z0-9-]|$)`);
  return runs
    .filter(r => r.admitted_wo_id === woId || re.test(r.user_message ?? ''))
    .map(r => ({
      id: r.id,
      status: r.status,
      workflow_name: r.workflow_name,
    }));
}

/** Shared admission boundary for POST /run and exact-target recovery. */
export async function dispatchGuardedWoRun<T>(input: {
  woId: string | null;
  authorizeConcurrent?: boolean;
  excludeRunId?: string;
  revalidate?: () => Promise<boolean>;
  dispatch: (deferRelease?: DeferWoAdmissionRelease) => Promise<T>;
}): Promise<
  | { ok: true; result: T }
  | {
      ok: false;
      error: 'duplicate_wo_live' | 'recovery_target_changed' | 'wo_admission_in_progress';
      liveRuns: LiveWoRun[];
    }
> {
  const admission = input.woId ? await reserveWoRunAdmission(input.woId) : undefined;
  if (input.woId && !admission) {
    return { ok: false, error: 'wo_admission_in_progress', liveRuns: [] };
  }

  let completion: Promise<void> | undefined;
  try {
    const liveRuns =
      input.woId && !input.authorizeConcurrent
        ? (await findLiveRunsForWo(input.woId)).filter(run => run.id !== input.excludeRunId)
        : [];
    if (liveRuns.length) return { ok: false, error: 'duplicate_wo_live', liveRuns };
    if (input.revalidate && !(await input.revalidate())) {
      return { ok: false, error: 'recovery_target_changed', liveRuns: [] };
    }
    const deferRelease: DeferWoAdmissionRelease | undefined = admission
      ? (pending): void => {
          completion = pending;
        }
      : undefined;
    return {
      ok: true,
      result: await withWoRunAdmission(admission, () => input.dispatch(deferRelease)),
    };
  } finally {
    if (admission) {
      const release = (): Promise<void> =>
        releaseWoRunAdmission(admission).catch((err: unknown) => {
          createLogger('wo-fire-guard').warn(
            { err, woId: admission.woId },
            'wo_admission_release_failed'
          );
        });
      if (completion) void completion.then(release, release);
      else await release();
    }
  }
}
