import { expect, mock, test } from 'bun:test';
import { runCanaryCli } from './cli';
import type { CanaryReport, RunCanaryResult } from './types';
import type { TaskmasterCanaryResult } from './taskmaster-canary';
import type { LifecycleCanaryResult } from './lifecycle-canary';

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

const lifecycleArgs = [
  'lifecycle',
  '--api-base',
  'http://127.0.0.1:3090',
  '--codebase-id',
  'codebase-1',
  '--run-id',
  'run-1',
  '--output-root',
  'artifacts',
  '--db-path',
  'archon.db',
  '--github-issue',
  '42',
];
const lifecycleReport: LifecycleCanaryResult = {
  schemaVersion: 1,
  runId: 'run-1',
  startedAt: '2026-09-02T00:00:00Z',
  generatedAt: '2026-09-02T00:01:00Z',
  verdict: 'passed',
  reasonCodes: [],
  evidenceRefs: [],
  legs: [],
};

function lifecycleDeps(report: LifecycleCanaryResult = lifecycleReport) {
  return {
    runner: mock(async () => ({}) as RunCanaryResult),
    lifecycleRunner: mock(async () => report),
    lifecycleArtifactWriter: mock(async () => ['artifacts/run-1/summary.md']),
    stdout: mock(() => {}),
    stderr: mock(() => {}),
  };
}

test.each([
  '--api-base',
  '--codebase-id',
  '--run-id',
  '--output-root',
  '--db-path',
  '--github-issue',
] as const)('lifecycle rejects missing %s before network or DB access', async name => {
  const deps = lifecycleDeps();
  const index = lifecycleArgs.indexOf(name);
  const invocation = lifecycleArgs.filter((_, item) => item !== index && item !== index + 1);
  expect(await runCanaryCli(invocation, { ARCHON_OPERATOR_TOKEN: 'token' }, deps)).toBe(3);
  expect(deps.lifecycleRunner).not.toHaveBeenCalled();
});

test.each([
  ['passed', 0],
  ['failed', 2],
  ['blocked', 3],
  ['aborted', 4],
] as const)(
  'lifecycle maps %s to exit %d and never prints its token',
  async (verdict, expected) => {
    const token = 'lifecycle-secret';
    const deps = lifecycleDeps({ ...lifecycleReport, verdict });
    expect(await runCanaryCli(lifecycleArgs, { ARCHON_OPERATOR_TOKEN: token }, deps)).toBe(
      expected
    );
    expect(JSON.stringify(deps.stdout.mock.calls)).not.toContain(token);
    expect(deps.lifecycleArtifactWriter).toHaveBeenCalled();
  }
);
