import { expect, test } from 'bun:test';
import {
  PLANTED_DEFECT_LITERAL,
  createPlantedDefect,
  runLeg10Revert,
  runLeg4Remediation,
  runLeg5OverseerReapproval,
  runLeg6AutonomousMerge,
  runLeg8DispatchReply,
  runLifecycleCanarySuite,
  type LifecycleCanaryDatabase,
  type LifecycleCanaryDeps,
} from './lifecycle-canary';

function db(rows: unknown[] = []): LifecycleCanaryDatabase {
  return { query: () => ({ all: () => rows, get: () => rows[0] ?? null }) };
}

const base: LifecycleCanaryDeps = {
  runId: 'lifecycle-fixture',
  apiBase: 'http://127.0.0.1:3090',
  codebaseId: 'codebase-1',
  githubRepo: 'thinmansoftware/bdc-harness',
  githubIssue: 42,
  db: db([{ id: 'journal-1', created_at: '2026-09-02T00:00:01Z' }]),
  now: () => Date.parse('2026-09-02T00:00:00Z'),
  prNumber: 99,
  remediationSha: 'fixed-sha',
  remediationCommittedAt: '2026-09-02T00:01:00Z',
  preRemediationCommitCount: 1,
  dispatchMessageId: 'dispatch-1',
  command: async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    if (key.includes('pr list'))
      return {
        stdout: JSON.stringify([
          {
            number: 99,
            headRefName: 'canary/lifecycle-lifecycle-fixture',
            baseRefName: 'dev',
            state: 'OPEN',
          },
        ]),
      };
    if (key.includes('/reviews'))
      return {
        stdout: JSON.stringify([
          {
            state: 'CHANGES_REQUESTED',
            body: PLANTED_DEFECT_LITERAL,
            submitted_at: '2026-09-02T00:00:30Z',
          },
          { state: 'APPROVED', submitted_at: '2026-09-02T00:02:00Z' },
        ]),
      };
    if (key.includes('pr view') && key.includes('commits'))
      return { stdout: JSON.stringify({ commits: [{ oid: 'bad' }, { oid: 'fixed-sha' }] }) };
    if (key.includes('pr diff')) return { stdout: '- WRONG_VALUE\n+ lifecycle-fixture' };
    if (key.includes('pr view') && key.includes('mergedBy'))
      return {
        stdout: JSON.stringify({
          state: 'MERGED',
          mergedBy: { login: 'bluedevilcollectibles' },
          mergeCommit: { oid: 'merge-sha' },
          files: [
            { path: '.archon/canaries/lifecycle-scratch/canary-marker-lifecycle-fixture.ts' },
          ],
        }),
      };
    if (key.includes('issue view'))
      return { stdout: JSON.stringify({ state: 'CLOSED', stateReason: 'COMPLETED' }) };
    if (key.includes('ls-tree')) return { stdout: '' };
    return { stdout: '' };
  },
};

test('planted defect is literal, greppable, and run-specific', () => {
  const source = createPlantedDefect('run-123');
  expect(source).toContain('run-123');
  expect(source).toContain(`"${PLANTED_DEFECT_LITERAL}"`);
});

test('Taskmaster no-fire does not prevent the remaining legs from executing', async () => {
  const report = await runLifecycleCanarySuite({ ...base, db: db([]) });
  expect(report.legs).toHaveLength(10);
  expect(report.legs[0]?.reasonCodes).toEqual(['taskmaster_never_fires']);
  expect(
    report.legs.slice(1).every(leg => !leg.reasonCodes.includes('fallback_requires_operator'))
  ).toBe(true);
  expect(report.legs[1]?.evidenceRefs).toContain('pr.number=99');
});

