/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 1 — fleet co-fire alarm.
 *
 * groupRunsByCodebase + count >=2 = the "running 2x" RED badge condition.
 */
import { describe, expect, it } from 'bun:test';
import { groupRunsByCodebase } from './fleet-cost';
import type { DashboardRunResponse } from './api';

function makeRun(overrides: Partial<DashboardRunResponse>): DashboardRunResponse {
  return {
    id: 'r1',
    workflow_name: 'feature-dev',
    conversation_id: 'c1',
    parent_conversation_id: null,
    codebase_id: 'cb-shopops',
    status: 'running',
    user_message: 'm',
    metadata: {},
    started_at: '2026-06-03T10:00:00Z',
    completed_at: null,
    last_activity_at: null,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    working_path: null,
    codebase_name: 'shopops',
    platform_type: null,
    worker_platform_id: null,
    parent_platform_id: null,
    current_step_name: null,
    total_steps: null,
    current_step_status: null,
    agents_completed: null,
    agents_failed: null,
    agents_total: null,
    ...overrides,
  };
}

describe('groupRunsByCodebase', () => {
  it('fires the co-fire alarm when >=2 runs share the same codebase_id', () => {
    const runs = [
      makeRun({ id: 'a', codebase_id: 'cb-shopops' }),
      makeRun({ id: 'b', codebase_id: 'cb-shopops' }),
    ];
    const groups = groupRunsByCodebase(runs);
    expect(groups.size).toBe(1);
    const list = groups.get('cb-shopops');
    expect(list?.length).toBe(2);
    expect(list?.map(r => r.id).sort()).toEqual(['a', 'b']);
    // Operator-facing condition: any group of size >=2 = RED CoFireBadge.
    let coFire = false;
    for (const v of groups.values()) if (v.length >= 2) coFire = true;
    expect(coFire).toBe(true);
  });

  it('does not fire for a single run', () => {
    const groups = groupRunsByCodebase([makeRun({ id: 'a' })]);
    let coFire = false;
    for (const v of groups.values()) if (v.length >= 2) coFire = true;
    expect(coFire).toBe(false);
  });

  it('does not fire when runs are on different codebases', () => {
    const groups = groupRunsByCodebase([
      makeRun({ id: 'a', codebase_id: 'cb-shopops' }),
      makeRun({ id: 'b', codebase_id: 'cb-lspro' }),
    ]);
    expect(groups.size).toBe(2);
    let coFire = false;
    for (const v of groups.values()) if (v.length >= 2) coFire = true;
    expect(coFire).toBe(false);
  });

  it('falls back to codebase_name when codebase_id is null (Ambiguity #5)', () => {
    const groups = groupRunsByCodebase([
      makeRun({ id: 'a', codebase_id: null, codebase_name: 'shopops' }),
      makeRun({ id: 'b', codebase_id: null, codebase_name: 'shopops' }),
    ]);
    expect(groups.get('shopops')?.length).toBe(2);
  });

  it('skips runs with neither codebase_id nor codebase_name (cannot co-fire)', () => {
    const groups = groupRunsByCodebase([
      makeRun({ id: 'orphan', codebase_id: null, codebase_name: null }),
    ]);
    expect(groups.size).toBe(0);
  });
});
