import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { CascadeAttempt, CascadeRunRecord } from '@archon/smart-cauldron/types';
import { defaultGetFireRunEvidence } from './loop';

const identity = { cascadeId: 'cascade-exact', woId: 'WO-TEST-01', project: 'bdc-harness' };
let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  // Real SQL over the workflow columns read by the production probe.
  db.exec(`CREATE TABLE remote_agent_workflow_runs (
    id TEXT PRIMARY KEY, workflow_name TEXT, status TEXT, metadata TEXT,
    user_message TEXT, started_at TEXT
  )`);
});
afterEach(() => db.close());

function attempt(runId: string | null, workflowName = 'bound-workflow'): CascadeAttempt {
  return {
    sourceEventId: `source-${runId}`,
    sourceEventAt: new Date(0).toISOString(),
    tier: 'codex',
    workflowName,
    runId,
    outcome: 'gate-failed',
    gateFailReason: 'fixture',
    infraErrorReason: null,
    servedModelId: null,
    costUsd: null,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  };
}
function record(overrides: Partial<CascadeRunRecord> = {}): CascadeRunRecord {
  return {
    ...identity,
    request: { woClass: 'CODE', tags: [], entryOverride: null, dryRun: false },
    createdAt: new Date(0).toISOString(),
    status: 'blocked',
    winningTier: null,
    attempts: [attempt('actual-run')],
    totalCostUsd: null,
    telemetry: { entryTier: 'codex', climbed: false, climbCount: 0, wonCheap: false },
    ...overrides,
  };
}
function seed(
  id: string,
  status: string,
  options: { workflow?: string; message?: string; metadata?: string; at?: string } = {}
) {
  db.query('INSERT INTO remote_agent_workflow_runs VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    options.workflow ?? 'bound-workflow',
    status,
    options.metadata ?? '{}',
    options.message ?? identity.woId,
    options.at ?? '2026-10-18T00:00:00Z'
  );
}
function probe(
  records = new Map([[identity.cascadeId, record()]]),
  project: string | undefined = identity.project
) {
  return defaultGetFireRunEvidence(identity.woId, identity.cascadeId, project, {
    readCascade: async id => records.get(id) ?? null,
    query: async <T>(sql: string, params: unknown[] = []) => ({
      rows: db.query(sql).all(...(params as string[])) as T[],
    }),
  });
}

