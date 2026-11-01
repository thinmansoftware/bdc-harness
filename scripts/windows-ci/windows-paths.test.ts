import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { loadWindowsPathPatterns, shouldRunWindows } from './windows-paths';

const repoRoot = join(import.meta.dir, '../..');
const patternsFile = join(repoRoot, '.github/windows-paths.txt');
const workflowFile = join(repoRoot, '.github/workflows/test.yml');
const scriptPath = join(import.meta.dir, 'windows-paths.ts');

const LINUX_ONLY = [
  'packages/server/src/routes/api.ts',
  'packages/web/src/App.tsx',
  'docs/README.md',
];

let fixtureRepo = '';
let baseSha = '';
let headSha = '';

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=windows-ci-test@example.com',
      '-c',
      'user.name=Windows CI Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function classify(args: string[], cwd: string): { exitCode: number | null; stdout: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString();
  return { exitCode: result.exitCode, stdout };
}

function expectRunWindows(args: string[], cwd: string, value: 'true' | 'false'): void {
  const result = classify(args, cwd);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`run_windows=${value}\n`);
}

beforeAll(() => {
  fixtureRepo = mkdtempSync(join(tmpdir(), 'windows-paths-'));
  git(fixtureRepo, ['init']);
  writeFileSync(join(fixtureRepo, 'README'), 'fixture\n');
  git(fixtureRepo, ['add', 'README']);
  git(fixtureRepo, ['commit', '-m', 'init']);
  baseSha = git(fixtureRepo, ['rev-parse', 'HEAD']).trim();
  mkdirSync(join(fixtureRepo, 'packages/server/src'), { recursive: true });
  writeFileSync(join(fixtureRepo, 'packages/server/src/x.ts'), 'export const x = 1;\n');
  git(fixtureRepo, ['add', '.']);
  git(fixtureRepo, ['commit', '-m', 'linux only']);
  headSha = git(fixtureRepo, ['rev-parse', 'HEAD']).trim();
});

afterAll(() => {
  if (fixtureRepo) rmSync(fixtureRepo, { recursive: true, force: true });
});

test('linux-only diff does not start Windows', () => {
  const patterns = loadWindowsPathPatterns(patternsFile);
  expect(shouldRunWindows(LINUX_ONLY, patterns)).toBe(false);
  expect(shouldRunWindows([], patterns)).toBe(false);
  expectRunWindows(['--base', baseSha, '--head', headSha], fixtureRepo, 'false');
});

test('windows-run paths start Windows', () => {
  const patterns = loadWindowsPathPatterns(patternsFile);
  expect(shouldRunWindows(['scripts/dispatch-worker/index.ts'], patterns)).toBe(true);
  expect(shouldRunWindows(['scripts/staging/staging-up.ps1'], patterns)).toBe(true);
  expect(shouldRunWindows(['packages/cli/src/commands/setup.ts'], patterns)).toBe(true);
  expect(shouldRunWindows(['scripts\\dispatch-worker\\index.ts'], patterns)).toBe(true);
});

test('loadWindowsPathPatterns drops blanks and full-line comments', () => {
  const file = join(fixtureRepo, 'patterns.txt');
  writeFileSync(file, '\n# comment\n\npackages/cli/**\n  \n**/*.ps1\n');
  expect(loadWindowsPathPatterns(file)).toEqual(['packages/cli/**', '**/*.ps1']);
});

