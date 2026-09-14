import { expect, mock, test } from 'bun:test';
import { runCanaryCli } from './cli';
import type { CanaryReport, RunCanaryResult } from './types';
import type { TaskmasterCanaryResult } from './taskmaster-canary';
import type { OutcomeCanaryResult } from './outcome-canary';

const baseReport: CanaryReport = {
  schemaVersion: 1,
  suiteRunId: 'suite-fixture-001',
  level: 1,
  generatedAt: '2026-07-10T12:00:00.000Z',
  requestId: `sha256:${'a'.repeat(64)}`,
  verdict: 'static_only',
  reasonCodes: [],
  evidenceRefs: [],
  lanes: [],
};

const args = [
  'plan',
  '--manifest',
  'manifest.yaml',
  '--api-base',
  'http://127.0.0.1:3090',
  '--codebase-id',
  'codebase-1',
  '--output-root',
  'artifacts',
];

test('fails before runner/network access when the token is missing', async () => {
  const runner = mock(async () => ({}) as RunCanaryResult);
  const stderr: string[] = [];
  const exit = await runCanaryCli(
    args,
    {},
    { runner, stdout: () => {}, stderr: value => stderr.push(value) }
  );
  expect(exit).toBe(3);
  expect(runner).not.toHaveBeenCalled();
  expect(stderr.join('\n')).toContain('ARCHON_OPERATOR_TOKEN');
});

test.each([
  ['passed', 0],
  ['probe_passed', 0],
  ['failed', 2],
  ['probe_failed', 2],
  ['build_failed', 2],
  ['blocked', 3],
  ['aborted', 4],
  ['static_only', 5],
] as const)('maps %s to exit %d and never prints the token', async (verdict, expectedExit) => {
  const token = 'fixture-secret-token';
  const output: string[] = [];
  const runner = mock(async () => ({
    report: { ...baseReport, verdict },
    plan: {} as RunCanaryResult['plan'],
    artifactPaths: [],
  }));
  const exit = await runCanaryCli(
    [...args, '--json'],
    { ARCHON_OPERATOR_TOKEN: token },
    {
      runner,
      stdout: value => output.push(value),
      stderr: value => output.push(value),
    }
  );
  expect(exit).toBe(expectedExit);
  expect(output.join('\n')).not.toContain(token);
  expect(output.join('\n')).toContain(`"verdict": "${verdict}"`);
});

const taskmasterArgs = [
  'taskmaster',
  '--db-path',
  'archon.db',
  '--status-url',
  'http://127.0.0.1:3090/api/taskmaster/status',
  '--github-repo',
  'thinmansoftware/bdc-xo',
  '--github-issue',
  '777',
  '--output-root',
  'artifacts',
];

const taskmasterReport: TaskmasterCanaryResult = {
  verdict: 'passed',
  reasonCodes: [],
  evidenceRefs: ['fixture'],
};

function taskmasterDeps(report: TaskmasterCanaryResult = taskmasterReport) {
  return {
    runner: mock(async () => ({}) as RunCanaryResult),
    taskmasterRunner: mock(async () => report),
    taskmasterArtifactWriter: mock(async () => ['artifacts/taskmaster-fixture/summary.json']),
    stdout: mock(() => {}),
    stderr: mock(() => {}),
  };
}

test.each([
  ['--db-path', ''],
  ['--status-url', ''],
  ['--github-repo', ''],
  ['--github-issue', 'not-a-number'],
  ['--github-issue', '0'],
  ['--interval-ms', '-1'],
  ['--interval-ms', 'not-a-number'],
  ['--output-root', ''],
] as const)('taskmaster rejects invalid %s before running checks', async (name, value) => {
  const deps = taskmasterDeps();
  const index = taskmasterArgs.indexOf(name);
  const invocation =
    index >= 0
      ? taskmasterArgs.map((argument, argumentIndex) =>
          argumentIndex === index + 1 ? value : argument
        )
      : [...taskmasterArgs, name, value];

  expect(await runCanaryCli(invocation, {}, deps)).toBe(3);
  expect(deps.taskmasterRunner).not.toHaveBeenCalled();
  expect(deps.taskmasterArtifactWriter).not.toHaveBeenCalled();
  expect(deps.stderr).toHaveBeenCalledWith(
    'taskmaster_canary_missing_or_invalid_required_argument'
  );
});

