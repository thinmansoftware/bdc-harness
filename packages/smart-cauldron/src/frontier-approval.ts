/**
 * frontier-approval.ts -- Operator resolution of a paused premium-tier climb.
 *
 * WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01. When an AUTOMATIC climb reaches a
 * premium tier (default ['frontier']) the cascade pauses as
 * 'pending-frontier-approval' and persists a FrontierApprovalPacket instead of
 * firing ("then dont waste my usage if it will fail" -- John, 2026-08-18).
 *
 * This module is the resolution surface consumed by the operator API endpoints:
 *   - readCascadeRecordById: locate a paused cascade record by its cascadeId.
 *   - claimFrontierResolution: atomically claim the resolution EXACTLY ONCE
 *     (mirrors the wx-flag idempotency pattern in wo-lock.ts / recorder.ts) so a
 *     double approve/reject cannot fire twice or flip a decided outcome.
 *   - resumeFrontierTier: approve path -- re-run the cascade with entryOverride
 *     set to the premium tier (human-approved -> bypasses the gate) and the
 *     preserved priorContext replayed in, firing exactly once.
 *   - rejectFrontierTier: reject path -- terminate the record in place as
 *     'frontier-rejected' (needs-human), no fire.
 *
 * SECRET BOUNDARY: the operator token is never read from or written to the
 * persisted record. Callers re-supply the token for the resumed fire.
 * ASCII only. No emojis.
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { runCascade } from './cascade.js';
import type { CascadeDeps, RunCascadeOptions } from './cascade.js';
import { writeRecord } from './recorder.js';
import type { CascadeRunRecord } from './types.js';

const DEFAULT_OUT_DIR = './cascade-runs';

export type FrontierResolutionKind = 'approved' | 'rejected';

export interface ClaimFrontierResult {
  /** true when THIS call won the exclusive claim; false when already resolved. */
  readonly claimed: boolean;
  /** The resolution now recorded (this call's when claimed, the existing one otherwise). */
  readonly resolution: FrontierResolutionKind;
  readonly path: string;
}

interface FrontierClaimFile {
  readonly cascadeId: string;
  readonly resolution: FrontierResolutionKind;
  readonly claimedAt: string;
}

/**
 * Reconstruct the cascade record path for a cascadeId. Mirrors the private
 * buildRunSlug in recorder.ts (dispatch-<sha256(cascadeId)[:24]>) so a record
 * written by runCascade can be located from an operator API call. Kept as a
 * local re-derivation to avoid widening recorder.ts's exported surface.
 */
function cascadeRecordPath(cascadeId: string, outDir: string): string {
  const digest = createHash('sha256').update(cascadeId).digest('hex').slice(0, 24);
  return join(outDir, `dispatch-${digest}`, 'cascade-record.json');
}

function claimPath(cascadeId: string, outDir: string): string {
  const digest = createHash('sha256').update(cascadeId).digest('hex').slice(0, 24);
  return join(outDir, 'frontier-approval-claims', `claim-${digest}.json`);
}

/**
 * Read a persisted cascade record by cascadeId. Returns null when no record
 * exists (unknown id). Rethrows any non-ENOENT read/parse error.
 */
