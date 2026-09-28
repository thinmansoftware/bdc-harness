import { expect, mock, test } from 'bun:test';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { runCanaryCli } from './cli';
import type { CanaryReport, RunCanaryResult } from './types';
import type { TaskmasterCanaryResult } from './taskmaster-canary';

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

const probeBindingArgs = [
  'probe-binding',
  '--provider',
  'fixture-provider',
  '--model',
  'fixture-model',
];

function probeCliDeps(behavior: MessageChunk[] | Error) {
  const seen: { providerId?: string; cwd?: string; model?: unknown } = {};
  const getAgentProvider = mock((providerId: string): IAgentProvider => {
    seen.providerId = providerId;
    return {
      getType: () => 'claude',
      getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
      async *sendQuery(
        _prompt: string,
        cwd: string,
        _resume?: string,
        options?: { model?: string }
      ) {
        seen.cwd = cwd;
        seen.model = options?.model;
        if (behavior instanceof Error) throw behavior;
        for (const chunk of behavior) yield chunk;
      },
    };
  });
  return {
    seen,
    runner: mock(async () => ({}) as RunCanaryResult),
    stdout: mock(() => {}),
    stderr: mock(() => {}),
    probeBinding: {
      getAgentProvider,
      sleep: async () => {},
      cwd: '/tmp/probe-binding-cli',
    },
  };
}

test('probe-binding dispatches injected deps to stdout and exit 0', async () => {
  const deps = probeCliDeps([{ type: 'assistant', content: 'OK' }]);
  const exit = await runCanaryCli(probeBindingArgs, {}, deps);

  expect(exit).toBe(0);
  expect(deps.runner).not.toHaveBeenCalled();
  expect(deps.seen.providerId).toBe('fixture-provider');
  expect(deps.seen.model).toBe('fixture-model');
  expect(deps.seen.cwd).toBe('/tmp/probe-binding-cli');
  expect(deps.stdout).toHaveBeenCalledWith('ok');
  expect(deps.stderr).not.toHaveBeenCalled();
});

test('probe-binding routes a failed probe to stderr and exit 2', async () => {
  const deps = probeCliDeps(Object.assign(new Error('authentication failed'), { httpStatus: 401 }));
  const exit = await runCanaryCli(probeBindingArgs, {}, deps);

  expect(exit).toBe(2);
  expect(deps.runner).not.toHaveBeenCalled();
  expect(deps.stdout).not.toHaveBeenCalled();
  expect(deps.stderr).toHaveBeenCalledTimes(1);
  expect(String(deps.stderr.mock.calls[0]?.[0])).toContain('unknown_400');
});

test('probe-binding rejects missing arguments on stderr before calling the provider', async () => {
  const deps = probeCliDeps([{ type: 'assistant', content: 'OK' }]);
  const exit = await runCanaryCli(['probe-binding', '--provider', 'fixture-provider'], {}, deps);

  expect(exit).toBe(2);
  expect(deps.probeBinding.getAgentProvider).not.toHaveBeenCalled();
  expect(deps.stdout).not.toHaveBeenCalled();
  expect(deps.stderr).toHaveBeenCalledWith('probe_binding_missing_required_argument');
});

test('probe-binding uses default deps when probeBinding is omitted', async () => {
  const runner = mock(async () => ({}) as RunCanaryResult);
  const stdout = mock(() => {});
  const stderr = mock(() => {});
  const exit = await runCanaryCli(['probe-binding'], {}, { runner, stdout, stderr });

  expect(exit).toBe(2);
  expect(runner).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith('probe_binding_missing_required_argument');
});
