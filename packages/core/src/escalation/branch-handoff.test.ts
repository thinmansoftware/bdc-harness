/**
 * Tests 1-12 for WO-HARNESS-ESCALATION-BRANCH-HANDOFF-01.
 * Real temporary git repositories. No mock.module.
 */

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  evaluateHandoffHeadPrecondition,
  formatHandoffLines,
  listPredecessorRuns,
  normalizeOriginUrl,
  recordPushEvidence,
  releasePredecessorBranchHolds,
  REPAIR_HEAD_RULE,
  type EscalationLinkerStore,
  type GitRunResult,
  type GitRunner,
  type HandoffRecord,
  type PushEvidence,
} from './branch-handoff';

const PIN_HEAD = 'd800f8f8d800f8f8d800f8f8d800f8f8d800f8f8';
const HANDOFF_HEAD = '8c64aec68c64aec68c64aec68c64aec68c64aec6';
const THIRD_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const RULE =
  'Repair-head rule: accept the live remote head only when it equals the pinned head or the pushed_head of an ESCALATION_HANDOFF line whose run, repository, and branch match that predecessor evidence; otherwise fail closed with unexplained_head_change. remote_head never authorizes a head.';
const RECORDED_AT = '2026-09-28T20:01:29.000Z';

const roots: string[] = [];

