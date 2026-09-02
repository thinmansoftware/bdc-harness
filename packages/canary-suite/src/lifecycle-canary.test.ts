import { expect, test } from 'bun:test';
import {
  PLANTED_DEFECT_LITERAL,
  createPlantedDefect,
  runLeg10Revert,
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

test('Taskmaster no-fire is blocked and every remaining leg is explicitly reported', async () => {
  const report = await runLifecycleCanarySuite({ ...base, db: db([]) });
  expect(report.legs).toHaveLength(10);
  expect(report.legs[0]?.reasonCodes).toEqual(['taskmaster_never_fires']);
  expect(
    report.legs.slice(1).every(leg => leg.reasonCodes[0] === 'fallback_requires_operator')
  ).toBe(true);
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
  expect(report.legs.every(leg => leg.evidenceRefs.length > 0)).toBe(true);
  expect(report.legs.map(leg => leg.leg)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
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