export async function readCascadeRecordById(
  cascadeId: string,
  outDir: string = DEFAULT_OUT_DIR
): Promise<CascadeRunRecord | null> {
  const filePath = cascadeRecordPath(cascadeId, outDir);
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as CascadeRunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Atomically claim the resolution of a paused frontier approval EXACTLY ONCE.
 * The first caller (approve or reject) wins and its resolution is durable; every
 * later caller observes claimed=false with the already-recorded resolution, so
 * a double approve cannot fire twice and an approve-after-reject (or vice versa)
 * cannot flip a decided outcome.
 */
export async function claimFrontierResolution(
  cascadeId: string,
  resolution: FrontierResolutionKind,
  outDir: string = DEFAULT_OUT_DIR
): Promise<ClaimFrontierResult> {
  const filePath = claimPath(cascadeId, outDir);
  await mkdir(dirname(filePath), { recursive: true });
  const record: FrontierClaimFile = {
    cascadeId,
    resolution,
    claimedAt: new Date().toISOString(),
  };
  try {
    await writeFile(filePath, JSON.stringify(record, null, 2) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { claimed: true, resolution, path: filePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(filePath, 'utf8')) as FrontierClaimFile;
    return { claimed: false, resolution: existing.resolution, path: filePath };
  }
}

export interface ResumeFrontierOptions {
  /** Operator token for the resumed live fire (secret boundary -- never persisted). */
  token?: string;
  /** cascade-runs output dir. Default: ./cascade-runs (matches server default). */
  outDir?: string;
  /** Override the API base URL; defaults to the value preserved in the packet. */
  apiBaseUrl?: string;
  /** Dependency injection passthrough (for tests). */
  deps?: CascadeDeps;
  /** Admission callback passthrough (endpoint returns after the resumed record is durable). */
  onAdmission?: RunCascadeOptions['onAdmission'];
}

/**
 * Approve path: resume a paused premium-tier climb by re-running the cascade
 * with entryOverride set to the premium tier (human-approved, so the gate is
 * bypassed) and the preserved priorContext replayed in. Fires the premium tier
 * exactly once. The original paused record is annotated with the resolution and
 * a back-reference to the new cascadeId for traceability.
 *
 * Callers MUST guard this with claimFrontierResolution to guarantee exactly-once
 * semantics across concurrent/duplicate approve calls.
 */
export async function resumeFrontierTier(
  record: CascadeRunRecord,
  opts: ResumeFrontierOptions = {}
): Promise<CascadeRunRecord> {
  const packet = record.frontierApproval;
  if (!packet) {
    throw new Error(
      `[smart-cauldron/frontier-approval] cascade ${record.cascadeId} has no frontierApproval packet to resume`
    );
  }
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const project = packet.project ?? record.project ?? undefined;
  if (!project) {
    throw new Error(
      `[smart-cauldron/frontier-approval] cannot resume ${record.cascadeId}: no project binding in the packet`
    );
  }

  // Stable id for the resumed cascade so the back-reference can be recorded up
  // front and the resumed fire is itself idempotent under replay (dispatchId).
  const resumeCascadeId = randomUUID();
  await annotateResolution(record, 'approved', outDir, { resumeCascadeId });

  return runCascade({
    woId: packet.woId,
    woClass: packet.woClass ?? undefined,
    tags: packet.tags,
    entryOverride: packet.tierName,
    initialPriorContext: packet.priorContext,
    apiBaseUrl: opts.apiBaseUrl ?? packet.apiBaseUrl,
    token: opts.token,
    project,
    outDir,
    dispatchId: resumeCascadeId,
    deps: opts.deps,
    onAdmission: opts.onAdmission,
  });
}

/**
 * Reject path: terminate a paused premium-tier climb in place as
 * 'frontier-rejected' (needs-human), recording the operator reason. No fire.
 *
 * Callers MUST guard this with claimFrontierResolution to guarantee exactly-once
 * semantics and to prevent a reject flipping an already-approved cascade.
 */
export async function rejectFrontierTier(
  record: CascadeRunRecord,
  reason: string,
  outDir: string = DEFAULT_OUT_DIR
): Promise<CascadeRunRecord> {
  if (!record.frontierApproval) {
    throw new Error(
      `[smart-cauldron/frontier-approval] cascade ${record.cascadeId} has no frontierApproval packet to reject`
    );
  }
  const resolvedAt = new Date().toISOString();
  const updated: CascadeRunRecord = {
    ...record,
    status: 'frontier-rejected',
    frontierApproval: {
      ...record.frontierApproval,
      resolution: 'rejected',
      resolvedAt,
      rejectReason: reason,
    },
  };
  await writeRecord(updated, outDir);
  return updated;
}

/**
 * Annotate the original paused record with the resolution (and optional
 * back-references) for traceability. Approve keeps the record's status as
 * 'pending-frontier-approval' -- the resumed cascade (resumeCascadeId) carries
 * the actual work; the claim file is the authoritative idempotency guard.
 */
async function annotateResolution(
  record: CascadeRunRecord,
  resolution: FrontierResolutionKind,
  outDir: string,
  extra: { resumeCascadeId?: string; rejectReason?: string }
): Promise<CascadeRunRecord> {
  if (!record.frontierApproval) {
    throw new Error(
      `[smart-cauldron/frontier-approval] cascade ${record.cascadeId} has no frontierApproval packet to annotate`
    );
  }
  const resolvedAt = new Date().toISOString();
  const updated: CascadeRunRecord = {
    ...record,
    frontierApproval: {
      ...record.frontierApproval,
      resolution,
      resolvedAt,
      resumeCascadeId: extra.resumeCascadeId ?? record.frontierApproval.resumeCascadeId,
      rejectReason: extra.rejectReason ?? record.frontierApproval.rejectReason,
    },
  };
  await writeRecord(updated, outDir);
  return updated;
}
