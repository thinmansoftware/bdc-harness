import { beforeEach, expect, test } from 'bun:test';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import {
  inMemoryAttemptCounterStore,
  resetRequiredContextsAttemptCounters,
  resetRequiredContextsCache,
} from '../adapters/required-contexts.ts';
import { latestAttemptPerCheck } from '../pr-review-check-ingest.ts';
import {
  applyRequiredCheckGate,
  buildReviewPrompt,
  evaluatePullRequest,
  partitionChecksByRequired,
  type PrReviewCheck,
  type PrReviewDeps,
  type PrReviewInput,
} from '../pr-review-evaluator.ts';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = ['docker-build', 'test (ubuntu-latest)'];
const input: PrReviewInput = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  pr_number: 1187,
  head_sha: HEAD,
};

const passingRequired: PrReviewCheck[] = [
  { name: 'docker-build', status: 'completed', conclusion: 'success' },
  { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'success' },
];
const windowsFailure: PrReviewCheck = {
  name: 'test (windows-latest)',
  status: 'completed',
  conclusion: 'failure',
};

function modelOutput(verdict: 'APPROVE' | 'REQUEST_CHANGES', findings: unknown[] = []): string {
  return JSON.stringify({ verdict, findings, reviewed_head_sha: HEAD });
}

function deps(
  checks: PrReviewCheck[],
  stdout: string,
  requiredContexts: string[] | null | undefined
): PrReviewDeps {
  return {
    reviewer: { provider: 'test', model: 'judge' },
    fetchEvidence: async () => ({ diff: '+ safe', checks, requiredContexts }),
    fetchAcceptanceCriteria: async () => null,
    invokeModel: async () => ({ exitCode: 0, timedOut: false, stdout }),
    ladder: ['judge'],
  };
}

beforeEach(() => {
  resetRequiredContextsAttemptCounters();
  resetRequiredContextsCache();
});

test('non_required_failure_approves_with_note', async () => {
  const checks = [...passingRequired, windowsFailure];
  const major = {
    scope: 'checks/test (windows-latest)',
    severity: 'major',
    summary: 'failed',
  };
  const results = await Promise.all([
    evaluatePullRequest(input, deps(checks, modelOutput('REQUEST_CHANGES', [major]), REQUIRED)),
    evaluatePullRequest(input, deps(checks, modelOutput('APPROVE'), REQUIRED)),
  ]);
  for (const result of results) {
    expect(result.verdict).toBe('APPROVE');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.scope).toBe('checks/test (windows-latest)');
    expect(result.findings[0]?.severity).toBe('note');
    expect(result.findings[0]?.summary).toContain('not a required check');
    expect(result.findings[0]?.summary).toContain('non-blocking');
    expect(result.findings.some(f => f.severity === 'blocker' || f.severity === 'major')).toBe(
      false
    );
  }
});

test('required_failure_still_blocks', async () => {
  const checks = [
    { name: 'docker-build', status: 'completed', conclusion: 'success' },
    { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'failure' },
    { name: 'test (windows-latest)', status: 'completed', conclusion: 'success' },
  ];
  const result = await evaluatePullRequest(input, deps(checks, modelOutput('APPROVE'), REQUIRED));
  expect(result.verdict).toBe('REQUEST_CHANGES');
  expect(result.findings).toContainEqual({
    scope: 'checks/test (ubuntu-latest)',
    severity: 'major',
    summary: 'Required check test (ubuntu-latest) failed.',
  });
});

test('same-named failures from different apps emit one finding per check scope', async () => {
  const variants = (name: string): PrReviewCheck[] => [
    {
      id: 1,
      name,
      status: 'completed',
      conclusion: 'failure',
      app: { slug: 'github-actions' },
    },
    {
      id: 2,
      name,
      status: 'completed',
      conclusion: 'failure',
      app: { slug: 'buildkite' },
    },
  ];
  const checks = [
    ...variants('test (ubuntu-latest)'),
    ...variants('test (windows-latest)'),
    { name: 'docker-build', status: 'completed', conclusion: 'success' },
  ];
  const result = await evaluatePullRequest(input, deps(checks, modelOutput('APPROVE'), REQUIRED));

  expect(result.verdict).toBe('REQUEST_CHANGES');
  expect(result.findings.filter(f => f.scope === 'checks/test (ubuntu-latest)')).toHaveLength(1);
  expect(result.findings.filter(f => f.scope === 'checks/test (windows-latest)')).toHaveLength(1);
  expect(result.findings.find(f => f.scope.includes('ubuntu'))?.severity).toBe('major');
  expect(result.findings.find(f => f.scope.includes('windows'))?.severity).toBe('note');
});