test('taskmaster accepts TASKMASTER_INTERVAL_MS=0 and wires token and artifacts', async () => {
  const deps = taskmasterDeps();
  const exit = await runCanaryCli(
    taskmasterArgs,
    { TASKMASTER_INTERVAL_MS: '0', ARCHON_OPERATOR_TOKEN: 'operator-token' },
    deps
  );

  expect(exit).toBe(0);
  expect(deps.taskmasterRunner).toHaveBeenCalledWith({
    dbPath: 'archon.db',
    statusUrl: 'http://127.0.0.1:3090/api/taskmaster/status',
    githubRepo: 'thinmansoftware/bdc-xo',
    githubIssue: 777,
    intervalMs: 0,
    operatorToken: 'operator-token',
  });
  expect(deps.taskmasterArtifactWriter).toHaveBeenCalledWith('artifacts', taskmasterReport);
  expect(deps.stdout).toHaveBeenCalledWith(JSON.stringify(taskmasterReport, null, 2));
});

test('taskmaster maps a failed report to exit 2 after writing its artifact', async () => {
  const failedReport: TaskmasterCanaryResult = {
    verdict: 'failed',
    reasonCodes: ['tick_heartbeat_stale'],
    evidenceRefs: [],
  };
  const deps = taskmasterDeps(failedReport);

  expect(await runCanaryCli([...taskmasterArgs, '--interval-ms', '60000'], {}, deps)).toBe(2);
  expect(deps.taskmasterArtifactWriter).toHaveBeenCalledWith('artifacts', failedReport);
});

const prReviewArgs = ['pr-review', '--db-path', 'archon.db', '--output-root', 'artifacts'];

const prReviewReport: OutcomeCanaryResult = {
  verdict: 'passed',
  reasonCodes: [],
  evidenceRefs: ['fixture'],
};

function prReviewDeps(report: OutcomeCanaryResult = prReviewReport) {
  return {
    runner: mock(async () => ({}) as RunCanaryResult),
    prReviewRunner: mock(async () => report),
    prReviewArtifactWriter: mock(async () => ['artifacts/pr-review-fixture/summary.json']),
    stdout: mock(() => {}),
    stderr: mock(() => {}),
  };
}

test.each([
  ['--db-path', ''],
  ['--output-root', ''],
  ['--pr-number', '0'],
  ['--pr-number', 'not-a-number'],
] as const)('pr-review rejects invalid %s before running checks', async (name, value) => {
  const deps = prReviewDeps();
  const index = prReviewArgs.indexOf(name);
  const invocation =
    index >= 0
      ? prReviewArgs.map((argument, argumentIndex) =>
          argumentIndex === index + 1 ? value : argument
        )
      : [...prReviewArgs, name, value];

  expect(await runCanaryCli(invocation, {}, deps)).toBe(3);
  expect(deps.prReviewRunner).not.toHaveBeenCalled();
  expect(deps.prReviewArtifactWriter).not.toHaveBeenCalled();
  expect(deps.stderr).toHaveBeenCalledWith('pr_review_canary_missing_or_invalid_required_argument');
});

test('pr-review wires token, api-base, and artifacts', async () => {
  const deps = prReviewDeps();
  const exit = await runCanaryCli(
    [
      ...prReviewArgs,
      '--api-base',
      'http://127.0.0.1:3090',
      '--owner',
      'thinmansoftware',
      '--repo',
      'bdc-harness',
      '--pr-number',
      '806',
      '--head-sha',
      'a'.repeat(40),
      '--branch',
      'dev',
    ],
    { ARCHON_OPERATOR_TOKEN: 'operator-token' },
    deps
  );

  expect(exit).toBe(0);
  expect(deps.prReviewRunner).toHaveBeenCalledWith({
    dbPath: 'archon.db',
    operatorToken: 'operator-token',
    statusUrl: 'http://127.0.0.1:3090/api/overseer/pr-review/status',
    requestUrl: 'http://127.0.0.1:3090/api/overseer/pr-review/request',
    queueUrl: 'http://127.0.0.1:3090/api/overseer/pr-review/queue',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    branch: 'dev',
    headSha: 'a'.repeat(40),
    prNumber: 806,
  });
  expect(deps.prReviewArtifactWriter).toHaveBeenCalledWith('artifacts', prReviewReport);
  expect(deps.stdout).toHaveBeenCalledWith(JSON.stringify(prReviewReport, null, 2));
});

test('pr-review maps a failed report to exit 2 after writing its artifact', async () => {
  const failedReport: OutcomeCanaryResult = {
    verdict: 'failed',
    reasonCodes: ['c1_budget_exhausted_on_converging_pr'],
    evidenceRefs: [],
  };
  const deps = prReviewDeps(failedReport);

  expect(await runCanaryCli(prReviewArgs, {}, deps)).toBe(2);
  expect(deps.prReviewArtifactWriter).toHaveBeenCalledWith('artifacts', failedReport);
});