test('full orchestration reports all ten legs with injected artifact evidence', async () => {
  const dutyPath = `${import.meta.dir}/lifecycle-canary.test.ts`;
  const report = await runLifecycleCanarySuite({
    ...base,
    dutyOfficerArtifact: dutyPath,
    runId: 'LifecycleCanaryDeps',
    db: db([
      {
        id: 'evidence-1',
        created_at: '2026-09-02T00:00:01Z',
        result_body: 'LifecycleCanaryDeps readable reply',
      },
    ]),
  });
  expect(report.legs).toHaveLength(10);
  expect(report.legs.map(leg => leg.verdict)).toEqual(Array(10).fill('passed'));
  expect(report.legs.every(leg => leg.evidenceRefs.length > 0)).toBe(true);
  expect(report.legs.map(leg => leg.leg)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Leg 2 discovered PR number is chained into later legs', async () => {
  const reviewPaths: string[] = [];
  await runLifecycleCanarySuite({
    ...base,
    prNumber: undefined,
    command: async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      if (key.includes('pr list'))
        return {
          stdout: JSON.stringify([
            {
              number: 123,
              headRefName: 'canary/lifecycle-lifecycle-fixture',
              baseRefName: 'dev',
              state: 'OPEN',
            },
          ]),
        };
      if (key.includes('/reviews')) {
        reviewPaths.push(key);
        return { stdout: '[]' };
      }
      if (key.includes('pr view') && key.includes('commits'))
        return { stdout: JSON.stringify({ commits: [{ oid: 'a' }, { oid: 'b' }] }) };
      if (key.includes('pr view')) return { stdout: '{}' };
      return { stdout: '' };
    },
  });
  expect(reviewPaths.every(path => path.includes('/pulls/123/reviews'))).toBe(true);
  expect(reviewPaths.length).toBeGreaterThan(0);
});

test('GitHub commands receive the supplied operator token', async () => {
  const observed: Array<Readonly<Record<string, string>> | undefined> = [];
  await runLifecycleCanarySuite({
    ...base,
    operatorToken: 'operator-token',
    command: async (_file, args, options) => {
      observed.push(options?.env);
      if (args.includes('list')) return { stdout: '[]' };
      if (args.includes('ls-tree')) return { stdout: '' };
      return { stdout: '[]' };
    },
  });
  expect(observed.some(env => env?.GH_TOKEN === 'operator-token')).toBe(true);
});

test('remediation requires the commit count to increase from its baseline', async () => {
  const leg = await runLeg4Remediation({
    ...base,
    command: async (_file, args) =>
      args.includes('view')
        ? { stdout: JSON.stringify({ commits: [{ oid: 'unchanged' }] }) }
        : { stdout: 'fixed content' },
  });
  expect(leg.verdict).toBe('blocked');
  expect(leg.evidenceRefs).toContain('commit_count_increased=false');
});

test('review trigger query uses the proven dispatch body column', async () => {
  const queries: string[] = [];
  await runLeg5OverseerReapproval({
    ...base,
    db: {
      query: sql => {
        queries.push(sql);
        return { all: () => [], get: () => null };
      },
    },
  });
  expect(queries[0]).toContain("task_type='run_review'");
  expect(queries[0]).toContain('body LIKE ?');
  expect(queries[0]).not.toContain('payload_json');
});

test('scope invariant fails closed before accepting a merge', async () => {
  const leg = await runLeg6AutonomousMerge({
    ...base,
    command: async () => ({
      stdout: JSON.stringify({
        state: 'MERGED',
        mergedBy: { login: 'bluedevilcollectibles' },
        mergeCommit: { oid: 'x' },
        files: [{ path: 'packages/server/src/index.ts' }],
      }),
    }),
  });
  expect(leg.reasonCodes).toEqual(['canary_diff_scope_violation']);
});

test('dispatch rejects a hash-only placeholder', async () => {
  const leg = await runLeg8DispatchReply({
    ...base,
    db: db([{ result_body: `sha256:${'a'.repeat(64)}` }]),
  });
  expect(leg.reasonCodes).toEqual(['dispatch_reply_unreadable']);
});

test('negative cleanup scenario detects residue on dev', async () => {
  const leg = await runLeg10Revert({
    ...base,
    command: async () => ({
      stdout: '.archon/canaries/lifecycle-scratch/canary-marker-lifecycle-fixture.ts\n',
    }),
  });
  expect(leg.verdict).toBe('failed');
  expect(leg.reasonCodes).toEqual(['canary_left_residue_on_dev']);
});

test('cleanup does not claim a pre-run blob comparison when none was supplied', async () => {
  const leg = await runLeg10Revert({ ...base, preRunBlob: undefined });
  expect(leg.verdict).toBe('passed');
  expect(leg.evidenceRefs).toContain('pre_run_blob_check=not_applicable');
  expect(leg.evidenceRefs).not.toContain('pre_run_blob_match=true');
});