afterAll((): void => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface GitText {
  code: number;
  stdout: string;
  stderr: string;
}

function gitText(cwd: string, args: readonly string[]): GitText {
  const fullArgs = [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Handoff Test',
    '-c',
    'user.email=handoff@example.com',
    ...args,
  ];
  try {
    const stdout = execFileSync('git', fullArgs, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Handoff Test',
        GIT_AUTHOR_EMAIL: 'handoff@example.com',
        GIT_COMMITTER_NAME: 'Handoff Test',
        GIT_COMMITTER_EMAIL: 'handoff@example.com',
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : (err.message ?? ''),
    };
  }
}

function git(cwd: string, args: readonly string[]): string {
  const result = gitText(cwd, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function gitTrim(cwd: string, args: readonly string[]): string {
  return git(cwd, args).trim();
}

function execGit(args: readonly string[]): Promise<GitRunResult> {
  return new Promise(resolveResult => {
    execFile(
      'git',
      [...args],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errText = typeof stderr === 'string' ? stderr : '';
        if (error) {
          const code =
            typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
          resolveResult({ stdout: out, stderr: errText, code });
          return;
        }
        resolveResult({ stdout: out, stderr: errText, code: 0 });
      }
    );
  });
}

interface Fixture {
  root: string;
  origin: string;
  clone: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, ['init', '--bare', '-b', 'main', origin]);
  git(root, ['init', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), 'seed\n');
  git(clone, ['add', 'README']);
  git(clone, ['commit', '-m', 'seed']);
  git(clone, ['remote', 'add', 'origin', origin]);
  git(clone, ['push', '-u', 'origin', 'HEAD']);
  return { root, origin, clone };
}

function addWorktree(clone: string, root: string, name: string, branch: string): string {
  const dest = join(root, name);
  git(clone, ['worktree', 'add', '-b', branch, dest, 'HEAD']);
  return dest;
}

function commitFile(cwd: string, name: string, content: string, message: string): string {
  writeFileSync(join(cwd, name), content);
  git(cwd, ['add', name]);
  git(cwd, ['commit', '-m', message]);
  return gitTrim(cwd, ['rev-parse', 'HEAD']);
}

function makeRun(partial: Partial<WorkflowRun> & { id: string }): WorkflowRun {
  return {
    workflow_name: 'bdc-feature-development',
    conversation_id: 'c1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'escalated',
    user_message: 'WO_ID=WO-X-01',
    metadata: {},
    started_at: new Date('2026-09-28T20:00:00.000Z'),
    completed_at: new Date('2026-09-28T20:05:00.000Z'),
    last_activity_at: null,
    working_path: null,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    ...partial,
  };
}

function memoryStore(runs: WorkflowRun[]): EscalationLinkerStore & {
  updates: { id: string; metadataKeys: string[] }[];
} {
  const byId = new Map(runs.map(run => [run.id, run]));
  const updates: { id: string; metadataKeys: string[] }[] = [];
  return {
    updates,
    async listWorkflowRuns(): Promise<WorkflowRun[]> {
      return [...byId.values()];
    },
    async listWorkflowEvents(): Promise<
      {
        event_type: string;
        step_name: string | null;
        data: Record<string, unknown> | string | null;
      }[]
    > {
      return [];
    },
    async updateWorkflowRun(id, patch): Promise<void> {
      const run = byId.get(id);
      if (!run) throw new Error(`Workflow run not found (id: ${id})`);
      const metadata = patch.metadata ?? {};
      updates.push({ id, metadataKeys: Object.keys(metadata) });
      run.metadata = { ...run.metadata, ...metadata };
    },
  };
}

function worktreeBlock(repo: string, worktreePath: string): string {
  const porcelain = git(repo, ['worktree', 'list', '--porcelain']);
  const target = realpathSync(worktreePath);
  for (const block of porcelain.trim().split(/\n\n/)) {
    const first = block.split('\n')[0] ?? '';
    if (!first.startsWith('worktree ')) continue;
    const listed = first.slice('worktree '.length);
    if (realpathSync(listed) === target) return block;
  }
  throw new Error(`missing worktree block for ${target}\n${porcelain}`);
}

function handoffRecord(overrides?: Partial<HandoffRecord>): HandoffRecord {
  return {
    runId: 'run-A',
    repository: 'https://github.com/thinmansoftware/bdc-harness',
    branch: 'feat/wo-x-01',
    localHead: HANDOFF_HEAD,
    evidenceRunId: 'run-A',
    pushedHead: HANDOFF_HEAD,
    remoteHead: HANDOFF_HEAD,
    ...overrides,
  };
}

test('escalated_predecessor_worktree_no_longer_blocks_the_next_tier_checkout', async () => {
  const fx = createFixture('bdc-handoff-collision-');
  const wtA = addWorktree(fx.clone, fx.root, 'wt-a', 'feat/wo-x-01');
  const wtB = addWorktree(fx.clone, fx.root, 'wt-b', 'wip/hold-01');
  const sha = gitTrim(wtA, ['rev-parse', 'HEAD']);

  const before = gitText(wtB, ['checkout', '-B', 'feat/wo-x-01', sha]);
  expect(before.code).not.toBe(0);
  expect(`${before.stderr}\n${before.stdout}`).toContain('already used by worktree');

  const released = await releasePredecessorBranchHolds([
    makeRun({ id: 'run-A', status: 'escalated', working_path: wtA }),
  ]);
  expect(released.skipped).toEqual([]);
  expect(released.records).toHaveLength(1);

  const after = gitText(wtB, ['checkout', '-B', 'feat/wo-x-01', sha]);
  expect(after.code).toBe(0);
  expect(gitTrim(wtB, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/wo-x-01');

  const again = await releasePredecessorBranchHolds([
    makeRun({ id: 'run-A', status: 'escalated', working_path: wtA }),
  ]);
  expect(again.records).toEqual([]);
  expect(again.skipped).toEqual([{ runId: 'run-A', reason: 'already_detached' }]);
  expect(gitTrim(wtB, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/wo-x-01');
});

test('released_worktree_is_detached_and_keeps_all_work', async () => {
  const fx = createFixture('bdc-handoff-keep-');
  const wt = addWorktree(fx.clone, fx.root, 'wt-a', 'feat/wo-x-01');
  const committed = commitFile(wt, 'tracked.txt', 'original\n', 'track');
  writeFileSync(join(wt, 'tracked.txt'), 'modified\n');
  writeFileSync(join(wt, 'untracked.txt'), 'new\n');

  const released = await releasePredecessorBranchHolds([
    makeRun({ id: 'run-A', status: 'escalated', working_path: wt }),
  ]);
  expect(released.skipped).toEqual([]);
  expect(released.records).toHaveLength(1);

  expect(existsDir(wt)).toBe(true);
  expect(readFileSync(join(wt, 'tracked.txt'), 'utf8')).toBe('modified\n');
  expect(readFileSync(join(wt, 'untracked.txt'), 'utf8')).toBe('new\n');

  const block = worktreeBlock(fx.clone, wt);
  expect(block).toContain('\ndetached');
  expect(block).not.toContain('branch refs/heads/feat/wo-x-01');
  expect(git(fx.clone, ['worktree', 'list', '--porcelain'])).not.toContain(
    'branch refs/heads/feat/wo-x-01'
  );
  expect(gitTrim(fx.clone, ['rev-parse', '--verify', 'refs/heads/feat/wo-x-01'])).toBe(committed);
});

test('active_run_worktree_is_never_touched', async () => {
  const fx = createFixture('bdc-handoff-active-');
  const wt = addWorktree(fx.clone, fx.root, 'wt-a', 'feat/wo-active-01');
  const result = await releasePredecessorBranchHolds([
    makeRun({ id: 'running', status: 'running', working_path: wt }),
    makeRun({ id: 'pending', status: 'pending', working_path: wt }),
    makeRun({ id: 'paused', status: 'paused', working_path: wt }),
  ]);
  expect(result.records).toEqual([]);
  expect(result.skipped).toEqual([
    { runId: 'running', reason: 'run_active' },
    { runId: 'pending', reason: 'run_active' },
    { runId: 'paused', reason: 'run_active' },
  ]);
  expect(gitTrim(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/wo-active-01');
});

test('handoff_record_carries_the_predecessors_own_recorded_push_evidence', async () => {
  expect(normalizeOriginUrl('git@github.com:ThinManSoftware/bdc-harness.git')).toBe(
    'https://github.com/thinmansoftware/bdc-harness'
  );
  expect(normalizeOriginUrl('ssh://git@github.com/ThinManSoftware/bdc-harness.git')).toBe(
    'https://github.com/thinmansoftware/bdc-harness'
  );
  expect(normalizeOriginUrl('https://user:token@GitHub.com/ThinManSoftware/bdc-harness.git')).toBe(
    'https://github.com/thinmansoftware/bdc-harness'
  );
  expect(normalizeOriginUrl('https://github.com/thinmansoftware/bdc-harness')).toBe(
    'https://github.com/thinmansoftware/bdc-harness'
  );
  expect(normalizeOriginUrl('file:///tmp/Foo/origin.git')).toBe('/tmp/Foo/origin');
  expect(normalizeOriginUrl('')).toBeNull();
  expect(normalizeOriginUrl('   ')).toBeNull();
  expect(REPAIR_HEAD_RULE).toBe(RULE);

  const branch = 'feat/wo-evidence-01';
  const fx = createFixture('bdc-handoff-evidence-');
  const wt = addWorktree(fx.clone, fx.root, 'wt-a', branch);
  const pushed = commitFile(wt, 'pushed.txt', 'pushed\n', 'push me');
  git(wt, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const origin = gitTrim(wt, ['remote', 'get-url', 'origin']);
  const run = makeRun({
    id: 'run-A',
    status: 'escalated',
    working_path: wt,
    user_message: 'WO_ID=WO-EVIDENCE-01',
    metadata: { keeper: 'existing' },
  });
  const store = memoryStore([run]);
  await recordPushEvidence(store, {
    runId: run.id,
    repository: origin,
    branch,
    pushedHead: pushed,
    cwd: wt,
    now: new Date(RECORDED_AT),
  });
  const local = commitFile(wt, 'local-only.txt', 'local\n', 'not pushed');
  expect(local).not.toBe(pushed);

  const released = await releasePredecessorBranchHolds([run]);
  expect(released.skipped).toEqual([]);
  expect(released.records).toHaveLength(1);
  const record = released.records[0];
  if (!record) throw new Error('missing handoff record');
  const normalized = normalizeOriginUrl(origin);
  expect(normalized).not.toBeNull();
  expect(normalizeOriginUrl(normalized)).toBe(normalized);
  expect(record.runId).toBe('run-A');
  expect(record.evidenceRunId).toBe('run-A');
  expect(record.repository).toBe(normalized);
  expect(record.branch).toBe(branch);
  expect(record.localHead).toBe(local);
  expect(record.pushedHead).toBe(pushed);
  expect(record.remoteHead).toBe(pushed);
  expect(record.pushedHead).not.toBe(record.localHead);

  const text = formatHandoffLines(released.records);
  const lines = text.split('\n');
  expect(lines.filter(line => line.startsWith('ESCALATION_HANDOFF '))).toHaveLength(1);
  expect(lines[0]).toBe(
    `ESCALATION_HANDOFF run=run-A repository=${normalized} branch=${branch} pushed_head=${pushed} evidence_run=run-A local_head=${local} remote_head=${pushed}`
  );
  expect(lines[1]).toBe(RULE);
  expect(text).not.toContain('WO_ID=');
  expect(formatHandoffLines([])).toBe('');
});

test('precondition_passes_when_the_live_head_equals_the_recorded_handoff_head', () => {
  const record = handoffRecord();
  const result = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: HANDOFF_HEAD,
    expectedRepository: 'git@github.com:ThinManSoftware/bdc-harness.git',
    expectedBranch: 'feat/wo-x-01',
    records: [record],
  });
  expect(result.ok).toBe(true);
  expect(result.reason).toBe('live_matches_handoff');

  const pinMatch = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: PIN_HEAD,
    expectedRepository: record.repository,
    expectedBranch: record.branch,
    records: [record],
  });
  expect(pinMatch.ok).toBe(true);
  expect(pinMatch.reason).toBe('live_matches_pin');
});

test('precondition_fails_when_someone_else_moved_the_head_between_tiers', () => {
  const record = handoffRecord({ remoteHead: THIRD_HEAD });
  const result = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: THIRD_HEAD,
    expectedRepository: record.repository,
    expectedBranch: record.branch,
    records: [record],
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBe('unexplained_head_change');

  const remoteOnly = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: THIRD_HEAD,
    expectedRepository: record.repository,
    expectedBranch: record.branch,
    records: [handoffRecord({ pushedHead: null, evidenceRunId: null, remoteHead: THIRD_HEAD })],
  });
  expect(remoteOnly.ok).toBe(false);
  expect(remoteOnly.reason).toBe('unexplained_head_change');

  const shortSha = evaluateHandoffHeadPrecondition({
    pinnedHead: 'd800f8f8',
    liveHead: 'd800f8f8',
    expectedRepository: record.repository,
    expectedBranch: record.branch,
    records: [record],
  });
  expect(shortSha.ok).toBe(false);
  expect(shortSha.reason).toBe('unexplained_head_change');
});

test('precondition_result_records_both_heads', () => {
  const records = [handoffRecord()];
  const pass = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: PIN_HEAD,
    expectedRepository: records[0]?.repository ?? '',
    expectedBranch: 'feat/wo-x-01',
    records,
  });
  expect(pass.ok).toBe(true);
  expect(pass.reason).toBe('live_matches_pin');
  expect(pass.pinnedHead).toBe(PIN_HEAD);
  expect(pass.liveHead).toBe(PIN_HEAD);
  expect(pass.records).toBe(records);

  const fail = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: THIRD_HEAD,
    expectedRepository: records[0]?.repository ?? '',
    expectedBranch: 'feat/wo-x-01',
    records,
  });
  expect(fail.ok).toBe(false);
  expect(fail.reason).toBe('unexplained_head_change');
  expect(fail.pinnedHead).toBe(PIN_HEAD);
  expect(fail.liveHead).toBe(THIRD_HEAD);
  expect(fail.records).toBe(records);
});

