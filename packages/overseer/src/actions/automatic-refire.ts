import { resolve } from 'path';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import type { OverseerWorkflowEvent, WatchedRunRecord } from '../types.ts';
import { MAX_AUTOMATIC_RECOVERY_ATTEMPTS, type RepairRefireExecutionResult } from './repair-refire';

export type AutomaticRefireResult =
  | { status: 'fired'; runId: string; attempt: number }
  | { status: 'indeterminate'; reason: string }
  | { status: 'refused'; reason: string }
  | { status: 'replay'; runId: string; attempt: number };

export interface AutomaticRefireDeps {
  countAutomaticAttempts(woId: string): Promise<number>;
  findLiveRunsForWo(woId: string): Promise<readonly { id: string; status: string }[]>;
  findConfirmedSuccessor(runId: string): Promise<{ runId: string; attempt: number } | null>;
  releaseTerminalWorktree?(
    record: WatchedRunRecord,
    events: OverseerWorkflowEvent[]
  ): Promise<{ ok: boolean; reason?: string }>;
  /** Composition root owns M-31 proposal/policy/salvage dependencies. */
  execute(
    record: WatchedRunRecord,
    events: OverseerWorkflowEvent[],
    attempt: number
  ): Promise<RepairRefireExecutionResult>;
}

export async function executeAutomaticRefire(
  record: WatchedRunRecord,
  events: OverseerWorkflowEvent[],
  deps: AutomaticRefireDeps
): Promise<AutomaticRefireResult> {
  const replay = await deps.findConfirmedSuccessor(record.runId);
  if (replay) return { status: 'replay', ...replay };
  const prior = await deps.countAutomaticAttempts(record.woId);
  if (prior >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
    return { status: 'refused', reason: 'attempt_ceiling' };
  }
  const live = await deps.findLiveRunsForWo(record.woId);
  if (live.some(run => run.id !== record.runId)) {
    return { status: 'refused', reason: 'duplicate_owner' };
  }
  if (record.recovery?.precondition === 'release_terminal_worktree') {
    if (!deps.releaseTerminalWorktree) return { status: 'refused', reason: 'salvage_failed' };
    const released = await deps.releaseTerminalWorktree(record, events);
    if (!released.ok) return { status: 'refused', reason: released.reason ?? 'salvage_failed' };
  }
  const result = await deps.execute(record, events, prior + 1);
  if (result.outcome === 'succeeded' && result.successor_run_id) {
    return { status: 'fired', runId: result.successor_run_id, attempt: prior + 1 };
  }
  if (result.outcome === 'indeterminate') return { status: 'indeterminate', reason: result.reason };
  if (result.outcome === 'escalated' && result.reason === 'attempt_ceiling') {
    return { status: 'refused', reason: 'attempt_ceiling' };
  }
  const denied = result.outcome === 'denied' ? `denied:${result.reason}` : result.reason;
  return { status: 'refused', reason: denied || result.outcome };
}

export interface ReleaseTerminalWorktreeDeps {
  getRunByWorkingPath(
    path: string
  ): Promise<{ id: string; status: string; workingPath?: string } | null>;
  inspect(path: string): Promise<{ dirty: boolean; diff: string; untracked: readonly string[] }>;
  persistPatch(ownerRunId: string, contents: string): Promise<void>;
  removeForce(path: string): Promise<void>;
}

export async function releaseTerminalWorktree(
  collisionMessage: string,
  deps: ReleaseTerminalWorktreeDeps
): Promise<{ ok: boolean; reason?: string }> {
  const held = /is already used by worktree at ['"]([^'"]+)['"]/.exec(collisionMessage)?.[1];
  if (!held) return { ok: false, reason: 'worktree_owner_unknown' };
  const normalized = resolve(held);
  const owner = await deps.getRunByWorkingPath(normalized);
  if (!owner || !owner.workingPath || resolve(owner.workingPath) !== normalized) {
    return { ok: false, reason: 'worktree_owner_unknown' };
  }
  if (!(TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(owner.status)) {
    return { ok: false, reason: 'worktree_held_by_live_run' };
  }
  try {
    const state = await deps.inspect(normalized);
    if (state.dirty) {
      const patch = `${state.diff}\n# Untracked files\n${state.untracked.join('\n')}\n`;
      await deps.persistPatch(owner.id, patch);
    }
    await deps.removeForce(normalized);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'salvage_failed' };
  }
}
