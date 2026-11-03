/**
 * WO-HARNESS-T3-COMMAND-CONSUMER-01 Amendment 5 A5.0: the database-backed WO
 * claim, plugged into runCascade's existing WO-lock seam
 * (`deps.acquireWoLock` / `deps.releaseWoLock`). BOTH in-process cascade
 * callers -- Taskmaster (taskmaster/loop.ts) and the T3 command consumer
 * (dispatch/cauldron-fire-consumer.ts) -- pass this pair, so a Taskmaster
 * cascade and a T3 cascade can never run the same WO at once, including between
 * tiers and during discovery. Keyed by the canonical WO id only (not project).
 * Taskmaster's tm_fire_admissions budget is untouched.
 *
 * Outcome-conditional release (Overseer major, XO decision 2026-11-03): runCascade
 * calls releaseWoLock whenever it exits. smart-cauldron's own file lock keeps
 * that behavior for every other caller; THIS database claim is released only on
 * a proven-terminal outcome -- a terminal cascade record whose every run is
 * terminal (no resumable run). On a frontier-approval pause or an uncertain
 * exit it is RETAINED with the run ids, and released later by (a) the resumed
 * cascade reaching terminal (the claim transfers to it on acquire), (b) an
 * operator release, or (c) reconcileRetainedWoClaims finding every run under the
 * claim terminal. No time-based expiry.
 */
import type { IDatabase } from '@archon/core';
import {
  acquireWoClaim,
  findActiveWoClaim,
  listRetainedWoClaims,
  releaseWoClaim,
  retainWoClaim,
  transferWoClaim,
} from '@archon/core/db/cascade-wo-claims';
import * as workflowsDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import { approvalHandOffBoundS, isApprovalHandOff } from './approval-handoff';
import { readCascadeRecord } from '@archon/smart-cauldron/cascade';
import type { CascadeDeps } from '@archon/smart-cauldron/cascade';
import type { AcquireWoLockResult } from '@archon/smart-cauldron/wo-lock';

/** Cascade record statuses that may still resume or are still executing. */
const HOLDING_CASCADE_STATUSES = new Set([
  'running',
  'pending-frontier-approval',
  'frontier-approved',
  'recovery-delegated',
]);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'escalated']);

/** Status of one workflow run, and whether a `failed` is an approval hand-off (resumable). */
export type ClaimRunReader = (
  runId: string
) => Promise<{ status: string; approvalHandOff: boolean } | null>;

/**
 * Hand-off status comes from the run's latest decisive events inside the
 * bounded window (isApprovalHandOff + T3_APPROVAL_HANDOFF_S) -- never from the
 * approval_response metadata, which resumeWorkflowRun preserves, so a run that
 * resumed after approval and then failed is terminal, not a hand-off forever.
 * Release and reconcile both use this reader.
 */
const defaultRunReader: ClaimRunReader = async runId => {
  const run = await workflowsDb.getWorkflowRun(runId);
  if (!run) return null;
  if (run.status !== 'failed') return { status: run.status, approvalHandOff: false };
  const events = await workflowEventsDb.listWorkflowEvents(runId);
  return {
    status: run.status,
    approvalHandOff: isApprovalHandOff(
      {
        run: { status: run.status },
        events: events.map(event => ({
          event_type: event.event_type,
          created_at: event.created_at as unknown as string,
        })),
      },
      { nowMs: Date.now(), maxAgeS: approvalHandOffBoundS(process.env) }
    ),
  };
};

/** The production run reader (exported for the real-store tests). */
export const claimRunReader: ClaimRunReader = defaultRunReader;

async function everyRunTerminal(runIds: string[], readRun: ClaimRunReader): Promise<boolean> {
  for (const runId of runIds) {
    const run = await readRun(runId);
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status) || run.approvalHandOff) return false;
  }
  return true;
}

export interface ClaimDepsOptions {
  readRun?: ClaimRunReader;
  readRecord?: typeof readCascadeRecord;
}

export function cascadeWoClaimDeps(
  holder: string,
  db?: IDatabase,
  options: ClaimDepsOptions = {}
): Required<Pick<CascadeDeps, 'acquireWoLock' | 'releaseWoLock'>> {
  const readRun = options.readRun ?? defaultRunReader;
  const readRecord = options.readRecord ?? readCascadeRecord;
  return {
    acquireWoLock: async (woId, project, cascadeId, outDir): Promise<AcquireWoLockResult> => {
      const now = new Date().toISOString();
      let result = await acquireWoClaim({ woId, project, cascadeId, holder, now }, db);
      // A frontier-approved pause hands its retained claim to the resumed cascade.
      if (!result.acquired && result.claim?.retained_reason) {
        const held = await readRecord(result.claim.cascade_id, outDir).catch(() => null);
        if (
          held?.status === 'frontier-approved' &&
          held.frontierApproval?.resumeCascadeId === cascadeId &&
          (await transferWoClaim(
            { woId, fromCascadeId: result.claim.cascade_id, toCascadeId: cascadeId },
            db
          ))
        ) {
          result = { acquired: true, claim: await findActiveWoClaim(woId, db) };
        }
      }
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
    releaseWoLock: async (woId, _project, cascadeId, outDir): Promise<void> => {
      const record = await readRecord(cascadeId, outDir).catch(() => null);
      const runIds = (record?.attempts ?? [])
        .map(attempt => attempt.runId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      let retainReason: string | null = null;
      if (!record) retainReason = 'record_missing';
      else if (HOLDING_CASCADE_STATUSES.has(record.status)) retainReason = record.status;
      else if (!(await everyRunTerminal(runIds, readRun))) retainReason = 'run_not_terminal';
      if (retainReason) {
        await retainWoClaim({ woId, cascadeId, reason: retainReason, runIds }, db);
        return;
      }
      await releaseWoClaim({ woId, cascadeId, now: new Date().toISOString() }, db);
    },
  };
}

/**
 * (c) Reconcile retained claims: release one when its cascade can no longer
 * resume (record not paused for approval / handed off / delegated) and every run
 * recorded under it is terminal in the event store. Returns released WO ids.
 */
export async function reconcileRetainedWoClaims(
  db?: IDatabase,
  options: ClaimDepsOptions & { outDir?: string } = {}
): Promise<string[]> {
  const readRun = options.readRun ?? defaultRunReader;
  const readRecord = options.readRecord ?? readCascadeRecord;
  const released: string[] = [];
  for (const claim of await listRetainedWoClaims(db)) {
    const record = await readRecord(claim.cascade_id, options.outDir).catch(() => null);
    if (record && record.status !== 'running' && HOLDING_CASCADE_STATUSES.has(record.status)) {
      continue; // still resumable (paused for approval, handed off, delegated)
    }
    let runIds: string[] = [];
    try {
      runIds = JSON.parse(claim.run_ids_json) as string[];
    } catch {
      continue;
    }
    if (runIds.length === 0) continue; // nothing to prove terminal: operator release only
    if (!(await everyRunTerminal(runIds, readRun))) continue;
    if (
      await releaseWoClaim(
        { woId: claim.wo_id, cascadeId: claim.cascade_id, now: new Date().toISOString() },
        db
      )
    ) {
      released.push(claim.wo_id);
    }
  }
  return released;
}
