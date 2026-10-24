import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as connection from '@archon/core/db/connection';
import { createRealSubmitDeps } from './pr-review-wiring';
import { runAndSubmitReview } from './pr-review-submit';

const HEAD = 'a'.repeat(40);
const WO = 'WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01';
const work = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 55,
  headSha: HEAD,
  author: 'builder',
  messageId: 'review-55',
  correlationId: 'review-context',
};

describe('production repair context with no lane citations', () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(':memory:');
    spyOn(connection, 'getDatabase').mockReturnValue(db);
  });
  afterEach(async () => {
    mock.restore();
    await db.close();
  });

  function production(overrides: Record<string, unknown> = {}) {
    let reads = 0;
    const data = {
      number: 55,
      state: 'open',
      merged: false,
      title: `Fix ${WO}`,
      body: '',
      created_at: '2026-10-21T10:00:00Z',
      head: {
        sha: HEAD,
        ref: 'fix/owner-context',
        repo: { full_name: 'thinmansoftware/bdc-harness' },
      },
      base: { ref: 'dev', repo: { full_name: 'thinmansoftware/bdc-harness' } },
      ...overrides,
    };
    const deps = createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: {
        pulls: {
          get: async () => {
            reads++;
            return { data };
          },
          createReview: async () => ({ data: { id: 1, state: 'CHANGES_REQUESTED' } }),
        },
      } as never,
      patOctokit: null,
      evaluate: async () => ({
        verdict: 'REQUEST_CHANGES',
        findings: [{ severity: 'major', scope: 'src/code.ts', summary: 'Fix the defect' }],
        reviewed_head_sha: HEAD,
        reviewer: { provider: 'test', model: 'judge' },
        acceptance_criteria_available: false,
      }),
    });
    return { deps, reads: () => reads };
  }

  test('zero citations still yields exact outside PR identity from one GitHub read', async () => {
    const { deps, reads } = production();
    expect(await deps.resolveLaneRepairContext!(work)).toEqual({
      laneRepair: null,
      identity: {
        title: `Fix ${WO}`,
        body: '',
        headRef: 'fix/owner-context',
        prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/55',
      },
    });
    expect(reads()).toBe(1);
  });

  test('production rejection actually persists one outside-Cauldron owner handoff', async () => {
    const { deps } = production();
    const result = await runAndSubmitReview(work, deps);
    expect(result.disposition).toBe('changes_requested');
    const rows = await db.query<{ body: string }>(
      "SELECT body FROM agent_dispatch_messages WHERE recipient='taskmaster'"
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.parse(rows.rows[0].body)).toMatchObject({
      kind: 'overseer_remediation_exhausted',
      reason: 'outside_cauldron',
      buildLine: 'outside',
      owningLane: null,
      woId: WO,
      headSha: HEAD,
    });
  });

  test('a real lane citation reuses the one bound PR read and preserves structural attribution', async () => {
    await db.query(`INSERT INTO remote_agent_conversations
      (id,platform_type,platform_conversation_id,ai_assistant_type)
      VALUES ('context-conversation','test','context-conversation','codex')`);
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
      (id,conversation_id,workflow_name,status,started_at,completed_at,user_message)
      VALUES ('context-run','context-conversation','bdc-feature-development-codex','completed',$1,$2,$3)`,
      ['2026-10-21T09:00:00Z', '2026-10-21T11:00:00Z', `WO_ID=${WO} --project bdc-harness`]
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_events
      (id,workflow_run_id,event_type,step_index,step_name,data,created_at)
      VALUES ('context-event','context-run','node_completed',0,'implement',$1,$2)`,
      [
        JSON.stringify({ output: 'opened https://github.com/thinmansoftware/bdc-harness/pull/55' }),
        '2026-10-21T10:00:00Z',
      ]
    );
    const { deps, reads } = production();
    expect(await deps.resolveLaneRepairContext!(work)).toMatchObject({
      laneRepair: {
        woId: WO,
        headRef: 'fix/owner-context',
        workflowName: 'bdc-feature-development-codex',
      },
    });
    expect(reads()).toBe(1);
  });

  test.each([
    { number: 56 },
    { state: 'closed' },
    { state: 'unknown' },
    { merged: true },
    {
      head: {
        sha: 'b'.repeat(40),
        ref: 'fix/other',
        repo: { full_name: 'thinmansoftware/bdc-harness' },
      },
    },
    { base: { ref: 'dev', repo: { full_name: 'other/repo' } } },
    { base: undefined },
    { state: undefined },
    { head: { sha: HEAD, ref: 'fix/fork', repo: { full_name: 'other/fork' } } },
  ])('mismatched live identity fails closed: %j', async mismatch => {
    expect(await production(mismatch).deps.resolveLaneRepairContext!(work)).toBeNull();
  });

  test('attribution store failure is not treated as proven outside-Cauldron', async () => {
    const query = db.query.bind(db);
    spyOn(db, 'query').mockImplementation(async (sql, params) => {
      if (sql.includes('FROM remote_agent_workflow_runs'))
        throw new Error('fixture store unavailable');
      return query(sql, params);
    });
    const { deps } = production();
    expect(await deps.resolveLaneRepairContext!(work)).toBeNull();
  });
});