describe('exact cascade-bound fire usefulness evidence', () => {
  test('a completed actual run remains useful', async () => {
    seed('actual-run', 'completed');
    expect(await probe()).toMatchObject({ status: 'completed', prOpened: false });
  });

  test('a newer completed sibling WO cannot grade the failed bound run useful', async () => {
    seed('actual-run', 'failed');
    seed('unrelated', 'completed', { message: 'WO-TEST-010 sibling', at: '2026-10-18T01:00:00Z' });
    expect(await probe()).toMatchObject({ status: 'failed', prOpened: false });
  });

  test('a later successful bound climb is found even when unrelated newer work failed', async () => {
    seed('actual-run', 'failed');
    seed('later-run', 'completed', { workflow: 'later-workflow', at: '2026-10-18T01:00:00Z' });
    seed('unrelated', 'failed', { at: '2026-10-18T02:00:00Z' });
    expect(
      await probe(
        new Map([
          [
            identity.cascadeId,
            record({ attempts: [attempt('actual-run'), attempt('later-run', 'later-workflow')] }),
          ],
        ])
      )
    ).toMatchObject({ status: 'completed' });
  });

  test('only explicit frontier resume links extend the bound cascade', async () => {
    seed('actual-run', 'failed');
    seed('resume-run', 'completed', {
      workflow: 'premium-workflow',
      message: 'no WO substring here',
    });
    const parent = record({
      frontierApproval: {
        resumeCascadeId: 'explicit-resume',
      } as CascadeRunRecord['frontierApproval'],
    });
    const resumed = record({
      cascadeId: 'explicit-resume',
      attempts: [attempt('resume-run', 'premium-workflow')],
    });
    expect(
      await probe(
        new Map([
          [identity.cascadeId, parent],
          ['explicit-resume', resumed],
        ])
      )
    ).toMatchObject({ status: 'completed' });
  });

  for (const field of ['prUrl', 'pr_url', 'pullRequestUrl']) {
    test(`preserves existing ${field} evidence from a bound workflow row`, async () => {
      seed('actual-run', 'failed', {
        message: 'no WO text',
        metadata: JSON.stringify({ [field]: 'https://github.com/synthetic/test/pull/1' }),
      });
      expect(await probe()).toMatchObject({ status: 'failed', prOpened: true });
    });
  }

  test('malformed metadata does not invent PR evidence or discard a known failed status', async () => {
    seed('actual-run', 'failed', { metadata: '{', message: 'no WO text' });
    expect(await probe()).toMatchObject({ status: 'failed', prOpened: false });
  });

  for (const [name, bound] of [
    ['missing', null],
    ['wrong cascade', record({ cascadeId: 'other' })],
    ['wrong WO', record({ woId: 'WO-TEST-010' })],
    ['wrong project', record({ project: 'other' })],
    [
      'dry run',
      record({ request: { woClass: 'CODE', tags: [], entryOverride: null, dryRun: true } }),
    ],
    ['malformed attempts', record({ attempts: null as unknown as CascadeAttempt[] })],
    [
      'null frontier packet',
      record({ frontierApproval: null as unknown as CascadeRunRecord['frontierApproval'] }),
    ],
    [
      'malformed frontier packet',
      record({ frontierApproval: 'invalid' as unknown as CascadeRunRecord['frontierApproval'] }),
    ],
    [
      'missing frontier pointer',
      record({ frontierApproval: {} as CascadeRunRecord['frontierApproval'] }),
    ],
    ['missing actual run identity', record({ attempts: [attempt(null)] })],
    ['malformed run ID', record({ attempts: [attempt(123 as unknown as string)] })],
    [
      'conflicting run binding',
      record({ attempts: [attempt('actual-run'), attempt('actual-run', 'other-workflow')] }),
    ],
  ] as const) {
    test(`${name} is UNKNOWN even when unrelated matching work completed`, async () => {
      seed('actual-run', 'completed');
      seed('unrelated', 'completed');
      await expect(
        probe(bound ? new Map([[identity.cascadeId, bound]]) : new Map())
      ).rejects.toThrow('taskmaster_cascade_evidence_unknown');
    });
  }

  test('legacy missing project is UNKNOWN without WO-only fallback', async () => {
    seed('actual-run', 'completed');
    await expect(
      defaultGetFireRunEvidence(identity.woId, identity.cascadeId, undefined, {
        readCascade: async () => record(),
        query: async <T>(sql: string, params: unknown[] = []) => ({
          rows: db.query(sql).all(...(params as string[])) as T[],
        }),
      })
    ).rejects.toThrow('taskmaster_cascade_evidence_unknown');
  });

  test('a persisted actual run absent from SQL is UNKNOWN, not proven failure', async () => {
    seed('unrelated', 'completed');
    await expect(probe()).rejects.toThrow('taskmaster_cascade_evidence_unknown');
  });

  test('wrong workflow_name under the same run ID is UNKNOWN', async () => {
    seed('actual-run', 'completed', { workflow: 'wrong-workflow' });
    await expect(probe()).rejects.toThrow('taskmaster_cascade_evidence_unknown');
  });

  test('frontier cycles fail closed', async () => {
    seed('actual-run', 'completed');
    const cycle = record({
      frontierApproval: {
        resumeCascadeId: identity.cascadeId,
      } as CascadeRunRecord['frontierApproval'],
    });
    await expect(probe(new Map([[identity.cascadeId, cycle]]))).rejects.toThrow(
      'taskmaster_cascade_evidence_unknown'
    );
  });

  test('frontier traversal has a finite bound', async () => {
    seed('actual-run', 'completed');
    const records = new Map<string, CascadeRunRecord>();
    for (let index = 0; index < 20; index++) {
      const id = index === 0 ? identity.cascadeId : `resume-${index}`;
      records.set(
        id,
        record({
          cascadeId: id,
          frontierApproval: {
            resumeCascadeId: `resume-${index + 1}`,
          } as CascadeRunRecord['frontierApproval'],
        })
      );
    }
    await expect(probe(records)).rejects.toThrow('taskmaster_cascade_evidence_unknown');
  });

  test('record-read errors are sanitized UNKNOWN', async () => {
    await expect(
      defaultGetFireRunEvidence(identity.woId, identity.cascadeId, identity.project, {
        readCascade: async () => {
          throw new Error('synthetic-sensitive-reader-detail');
        },
      })
    ).rejects.toThrow(/^taskmaster_cascade_evidence_unknown$/);
  });

  for (const field of ['cascadeId', 'woId', 'project'] as const) {
    test(`serialized non-string ${field} is UNKNOWN even if corrupt record agrees`, async () => {
      seed('actual-run', 'completed');
      const malformed = { ...identity, [field]: 123 };
      await expect(
        defaultGetFireRunEvidence(
          malformed.woId as string,
          malformed.cascadeId as string,
          malformed.project as string,
          {
            readCascade: async () => record(malformed as Partial<CascadeRunRecord>),
            query: async <T>(sql: string, params: unknown[] = []) => ({
              rows: db.query(sql).all(...(params as string[])) as T[],
            }),
          }
        )
      ).rejects.toThrow('taskmaster_cascade_evidence_unknown');
    });
  }
});