test('predecessor_listing_is_same_wo_and_terminal_only', async () => {
  const calls: {
    status?: WorkflowRunStatus | WorkflowRunStatus[];
    limit?: number;
    includeArchived?: boolean;
  }[] = [];
  const runs = [
    makeRun({ id: 'a-failed', status: 'failed', user_message: 'WO_ID=WO-A-01' }),
    makeRun({ id: 'a-esc', status: 'escalated', user_message: 'note\nWO_ID=WO-A-01\n' }),
    makeRun({ id: 'a-can', status: 'cancelled', user_message: 'WO_ID=WO-A-01' }),
    makeRun({ id: 'b-failed', status: 'failed', user_message: 'WO_ID=WO-B-01' }),
    makeRun({ id: 'successor', status: 'failed', user_message: 'WO_ID=WO-A-01' }),
    makeRun({ id: 'a-completed', status: 'completed', user_message: 'WO_ID=WO-A-01' }),
    makeRun({ id: 'a-running', status: 'running', user_message: 'WO_ID=WO-A-01' }),
  ];
  const store: EscalationLinkerStore = {
    async listWorkflowRuns(options) {
      calls.push({
        status: options?.status,
        limit: options?.limit,
        includeArchived: options?.includeArchived,
      });
      return runs;
    },
    async listWorkflowEvents() {
      return [];
    },
    async updateWorkflowRun() {
      return undefined;
    },
  };

  const absent = await listPredecessorRuns('no work order in this message', store);
  expect(absent).toEqual([]);
  expect(calls).toHaveLength(0);

  const listed = await listPredecessorRuns('WO_ID=WO-A-01\nbuild it', store, {
    excludeRunId: 'successor',
  });
  expect(calls).toEqual([
    {
      status: ['failed', 'escalated', 'cancelled'],
      limit: 200,
      includeArchived: true,
    },
  ]);
  expect(listed.map(run => run.id).sort()).toEqual(['a-can', 'a-esc', 'a-failed']);
});

