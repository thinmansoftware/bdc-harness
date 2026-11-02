/**
 * Taskmaster derives cursor and zero fire-lane health from recent
 * workflow-run outcomes and upserts tm_health for 24 hours.
 *
 * A lane is healthy when one of its workflows completed in the last 7 days
 * and its newest three terminal runs are not all failed or escalated. There
 * is no provider quota probe. This module only SELECTs workflow runs.
 */
import { getDatabase, getDatabaseType } from '@archon/core';
import {
  getHealthSample,
  upsertHealthSample,
  type TmHealthState,
} from '@archon/core/db/taskmaster';

const DAY_MS = 86_400_000;
const WINDOW_MS = 7 * DAY_MS;
const CURSOR_WORKFLOW = 'bdc-feature-development-cursor';
const ZERO_WORKFLOW = 'bdc-feature-development-zero-open';
const TERMINAL_STATUSES = ['completed', 'failed', 'escalated', 'cancelled'] as const;
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);
const FAILURE_STATUSES = new Set(['failed', 'escalated']);

export interface LaneRun {
  workflowName: string;
  status: string;
  completedAt: string | null;
}

export interface LaneHealthDeps {
  now?: () => Date;
  getHealthSample?: typeof getHealthSample;
  upsertHealthSample?: typeof upsertHealthSample;
  listRuns?: (workflowNames: readonly string[], sinceIso: string) => Promise<LaneRun[]>;
}

interface WorkflowRunHealthRow {
  workflow_name: string;
  status: string;
  completed_at: string | Date | null;
}

const LANES = [
  { workflowName: CURSOR_WORKFLOW, provider: 'cursor' },
  { workflowName: ZERO_WORKFLOW, provider: 'zero' },
] as const;

function completedAtToIso(value: string | Date | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const text = value.trim();
  if (text.length === 0) return null;
  // SQLite datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS'.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return `${text.replace(' ', 'T')}Z`;
  return text;
}

function sqlSince(sinceIso: string): string {
  if (getDatabaseType() !== 'sqlite') return sinceIso;
  return sinceIso.slice(0, 19).replace('T', ' ');
}

async function listRecentTerminalRuns(
  workflowNames: readonly string[],
  sinceIso: string
): Promise<LaneRun[]> {
  const result = await getDatabase().query<WorkflowRunHealthRow>(
    `SELECT workflow_name, status, completed_at
     FROM remote_agent_workflow_runs
     WHERE workflow_name IN ($1, $2)
       AND status IN ($3, $4, $5, $6)
       AND completed_at IS NOT NULL
       AND completed_at >= $7`,
    [
      workflowNames[0],
      workflowNames[1],
      TERMINAL_STATUSES[0],
      TERMINAL_STATUSES[1],
      TERMINAL_STATUSES[2],
      TERMINAL_STATUSES[3],
      sqlSince(sinceIso),
    ]
  );
  return result.rows.map(row => ({
    workflowName: row.workflow_name,
    status: row.status,
    completedAt: completedAtToIso(row.completed_at),
  }));
}

/** Health of one workflow from terminal runs already loaded by the caller. */
export function deriveLaneHealth(
  workflowName: string,
  runs: readonly LaneRun[],
  now: Date
): TmHealthState {
  const nowMs = now.getTime();
  const windowStart = nowMs - WINDOW_MS;
  const qualifying = runs
    .filter(run => {
      if (run.workflowName !== workflowName) return false;
      if (!TERMINAL_STATUS_SET.has(run.status)) return false;
      if (run.completedAt == null) return false;
      const completedMs = Date.parse(run.completedAt);
      if (!Number.isFinite(completedMs)) return false;
      return completedMs >= windowStart && completedMs <= nowMs;
    })
    .sort(
      (left, right) => Date.parse(right.completedAt ?? '') - Date.parse(left.completedAt ?? '')
    );

  if (qualifying.length === 0) return 'unknown';
  const newestThree = qualifying.slice(0, 3);
  if (qualifying.length >= 3 && newestThree.every(run => FAILURE_STATUSES.has(run.status))) {
    return 'degraded';
  }
  if (qualifying.some(run => run.status === 'completed')) return 'healthy';
  return 'unknown';
}

/**
 * Upsert cursor and zero tm_health when no unexpired sample exists.
 * Derived 'unknown' is written too. Never updates workflow runs.
 */
export async function refreshLaneHealth(deps: LaneHealthDeps = {}): Promise<void> {
  const now = deps.now ? deps.now() : new Date();
  const readSample = deps.getHealthSample ?? getHealthSample;
  const writeSample = deps.upsertHealthSample ?? upsertHealthSample;
  const listRuns = deps.listRuns ?? listRecentTerminalRuns;
  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const runs = await listRuns(
    LANES.map(lane => lane.workflowName),
    sinceIso
  );
  for (const lane of LANES) {
    const existing = await readSample(lane.provider);
    if (existing !== null) continue;
    await writeSample({
      provider: lane.provider,
      state: deriveLaneHealth(lane.workflowName, runs, now),
      evidence: null,
      expires_at: new Date(now.getTime() + DAY_MS).toISOString(),
    });
  }
}