test('superseded_failed_attempt_then_success_counts_as_success', async () => {
  const attempts = (name: string): PrReviewCheck[] => [
    {
      id: 1,
      name,
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-10-20T11:30:00Z',
      app: { slug: 'github-actions' },
    },
    {
      id: 2,
      name,
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-10-20T11:50:00Z',
      app: { slug: 'github-actions' },
    },
  ];
  const checks = [
    ...attempts('test (ubuntu-latest)'),
    ...attempts('test (windows-latest)'),
    { name: 'docker-build', status: 'completed', conclusion: 'success' },
  ];
  const partition = partitionChecksByRequired(checks, REQUIRED);
  expect([...partition.gating, ...partition.nonRequired]).toHaveLength(3);
  expect(
    [...partition.gating, ...partition.nonRequired].every(c => c.conclusion === 'success')
  ).toBe(true);
  const result = await evaluatePullRequest(
    input,
    deps(
      checks,
      modelOutput('REQUEST_CHANGES', [
        { scope: 'checks/test (windows-latest)', severity: 'major', summary: 'failed' },
      ]),
      REQUIRED
    )
  );
  expect(result.verdict).toBe('APPROVE');
  expect(result.findings.filter(f => f.scope.includes('test ('))).toEqual([]);
});

test('prompt_separates_required_from_non_required', () => {
  const partition = partitionChecksByRequired([...passingRequired, windowsFailure], REQUIRED);
  const prompt = buildReviewPrompt({
    request: input,
    diff: '+ safe',
    checkPartition: partition,
    acceptanceCriteria: null,
  });
  const requiredLine = prompt.split('\n').find(line => line.startsWith('Required checks')) ?? '';
  const informationalLine =
    prompt.split('\n').find(line => line.startsWith('Non-required checks')) ?? '';
  expect(requiredLine).toContain('docker-build');
  expect(requiredLine).toContain('test (ubuntu-latest)');
  expect(requiredLine).not.toContain('test (windows-latest)');
  expect(informationalLine).toContain('test (windows-latest)');
  expect(informationalLine).not.toContain('docker-build');
  expect(informationalLine).not.toContain('test (ubuntu-latest)');
  expect(prompt).not.toContain('Never approve when checks fail');
});

test('code_finding_kept_and_gate_is_idempotent', async () => {
  const checks = [...passingRequired, windowsFailure];
  const result = await evaluatePullRequest(
    input,
    deps(
      checks,
      modelOutput('REQUEST_CHANGES', [
        { scope: 'packages/overseer/src/x.ts', severity: 'major', summary: 'bug' },
        { scope: 'checks/test (windows-latest)', severity: 'major', summary: 'failed' },
      ]),
      REQUIRED
    )
  );
  expect(result.verdict).toBe('REQUEST_CHANGES');
  expect(result.findings).toContainEqual({
    scope: 'packages/overseer/src/x.ts',
    severity: 'major',
    summary: 'bug',
  });
  expect(result.findings.find(f => f.scope.includes('windows'))?.severity).toBe('note');
  expect(applyRequiredCheckGate(result, partitionChecksByRequired(checks, REQUIRED))).toEqual(
    result
  );
});

test('unreported_check_finding_cannot_block_passing_required_checks', async () => {
  const result = await evaluatePullRequest(
    input,
    deps(
      passingRequired,
      modelOutput('REQUEST_CHANGES', [
        { scope: 'checks/invented-check', severity: 'major', summary: 'failed' },
      ]),
      REQUIRED
    )
  );

  expect(result.verdict).toBe('APPROVE');
  expect(result.findings).toEqual([]);
});

test('no_required_set_keeps_todays_behavior', async () => {
  const checks = [{ name: 'test', status: 'completed', conclusion: 'failure' }];
  const result = await evaluatePullRequest(input, deps(checks, modelOutput('APPROVE'), undefined));
  expect(result.verdict).toBe('REQUEST_CHANGES');
  expect(result.findings).toContainEqual({
    scope: 'checks/test',
    severity: 'major',
    summary: 'Required check test failed.',
  });
  const unknown = await evaluatePullRequest(input, deps(checks, modelOutput('APPROVE'), null));
  expect(unknown.verdict).toBe('CHECKS_PENDING');
});

test('adapter_carries_attempt_fields', async () => {
  const octokit = {
    pulls: {
      get: async () => ({ data: { head: { sha: HEAD }, base: { sha: BASE, ref: 'dev' } } }),
    },
    repos: {
      compareCommits: async () => ({ data: { files: [] } }),
      getAllStatusCheckContexts: async () => ({ data: REQUIRED }),
    },
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: [
            {
              id: 1,
              name: 'test (windows-latest)',
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-10-20T11:20:00Z',
              completed_at: '2026-10-20T11:30:00Z',
              app: { slug: 'github-actions' },
            },
            {
              id: 2,
              name: 'test (windows-latest)',
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-10-20T11:40:00Z',
              completed_at: '2026-10-20T11:50:00Z',
              app: { slug: 'github-actions' },
            },
          ],
        },
      }),
    },
  } as unknown as RealGitHubOctokitLike;
  const evidence = await createRealFetchExactHeadPullRequestEvidence(
    octokit,
    undefined,
    inMemoryAttemptCounterStore
  )({ owner: input.owner, repo: input.repo, prNumber: input.pr_number, headSha: HEAD });
  expect(evidence.checks.map(check => check.id)).toEqual([1, 2]);
  expect(evidence.checks.map(check => check.completed_at)).toEqual([
    '2026-10-20T11:30:00Z',
    '2026-10-20T11:50:00Z',
  ]);
  expect(evidence.checks.every(check => check.app?.slug === 'github-actions')).toBe(true);
  expect(latestAttemptPerCheck(evidence.checks).map(check => check.id)).toEqual([2]);
});