test('orchestrator_and_module_index_are_wired', () => {
  const here = import.meta.dir;
  const orchestrator = readFileSync(join(here, '../orchestrator/orchestrator.ts'), 'utf8');
  const index = readFileSync(join(here, 'index.ts'), 'utf8');
  expect(orchestrator).toContain('releasePredecessorBranchHolds');
  expect(orchestrator).toContain('formatHandoffLines');
  expect(orchestrator).toContain('listPredecessorRuns');
  expect(orchestrator).toContain('escalation_handoff');
  expect(index).toContain('releasePredecessorBranchHolds');
  expect(index).toContain('evaluateHandoffHeadPrecondition');
  expect(index).toContain("from './branch-handoff'");
});

test('engine_branches_missing_paths_and_git_failures_are_skipped_safely', async () => {
  const fx = createFixture('bdc-handoff-skip-');
  const engineWt = addWorktree(fx.clone, fx.root, 'engine', 'archon/task-skip-01');
  const plain = join(fx.root, 'plain');
  mkdirSync(plain);
  const missing = join(fx.root, 'does-not-exist');
  const failDir = join(fx.root, 'git-fail');
  mkdirSync(failDir);
  writeFileSync(join(failDir, 'keep.txt'), 'keep\n');

  const runner: GitRunner = args => {
    const flag = args.indexOf('-C');
    const path = flag >= 0 ? args[flag + 1] : '';
    if (path === failDir) {
      const cmd = args.slice(flag + 2);
      if (cmd[0] === 'rev-parse' && cmd.includes('--is-inside-work-tree')) {
        return Promise.resolve({ stdout: 'true\n', stderr: '', code: 0 });
      }
      if (cmd[0] === 'rev-parse' && cmd.includes('--abbrev-ref')) {
        return Promise.resolve({ stdout: 'feat/wo-fail-01\n', stderr: '', code: 0 });
      }
      return Promise.resolve({ stdout: '', stderr: 'forced git failure', code: 1 });
    }
    return execGit(args);
  };

  const result = await releasePredecessorBranchHolds(
    [
      makeRun({ id: 'engine', status: 'escalated', working_path: engineWt }),
      makeRun({ id: 'missing', status: 'failed', working_path: missing }),
      makeRun({ id: 'plain', status: 'cancelled', working_path: plain }),
      makeRun({ id: 'gitfail', status: 'escalated', working_path: failDir }),
    ],
    { gitRunner: runner }
  );
  expect(result.records).toEqual([]);
  expect(result.skipped).toEqual([
    { runId: 'engine', reason: 'engine_branch' },
    { runId: 'missing', reason: 'path_missing' },
    { runId: 'plain', reason: 'not_a_worktree' },
    { runId: 'gitfail', reason: 'git_failed' },
  ]);
  expect(gitTrim(engineWt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('archon/task-skip-01');
  expect(existsDir(engineWt)).toBe(true);
  expect(existsDir(plain)).toBe(true);
  expect(existsDir(missing)).toBe(false);
  expect(readFileSync(join(failDir, 'keep.txt'), 'utf8')).toBe('keep\n');
});

test('push_from_another_linked_worktree_or_run_is_not_the_predecessors_evidence', async () => {
  const branch = 'feat/wo-shared-01';
  const fx = createFixture('bdc-handoff-linked-');
  const wtA = addWorktree(fx.clone, fx.root, 'wt-a', branch);
  const pushed = commitFile(wtA, 'pushed.txt', 'from-a\n', 'tier 1');
  git(wtA, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const origin = gitTrim(wtA, ['remote', 'get-url', 'origin']);
  const normalized = normalizeOriginUrl(origin);
  expect(normalized).not.toBeNull();

  const runA = makeRun({
    id: 'run-A',
    status: 'escalated',
    working_path: wtA,
    metadata: { keeper: 'a' },
  });
  const wtC = join(fx.root, 'wt-c');
  git(fx.clone, ['worktree', 'add', '--detach', wtC, branch]);
  const runC = makeRun({
    id: 'run-C',
    status: 'escalated',
    working_path: wtC,
  });
  const store = memoryStore([runA, runC]);
  await recordPushEvidence(store, {
    runId: runA.id,
    repository: origin,
    branch,
    pushedHead: pushed,
    cwd: wtA,
    now: new Date(RECORDED_AT),
  });

  const unrelated = commitFile(wtC, 'unrelated.txt', 'from-c\n', 'other worktree');
  expect(unrelated).not.toBe(pushed);
  git(wtC, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  await recordPushEvidence(store, {
    runId: runC.id,
    repository: origin,
    branch,
    pushedHead: unrelated,
    cwd: wtC,
    now: new Date(RECORDED_AT),
  });
  git(wtA, ['fetch', 'origin']);
  expect(gitTrim(wtA, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(unrelated);
  expect(git(wtA, ['reflog', '--format=%H', `refs/remotes/origin/${branch}`])).toContain(unrelated);

  const wtA2 = addWorktree(fx.clone, fx.root, 'wt-a2', 'feat/wo-a2-01');
  const wtA3 = addWorktree(fx.clone, fx.root, 'wt-a3', 'feat/wo-a3-01');
  const wtA4 = addWorktree(fx.clone, fx.root, 'wt-a4', 'fix/wo-a4-01');
  const wtA5 = addWorktree(fx.clone, fx.root, 'wt-a5', 'wip/wo-a5-01');
  const runA2 = makeRun({ id: 'run-A2', status: 'failed', working_path: wtA2, metadata: {} });
  const runA3 = makeRun({
    id: 'run-A3',
    status: 'escalated',
    working_path: wtA3,
    metadata: {
      push_evidence: {
        runId: 'run-C',
        repository: normalized,
        branch: 'feat/wo-a3-01',
        pushedHead: unrelated,
        recordedAt: RECORDED_AT,
      },
    },
  });
  const runA4 = makeRun({
    id: 'run-A4',
    status: 'cancelled',
    working_path: wtA4,
    metadata: {
      push_evidence: {
        runId: 'run-A4',
        repository: 'https://example.com/other/repo',
        branch: 'fix/wo-a4-01',
        pushedHead: unrelated,
        recordedAt: RECORDED_AT,
      },
    },
  });
  const runA5 = makeRun({
    id: 'run-A5',
    status: 'escalated',
    working_path: wtA5,
    metadata: {
      push_evidence: {
        runId: 'run-A5',
        repository: normalized,
        branch: 'feat/someone-else',
        pushedHead: unrelated,
        recordedAt: RECORDED_AT,
      },
    },
  });

  const released = await releasePredecessorBranchHolds([runA, runA2, runA3, runA4, runA5]);
  expect(released.skipped).toEqual([]);
  const byId = new Map(released.records.map(record => [record.runId, record]));
  const recordA = byId.get('run-A');
  const recordA2 = byId.get('run-A2');
  const recordA3 = byId.get('run-A3');
  const recordA4 = byId.get('run-A4');
  const recordA5 = byId.get('run-A5');
  if (!recordA || !recordA2 || !recordA3 || !recordA4 || !recordA5) {
    throw new Error('missing linked handoff record');
  }
  expect(recordA.pushedHead).toBe(pushed);
  expect(recordA.pushedHead).not.toBe(unrelated);
  expect(recordA.evidenceRunId).toBe('run-A');
  expect(recordA.remoteHead).toBe(unrelated);
  expect(recordA.localHead).toBe(pushed);
  expect(recordA2.pushedHead).toBeNull();
  expect(recordA2.evidenceRunId).toBeNull();
  expect(recordA3.pushedHead).toBeNull();
  expect(recordA3.evidenceRunId).toBeNull();
  expect(recordA4.pushedHead).toBeNull();
  expect(recordA4.evidenceRunId).toBeNull();
  expect(recordA5.pushedHead).toBeNull();
  expect(recordA5.evidenceRunId).toBeNull();

  for (const record of [recordA, recordA2, recordA3, recordA4, recordA5]) {
    const rejected = evaluateHandoffHeadPrecondition({
      pinnedHead: PIN_HEAD,
      liveHead: unrelated,
      expectedRepository: record.repository,
      expectedBranch: record.branch,
      records: [record],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe('unexplained_head_change');
  }
  const accepted = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: pushed,
    expectedRepository: recordA.repository,
    expectedBranch: recordA.branch,
    records: [recordA],
  });
  expect(accepted.ok).toBe(true);
  expect(accepted.reason).toBe('live_matches_handoff');
});

test('recorder_writes_bound_evidence_and_a_force_push_after_the_record_is_rejected', async () => {
  const branch = 'feat/wo-record-01';
  const fx = createFixture('bdc-handoff-record-');
  const wt = addWorktree(fx.clone, fx.root, 'wt-a', branch);
  const pushed = commitFile(wt, 'pushed.txt', 'recorded\n', 'record me');
  git(wt, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const origin = gitTrim(wt, ['remote', 'get-url', 'origin']);
  const run = makeRun({
    id: 'run-A',
    status: 'escalated',
    working_path: wt,
    metadata: { keeper: 'existing' },
  });
  const store = memoryStore([run]);
  const evidence = await recordPushEvidence(store, {
    runId: run.id,
    repository: origin,
    branch,
    pushedHead: pushed,
    cwd: wt,
    now: new Date(RECORDED_AT),
  });
  const expected: PushEvidence = {
    runId: 'run-A',
    repository: normalizeOriginUrl(origin) ?? '',
    branch,
    pushedHead: pushed,
    recordedAt: RECORDED_AT,
  };
  expect(evidence).toEqual(expected);
  expect(run.metadata.keeper).toBe('existing');
  expect(run.metadata.push_evidence).toEqual(expected);
  expect(store.updates).toEqual([{ id: 'run-A', metadataKeys: ['push_evidence'] }]);

  const snapshot = JSON.stringify(run.metadata);
  await expect(
    recordPushEvidence(store, {
      runId: run.id,
      repository: origin,
      branch,
      pushedHead: 'not-a-sha',
      cwd: wt,
    })
  ).rejects.toThrow('push_evidence_rejected:');
  await expect(
    recordPushEvidence(store, {
      runId: run.id,
      repository: origin,
      branch,
      pushedHead: 'b'.repeat(40),
      cwd: wt,
    })
  ).rejects.toThrow('push_evidence_rejected:');
  expect(JSON.stringify(run.metadata)).toBe(snapshot);
  expect(store.updates).toHaveLength(1);

  const other = join(fx.root, 'other');
  git(fx.root, ['clone', fx.origin, other]);
  const moved = commitFile(other, 'forced.txt', 'third-party\n', 'force');
  expect(moved).not.toBe(pushed);
  git(other, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);

  const released = await releasePredecessorBranchHolds([run]);
  expect(released.skipped).toEqual([]);
  const record = released.records[0];
  if (!record) throw new Error('missing recorder handoff record');
  expect(record.pushedHead).toBe(pushed);
  expect(record.remoteHead).toBe(moved);
  expect(record.evidenceRunId).toBe('run-A');

  const rejected = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: moved,
    expectedRepository: record.repository,
    expectedBranch: branch,
    records: [record],
  });
  expect(rejected.ok).toBe(false);
  expect(rejected.reason).toBe('unexplained_head_change');

  const accepted = evaluateHandoffHeadPrecondition({
    pinnedHead: PIN_HEAD,
    liveHead: pushed,
    expectedRepository: record.repository,
    expectedBranch: branch,
    records: [record],
  });
  expect(accepted.ok).toBe(true);
  expect(accepted.reason).toBe('live_matches_handoff');
});

function existsDir(path: string): boolean {
  try {
    return realpathSync(path).length > 0;
  } catch {
    return false;
  }
}
