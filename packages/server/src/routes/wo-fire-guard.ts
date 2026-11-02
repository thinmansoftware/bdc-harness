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

import { listWorkflowRuns } from '@archon/core/db/workflows';

const LIVE_STATUSES = ['running', 'pending', 'paused'] as const;

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
  const runs = await listWorkflowRuns({
    status: [...LIVE_STATUSES],
    limit: 100,
  });
  const escaped = woId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:[^A-Za-z0-9-]|$)`);
  return runs
    .filter(r => re.test(r.user_message ?? ''))
    .map(r => ({
      id: r.id,
      status: r.status,
      workflow_name: r.workflow_name,
    }));
}