test('path list covers every production win32 file', () => {
  const output = execFileSync(
    'git',
    [
      'grep',
      '-l',
      '-E',
      '[\'"]win32[\'"]',
      '--',
      'packages/**/*.ts',
      'scripts/**/*.ts',
      ':!*.test.ts',
      ':!**/__tests__/**',
      ':!**/test/**',
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  const files = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !line.endsWith('.test.ts'))
    .filter(line => !line.includes('/__tests__/'))
    .filter(line => !line.split('/').includes('test'));
  expect(files).toContain('packages/workflows/src/dag-executor.ts');
  expect(files).toContain('scripts/dispatch-worker/acp/kill-tree.ts');
  expect(files.length).toBeGreaterThanOrEqual(11);
  const patterns = loadWindowsPathPatterns(patternsFile);
  const uncovered = files.filter(file => !shouldRunWindows([file], patterns));
  expect(uncovered).toEqual([]);
});

test('classifier fails closed without a base, with a bad revision, or with no patterns', () => {
  expectRunWindows(['--head', headSha], fixtureRepo, 'true');
  expectRunWindows(
    ['--base', '0123456789abcdef0123456789abcdef01234567', '--head', headSha],
    fixtureRepo,
    'true'
  );
  const emptyPatterns = join(fixtureRepo, 'empty-patterns.txt');
  writeFileSync(emptyPatterns, '# comment only\n\n');
  expectRunWindows(
    ['--base', baseSha, '--head', headSha, '--patterns', emptyPatterns],
    fixtureRepo,
    'true'
  );
  expectRunWindows(
    ['--base', baseSha, '--head', headSha, '--patterns', join(fixtureRepo, 'missing-patterns.txt')],
    fixtureRepo,
    'true'
  );
});

test('the same base and head classify byte-identically', () => {
  const args = ['--base', baseSha, '--head', headSha];
  const first = classify(args, fixtureRepo);
  const second = classify(args, fixtureRepo);
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(first.stdout).toBe(second.stdout);
  expect(first.stdout).toBe('run_windows=false\n');
});

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  name?: string;
  'runs-on'?: string;
  if?: string;
  needs?: string | string[];
  'timeout-minutes'?: number;
  outputs?: Record<string, string>;
  strategy?: unknown;
  steps?: WorkflowStep[];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function triggersOf(parsed: Record<string, unknown>): Record<string, unknown> {
  if (parsed.on && typeof parsed.on === 'object') return asRecord(parsed.on, 'on');
  if (parsed.true && typeof parsed.true === 'object') return asRecord(parsed.true, 'on');
  throw new Error(`missing workflow triggers: ${Object.keys(parsed).join(',')}`);
}

function job(jobs: Record<string, unknown>, name: string): WorkflowJob {
  return asRecord(jobs[name], name) as WorkflowJob;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function listDispatchTests(dir: string, relative: string, found: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) listDispatchTests(join(dir, entry.name), next, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(next);
  }
}

test('test.yml routes Ubuntu, manual dispatch, schedule, and gated pull requests', () => {
  const raw = readFileSync(workflowFile, 'utf8');
  const parsed = asRecord(Bun.YAML.parse(raw), 'test.yml');
  const triggers = triggersOf(parsed);
  expect(triggers.push).toEqual({ branches: ['main', 'dev'] });
  expect(triggers.pull_request).toEqual({ branches: ['main', 'dev'] });
  expect(triggers.schedule).toEqual([{ cron: '17 7 * * *' }]);
  expect('workflow_dispatch' in triggers).toBe(true);

  const concurrency = asRecord(parsed.concurrency, 'concurrency');
  expect(concurrency.group).toBe(
    '${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}'
  );
  expect(concurrency['cancel-in-progress']).toBe(true);

  const jobs = asRecord(parsed.jobs, 'jobs');
  const ubuntu = job(jobs, 'test');
  const gate = job(jobs, 'windows-gate');
  const windows = job(jobs, 'test-windows');
  const postgres = job(jobs, 'dispatch-phase15-postgres');
  const docker = job(jobs, 'docker-build');

  expect(ubuntu.name).toBe('test (ubuntu-latest)');
  expect(ubuntu['runs-on']).toBe('ubuntu-latest');
  expect(ubuntu.if).toBe("github.event_name != 'schedule'");
  expect(ubuntu.strategy).toBeUndefined();
  expect(postgres.if).toBe("github.event_name != 'schedule'");
  expect(docker.if).toBe("github.event_name != 'schedule'");

  expect(gate.if).toBeUndefined();
  expect(gate['runs-on']).toBe('ubuntu-latest');
  expect(gate.outputs?.run_windows).toBe('${{ steps.classify.outputs.run_windows }}');
  const classify = (gate.steps ?? []).find(step => step.id === 'classify');
  expect(classify?.run).toContain('bun scripts/windows-ci/windows-paths.ts');
  expect(classify?.run).toContain('run_windows=true');
  expect(gate.steps?.[0]?.with?.['fetch-depth']).toBe(0);

  expect(windows.name).toBe('test (windows-latest)');
  expect(windows['runs-on']).toBe('windows-latest');
  expect(windows['timeout-minutes']).toBe(45);
  expect(windows.needs).toBe('windows-gate');
  const windowsIf = normalize(String(windows.if));
  expect(windowsIf).toBe(
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && needs.windows-gate.outputs.run_windows == 'true')"
  );
  expect(windowsIf.includes("github.event_name == 'push'")).toBe(false);

  const admitted = (eventName: string, runWindows: boolean): boolean =>
    eventName === 'schedule' ||
    eventName === 'workflow_dispatch' ||
    (eventName === 'pull_request' && runWindows);
  expect(admitted('push', true)).toBe(false);
  expect(admitted('schedule', false)).toBe(true);
  expect(admitted('workflow_dispatch', false)).toBe(true);
  expect(admitted('pull_request', true)).toBe(true);
  expect(admitted('pull_request', false)).toBe(false);

  for (const current of Object.values(jobs)) {
    expect(asRecord(current, 'job').strategy).toBeUndefined();
  }
  expect(raw.includes('os: [ubuntu-latest, windows-latest]')).toBe(false);
  expect(raw.split('timeout-minutes: 45').length - 1).toBe(1);

  const ubuntuNames = (ubuntu.steps ?? []).map(step => step.name ?? step.uses);
  expect(ubuntuNames).toEqual([
    'actions/checkout@v4',
    'Setup Bun',
    'Install dependencies',
    'Check bundled defaults',
    'Check bundled skill',
    'Type check',
    'Lint',
    'Check formatting',
    'GitHub service command and credential routing regressions',
    'Run tests',
  ]);
  const runTests = (ubuntu.steps ?? []).find(step => step.name === 'Run tests');
  expect(runTests?.run).toBe('bun run test');
  expect(runTests?.if).toBeUndefined();

  const windowsNames = (windows.steps ?? []).map(step => step.name ?? step.uses);
  expect(windowsNames).toEqual([
    'actions/checkout@v4',
    'Setup Bun',
    'Install dependencies',
    'Check bundled defaults',
    'Check bundled skill',
    'GitHub service command and credential routing regressions',
    'Dispatch worker tests (Windows)',
    'Run tests (Windows package-serial)',
  ]);
  expect(windowsNames).not.toContain('Type check');
  expect(windowsNames).not.toContain('Lint');
  expect(windowsNames).not.toContain('Check formatting');

  const regressionPrefix = 'bun test --timeout 30000 ./scripts/github-service-exec.test.ts';
  const regressionSteps = [...(ubuntu.steps ?? []), ...(windows.steps ?? [])].filter(step =>
    (step.run ?? '').includes(regressionPrefix)
  );
  expect(regressionSteps).toHaveLength(2);
  for (const step of regressionSteps) {
    expect(step.run).toContain(
      'packages/overseer/src/__tests__/github-command-durable-metering.test.ts'
    );
    expect(step.run).toContain('./scripts/github-service-login.test.ts');
  }

  const dispatch = (windows.steps ?? []).find(
    step => step.name === 'Dispatch worker tests (Windows)'
  );
  expect(dispatch?.run?.includes('*')).toBe(false);
  expect(dispatch?.run?.startsWith('bun test --timeout 30000 ')).toBe(true);
  const listed = (dispatch?.run ?? '').split(/\s+/).filter(token => token.endsWith('.test.ts'));
  expect(listed.every(token => token.startsWith('./scripts/dispatch-worker/'))).toBe(true);
  const found: string[] = [];
  listDispatchTests(join(repoRoot, 'scripts/dispatch-worker'), 'scripts/dispatch-worker', found);
  expect(listed.map(token => token.slice(2)).sort()).toEqual(found.sort());
  expect(listed).toHaveLength(20);

  const serial = (windows.steps ?? []).find(
    step => step.name === 'Run tests (Windows package-serial)'
  );
  expect(serial?.run).toBe("bun run --sequential --filter '*' test");
  expect((ubuntu.steps ?? []).some(step => step.run === serial?.run)).toBe(false);
});
