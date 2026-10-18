// Synthetic operator-only qualification. No account, provider, server or scheduler.
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

if (process.argv.length !== 2 || Object.hasOwn(process.env, 'DATABASE_URL'))
  throw new Error('synthetic local qualification only; shared database prohibited');
const root = await mkdtemp(join(tmpdir(), 'teetime-sqlite-qualification-'));
const source = join(root, 'source'),
  worktree = join(root, 'worktrees', 'demo');
const home = join(root, 'archon');
await mkdir(home);
await mkdir(dirname(worktree));
process.env.ARCHON_HOME = home;
process.env.DEFAULT_AI_ASSISTANT = 'codex';
process.env.ARCHON_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';
const git = Bun.which('git'),
  python = Bun.which('python3') ?? Bun.which('python');
if (!git || !python) throw new Error('qualification requires installed Git/Python');
const env: Record<string, string> = {
  PATH: dirname(git) + delimiter + (process.env.PATH ?? ''),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '0',
  GIT_NO_REPLACE_OBJECTS: '1',
};
for (const key of ['SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!;
async function run(argv: string[], cwd = root): Promise<string> {
  const process = Bun.spawn(argv, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => process.kill(), 25000);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exit !== 0 || stdout.length > 65536 || stderr.length > 65536)
      throw new Error('bounded synthetic command failed');
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}
const prefix = [
  git,
  '--no-replace-objects',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=' + join(root, 'no-hooks'),
  '-c',
  'credential.helper=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'user.name=Synthetic Qualification',
  '-c',
  'user.email=synthetic@example.invalid',
  '-c',
  'core.autocrlf=false',
];
await run([...prefix, 'init', '--initial-branch=staging', '--object-format=sha1', source]);
await writeFile(join(source, 'README.md'), 'Synthetic qualification only.\n');
await run([...prefix, '-C', source, 'add', 'README.md']);
await run([...prefix, '-C', source, 'commit', '-m', 'Synthetic fixture']);
const sha = (await run([...prefix, '-C', source, 'rev-parse', 'HEAD'])).trim();
await run([
  ...prefix,
  '-C',
  source,
  'remote',
  'add',
  'origin',
  'https://github.com/thinmansoftware/whats-that-tee-time.git',
]);
await run([...prefix, '-C', source, 'update-ref', 'refs/remotes/origin/staging', sha]);
await run([
  ...prefix,
  '-C',
  source,
  'worktree',
  'add',
  '-b',
  'demo/simulated-walkthrough-01',
  worktree,
  sha,
]);
// Isolation is fixed and verified before importing any DB consumer.
if (
  (await realpath(home)) !== resolve(home) ||
  process.env.ARCHON_HOME !== home ||
  Object.hasOwn(process.env, 'DATABASE_URL')
)
  throw new Error('isolated environment changed');
const paths = await import('../../packages/paths/src/index');
paths.rootLogger.level = 'silent';
const connection = await import('../../packages/core/src/db/connection');
const db = connection.getDatabase();
if (db.dialect !== 'sqlite') throw new Error('isolated SQLite required');
await db.query('PRAGMA synchronous = FULL');
const journal = await db.query<{ journal_mode: string }>('PRAGMA journal_mode');
const synchronous = await db.query<{ synchronous: number }>('PRAGMA synchronous');
if (journal.rows[0]?.journal_mode !== 'wal' || synchronous.rows[0]?.synchronous !== 2)
  throw new Error('actual WAL/FULL readback required');
const { createWorkflowStore } = await import('../../packages/core/src/workflows/store-adapter');
const codes = await import('../../packages/core/src/db/codebases');
const conversations = await import('../../packages/core/src/db/conversations');
const runs = await import('../../packages/core/src/db/workflows');
const { prepareSupervisedRun, readSupervisedBinding } =
  await import('../../packages/workflows/src/reliability/tee-time-supervised-bootstrap');
const prep = join(root, 'preparation');
await mkdir(prep);
const api = {
  store: createWorkflowStore(),
  createCodebase: codes.createCodebase,
  getCodebase: codes.getCodebase,
  getOrCreateConversation: conversations.getOrCreateConversation,
  updateConversation: conversations.updateConversation,
  getConversationById: conversations.getConversationById,
  pauseWorkflowRunByOperator: runs.pauseWorkflowRunByOperator,
  artifactsPath: (runId: string) =>
    paths.getRunArtifactsPath('thinmansoftware', 'whats-that-tee-time', runId),
};
const input = {
  preparationRoot: prep,
  repositoryRoot: source,
  worktreePath: worktree,
  dispatchId: 'synthetic-sqlite-qualification',
  caseHash: 'sha256:' + '1'.repeat(64),
  specSource:
    'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEETIME-SIMULATED-WALKTHROUGH-01.md',
  specRevision: 'a'.repeat(40),
  specBytes: Buffer.from('Base branch: staging\nSynthetic qualification only.\n'),
  baseSha: sha,
  runScopeSha: sha,
  headBranch: 'demo/simulated-walkthrough-01',
  observe: async () => {
    const raw = await run([
      python,
      '-I',
      '-B',
      join(import.meta.dir, 'teetime_git_base.py'),
      git,
      source,
      sha,
      '--observe-worktree',
      worktree,
      sha,
      'demo/simulated-walkthrough-01',
    ]);
    return JSON.parse(raw).worktreeObservation;
  },
};
try {
  const prepared = await prepareSupervisedRun(api, input);
  const actual = await readSupervisedBinding(api, input);
  if (JSON.stringify(prepared) !== JSON.stringify(actual))
    throw new Error('actual DB binding readback differs');
  const schema = await db.query<{ name: string }>('PRAGMA table_info(remote_agent_workflow_runs)');
  const runRow = await api.store.getWorkflowRun(prepared.runId);
  const spec = await readFile(
    join(api.artifactsPath(prepared.runId), 'authority', 'work-order.md')
  );
  if (runRow?.status !== 'paused' || !spec.equals(input.specBytes))
    throw new Error('actual paused run missing');
  await connection.closeDatabase();
  await run([...prefix, '-C', source, 'worktree', 'remove', worktree]);
  if ((await realpath(root)) !== resolve(root) || dirname(root) !== (await realpath(tmpdir())))
    throw new Error('owned qualification cleanup boundary differs');
  await rm(root, { recursive: true });
  console.log(
    JSON.stringify({
      kind: 'synthetic-real-sqlite-qualification',
      passed: true,
      journalMode: 'wal',
      synchronous: 2,
      runStatus: 'paused',
      pausedBy: 'operator',
      worktreeObserved: true,
      authorityReadback: true,
      workflowRunColumns: schema.rows.map(row => row.name),
      cleanupVerified: true,
      modelInvocations: 0,
      accountProvided: false,
      operationalLaneReady: false,
    })
  );
} catch (error) {
  await connection.closeDatabase();
  console.log(
    JSON.stringify({
      kind: 'synthetic-real-sqlite-qualification',
      passed: false,
      retainedRoot: root,
      errorType: error instanceof Error ? error.name : 'unknown',
      modelInvocations: 0,
      accountProvided: false,
    })
  );
  process.exitCode = 1;
}
