import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import { createRepairRefireAdapter } from '../adapters/repair-refire';
import {
  assessRepairRefireCandidate,
  executeRepairRefire,
  type FirstRefireOnRampResultV1,
  type OverseerSalvageReceiptV1,
  type RepairRefireExecutionDeps,
} from './repair-refire';
import type { OverseerWorkflowEvent, WatchedRunRecord } from '../types';

const exec = promisify(execFile);

export interface AutomaticRefireDeps {
  countAutomaticAttempts(woId: string): Promise<number>;
  findLiveRunsForWo(woId: string): Promise<unknown[]>;
  fireWorkflowRun(input: {
    workflowName: string;
    woId: string;
    project: string;
    runId: string;
  }): Promise<{ ok: boolean; runId?: string; conversationId?: string; error?: string }>;
  executionDeps: Omit<RepairRefireExecutionDeps, 'adapter' | 'adapterName'>;
  workflowName(record: WatchedRunRecord): string | undefined;
  salvage(
    record: WatchedRunRecord,
    events: OverseerWorkflowEvent[]
  ): Promise<OverseerSalvageReceiptV1 | null>;
  releaseTerminalWorktree?(
    record: WatchedRunRecord,
    events: OverseerWorkflowEvent[]
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type AutomaticRefireResult =
  | { status: 'fired'; runId: string; attempt: number }
  | { status: 'indeterminate'; reason: string }
  | { status: 'refused'; reason: string };

/** Real composition seam around the frozen repair/refire executor. */
export async function executeAutomaticRefire(
  record: WatchedRunRecord,
  events: OverseerWorkflowEvent[],
  deps: AutomaticRefireDeps
): Promise<AutomaticRefireResult> {
  const count = await deps.countAutomaticAttempts(record.woId);
  if (count >= 2) return { status: 'refused', reason: 'attempt_ceiling' };
  if ((await deps.findLiveRunsForWo(record.woId)).length > 0)
    return { status: 'refused', reason: 'duplicate_owner' };
  const workflowName = deps.workflowName(record);
  if (!workflowName || events.length === 0)
    return { status: 'refused', reason: 'evidence_incomplete' };
  const salvage = await deps.salvage(record, events);
  if (!salvage) return { status: 'refused', reason: 'salvage_missing' };
  if (record.errorClass === 'worktree_collision') {
    if (!deps.releaseTerminalWorktree)
      return { status: 'refused', reason: 'worktree_release_not_wired' };
    const release = await deps.releaseTerminalWorktree(record, events);
    if (!release.ok) return { status: 'refused', reason: release.reason };
  }
  const fire = async (): Promise<FirstRefireOnRampResultV1> => {
    const result = await deps.fireWorkflowRun({
      workflowName,
      woId: record.woId,
      project: record.repo ?? '',
      runId: record.runId,
    });
    if (!result.ok)
      return {
        schema_version: 'overseer-first-refire-on-ramp-result-v1' as const,
        status: 'failed' as const,
        successor_run_id: null,
        external_effect_reference: null,
        evidence_digest: deps.executionDeps.sha256hex(result.error ?? 'fire_failed'),
        reason: `fire_failed:${result.error ?? 'unknown'}`,
      };
    return {
      schema_version: 'overseer-first-refire-on-ramp-result-v1' as const,
      status: 'succeeded' as const,
      successor_run_id: result.runId ?? null,
      external_effect_reference: result.conversationId ?? null,
      evidence_digest: deps.executionDeps.sha256hex(result.conversationId ?? result.runId ?? ''),
      reason: 'fired',
    };
  };
  const adapter = createRepairRefireAdapter({
    onRamp: { startFirstRefire: fire },
    conductor: { pickEntryTier: () => workflowName, runCascade: fire },
    inPlaceRepair: {
      startInPlaceRepair: async () => {
        throw new Error('in_place_repair_not_wired');
      },
    },
  });
  const targetDigest = deps.executionDeps.sha256hex(`${record.runId}:${events.at(-1)?.id ?? ''}`);
  const assessment = assessRepairRefireCandidate({
    action_gate_enabled: true,
    evidence_complete: true,
    has_exact_target: true,
    has_active_owner_or_run: false,
    has_indeterminate_prior_effect: false,
    salvage_complete: true,
    automatic_attempt_count: count,
    scope_changed: false,
    semantic_dispute: false,
    fusion_available: false,
    repairable_in_place: false,
  });
  const result = await executeRepairRefire(
    {
      assessment,
      proposal_id: `refire:${record.runId}`,
      execution_id: `refire:${record.runId}:${count + 1}`,
      idempotency_key: `repair_refire:${record.runId}`,
      repository: record.repo ?? '',
      wo_id: record.woId,
      workflow_name: workflowName,
      target_digest: targetDigest,
      scope_digest: salvage.scope_digest,
      failure_digest: targetDigest,
      source_run_id: record.runId,
      salvage_receipt: salvage,
      actor: 'overseer-refire',
      correlation_id: record.runId,
    },
    { ...deps.executionDeps, adapter, adapterName: 'overseer-fire-loopback' }
  );
  if (result.outcome === 'succeeded' && result.successor_run_id)
    return { status: 'fired', runId: result.successor_run_id, attempt: count + 1 };
  if (result.outcome === 'indeterminate') return { status: 'indeterminate', reason: result.reason };
  return { status: 'refused', reason: result.reason || result.outcome };
}

export async function releaseTerminalWorktree(input: {
  message: string;
  archonHome: string;
  getOwner(path: string): Promise<{ id: string; status: string } | null>;
  removeForce(path: string): Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const path = /is already used by worktree at ['"]([^'"]+)['"]/.exec(input.message)?.[1];
  if (!path) return { ok: false, reason: 'worktree_owner_unknown' };
  const owner = await input.getOwner(path);
  if (!owner) return { ok: false, reason: 'worktree_owner_unknown' };
  if (!(TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(owner.status))
    return { ok: false, reason: 'worktree_held_by_live_run' };
  try {
    const status = (await exec('git', ['-C', path, 'status', '--porcelain'])).stdout;
    if (status.trim()) {
      const diff = (await exec('git', ['-C', path, 'diff', 'HEAD'])).stdout;
      const untracked = status
        .split('\n')
        .filter(line => line.startsWith('?? '))
        .map(line => line.slice(3));
      const patchPath = join(input.archonHome, 'runs', owner.id, 'overseer-salvage.patch');
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, `${diff}\n# Untracked files\n${untracked.join('\n')}\n`);
    }
    await input.removeForce(path);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'salvage_failed' };
  }
}
