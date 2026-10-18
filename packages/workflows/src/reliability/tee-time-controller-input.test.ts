import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  readdir,
  lstat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileAsync } from '@archon/git';
import { registerProvider, isRegisteredProvider } from '@archon/providers';
import { CODEX_CAPABILITIES } from '../../../providers/src/codex/capabilities';
import { CURSOR_AGENT_CAPABILITIES } from '../../../providers/src/community/cursor/capabilities';
import { getProjectRoot, getProjectWorktreesPath, getRunArtifactsPath } from '@archon/paths';
import { policyDigest, teeTimeRunPolicy, TEE_TIME_WORKFLOW } from '@archon/paths/tee-time-policy';
import { BUNDLED_WORKFLOWS } from '../defaults/bundled-defaults';
import { parseWorkflow } from '../loader';
import type { WorkflowDeps } from '../deps';
import { buildRunAuthority } from './run-authority';
import { captureRuntimeRevisions } from './runtime-revisions';
import { loadTeeTimeControllerInput, TEE_TIME_BASE_HELPERS } from './tee-time-controller-input';

const dependenciesRoot = fileURLToPath(new URL('../../../../node_modules/', import.meta.url));
const fixturePool = join(dependenciesRoot, '.cache', 'teetime-controller-fixtures');
async function validatePool(): Promise<void> {
  for (const path of [dependenciesRoot, dirname(fixturePool), fixturePool]) {
    if (path !== dependenciesRoot) await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path))
      throw new Error('fixture pool indirection rejected');
  }
}

const roots: {
  root: string;
  gitBinary?: string;
  repositoryRoot?: string;
  worktreePath?: string;
  worktreeCreated: boolean;
  env?: NodeJS.ProcessEnv;
  gitPrefix?: string[];
}[] = [];
// Parser metadata only; these factories cannot create a model/provider client.
for (const [id, capabilities] of [
  ['cursor', CURSOR_AGENT_CAPABILITIES],
  ['codex-native-strict', CODEX_CAPABILITIES],
] as const) {
  if (!isRegisteredProvider(id))
    registerProvider({
      id,
      displayName: 'Synthetic parse-only',
      capabilities,
      builtIn: false,
      factory: () => {
        throw new Error('model/provider construction forbidden');
      },
    });
}
const originalHome = process.env.ARCHON_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  for (const fixture of roots.splice(0)) {
    const root = fixture.root;
    if (
      !basename(root).startsWith('teetime-controller-') ||
      resolve(dirname(root)) !== resolve(fixturePool) ||
      (await lstat(root)).isSymbolicLink() ||
      dirname(await realpath(root)) !== (await realpath(fixturePool))
    )
      throw new Error('unsafe test cleanup');
    const realRoot = await realpath(root);
    for (const path of [fixture.repositoryRoot, fixture.worktreePath].filter(
      (value): value is string => Boolean(value)
    )) {
      const suffix = relative(realRoot, await realpath(path));
      if (
        !suffix ||
        isAbsolute(suffix) ||
        suffix === '..' ||
        suffix.startsWith('..\\') ||
        suffix.startsWith('../')
      )
        throw new Error('unsafe fixture worktree cleanup');
    }
    if (fixture.worktreeCreated) {
      try {
        await execFileAsync(
          fixture.gitBinary!,
          [
            ...fixture.gitPrefix!,
            '-C',
            fixture.repositoryRoot!,
            'worktree',
            'remove',
            fixture.worktreePath!,
          ],
          { timeout: 10000, env: fixture.env }
        );
        const remaining = await execFileAsync(
          fixture.gitBinary!,
          [
            ...fixture.gitPrefix!,
            '-C',
            fixture.repositoryRoot!,
            'worktree',
            'list',
            '--porcelain',
            '-z',
          ],
          { timeout: 10000, env: fixture.env }
        );
        if (
          remaining.stdout
            .split('\0')
            .some(
              line =>
                line.startsWith('worktree ') &&
                resolve(line.slice(9)) === resolve(fixture.worktreePath!)
            )
        )
          throw new Error('fixture worktree remains registered');
      } catch (error) {
        throw new Error('Native worktree cleanup failed; retained fixture ' + root, {
          cause: error,
        });
      }
    }
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      console.error(
        JSON.stringify({
          operation: 'fixture-parent-rm',
          code: failure.code,
          path: failure.path,
          root,
          cwd: process.cwd(),
          remaining: await readdir(root, { recursive: true }),
        })
      );
      throw error;
    }
  }
});

async function fixture() {
  await validatePool();
  const root = await realpath(await mkdtemp(join(fixturePool, 'teetime-controller-')));
  const cleanup: {
    root: string;
    gitBinary?: string;
    repositoryRoot?: string;
    worktreePath?: string;
    worktreeCreated: boolean;
    env?: NodeJS.ProcessEnv;
    gitPrefix?: string[];
  } = { root, worktreeCreated: false };
  roots.push(cleanup);
  process.env.ARCHON_HOME = join(root, 'archon');
  const projectRoot = getProjectRoot('thinmansoftware', 'whats-that-tee-time');
  const repositoryRoot = join(projectRoot, 'source');
  const worktreePath = join(
    getProjectWorktreesPath('thinmansoftware', 'whats-that-tee-time'),
    'fixture'
  );
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(dirname(worktreePath), { recursive: true });
  const gitBinary = await realpath(Bun.which('git')!);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '0',
  });
  const hooks = join(root, 'hooks');
  const template = join(root, 'template');
  await mkdir(hooks);
  await mkdir(template);
  const gitPrefix = [
    '--no-replace-objects',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.hooksPath=' + hooks,
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.attributesFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
  ];
  await execFileAsync(
    gitBinary,
    [...gitPrefix, '-C', resolve(dependenciesRoot, '..'), 'check-ignore', '--quiet', '--', root],
    { timeout: 10000, env }
  );
  Object.assign(cleanup, { gitBinary, repositoryRoot, worktreePath, env, gitPrefix });
  const git = async (args: string[]) =>
    execFileAsync(gitBinary, [...gitPrefix, '-C', repositoryRoot, ...args], {
      timeout: 10000,
      env,
    });
  await git(['init', '--initial-branch=staging', '--object-format=sha1', '--template=' + template]);
  await git(['config', 'user.name', 'Synthetic Test']);
  await git(['config', 'user.email', 'synthetic@example.invalid']);
  await git([
    'remote',
    'add',
    'origin',
    'https://github.com/thinmansoftware/whats-that-tee-time.git',
  ]);
  await writeFile(join(repositoryRoot, 'README.md'), 'Synthetic foundation base\n');
  await writeFile(join(repositoryRoot, 'data.bin'), Buffer.from([0, 255, 1]));
  await git(['add', '--', 'README.md', 'data.bin']);
  await git(['commit', '-m', 'Synthetic base']);
  const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['worktree', 'add', '-b', 'foundation-fixture', worktreePath]);
  cleanup.worktreeCreated = true;
  await execFileAsync(
    gitBinary,
    [...gitPrefix, '-C', worktreePath, 'commit', '--allow-empty', '-m', 'Synthetic run scope'],
    { timeout: 10000, env }
  );
  const runScopeSha = (
    await execFileAsync(gitBinary, [...gitPrefix, '-C', worktreePath, 'rev-parse', 'HEAD'], {
      timeout: 10000,
      env,
    })
  ).stdout.trim();
  const parsed = parseWorkflow(BUNDLED_WORKFLOWS[TEE_TIME_WORKFLOW], TEE_TIME_WORKFLOW + '.yaml');
  if (!parsed.workflow) throw new Error('source workflow missing');
  const revisions = await captureRuntimeRevisions(parsed.workflow);
  const specBytes = Buffer.from('Synthetic frozen foundation specification\n');
  const authority = buildRunAuthority({
    runId: 'fixture-run',
    dispatchId: 'fixture-dispatch',
    woId: 'WO-TEETIME-FOUNDATION-01',
    specSource: 'fixture',
    specRevision: '1',
    specBytes,
    workflowName: TEE_TIME_WORKFLOW,
    codebaseId: 'fixture-codebase',
    canonicalRemote: 'https://github.com/thinmansoftware/whats-that-tee-time.git',
    baseBranch: 'staging',
    baseSha,
    runScopeSha,
    headBranch: 'foundation-fixture',
    worktreePath,
    ...revisions,
    createdAt: '2026-10-18T00:00:00Z',
  });
  const policy = teeTimeRunPolicy(
    'fixture-codebase',
    policyDigest(parsed.workflow),
    authority.woId
  );
  const run = {
    id: authority.runId,
    codebase_id: authority.codebaseId,
    workflow_name: TEE_TIME_WORKFLOW,
    metadata: { execution_policy: policy },
  };
  const codebase = {
    id: authority.codebaseId,
    name: 'thinmansoftware/whats-that-tee-time',
    repository_url: authority.canonicalRemote,
    default_cwd: repositoryRoot,
  };
  const artifacts = getRunArtifactsPath('thinmansoftware', 'whats-that-tee-time', run.id);
  await mkdir(join(artifacts, 'authority'), { recursive: true });
  const writeManifest = () =>
    writeFile(
      join(artifacts, 'authority', 'run-authority.json'),
      JSON.stringify(authority, null, 2) + '\n'
    );
  await writeManifest();
  await writeFile(join(artifacts, 'authority', 'work-order.md'), specBytes);
  const helperRoot = fileURLToPath(new URL('../../../../scripts/staging/', import.meta.url));
  const helperHashes = Object.fromEntries(
    await Promise.all(
      TEE_TIME_BASE_HELPERS.map(async (name: string) => [
        name,
        createHash('sha256')
          .update(await readFile(join(helperRoot, name)))
          .digest('hex'),
      ])
    )
  );
  const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  const pythonBinary = await realpath(
    (await execFileAsync(pythonCommand, ['-c', 'import sys;print(sys.executable)'])).stdout.trim()
  );
  const binaryHashes = {
    pythonBinary: createHash('sha256')
      .update(await readFile(pythonBinary))
      .digest('hex'),
    gitBinary: createHash('sha256')
      .update(await readFile(gitBinary))
      .digest('hex'),
  };
  const config = {
    projectRoot,
    repositoryRoot,
    helperRoot,
    helperHashes,
    binaryHashes,
    pythonBinary,
    gitBinary,
  };
  const store = {
    getWorkflowRun: async () => run,
    getRunAuthority: async () => authority,
    getCodebase: async () => codebase,
  };
  const deps = {
    store,
    getAgentProvider: () => {
      throw new Error('provider construction forbidden');
    },
  } as unknown as WorkflowDeps;
  return { root, authority, run, codebase, config, deps, artifacts, writeManifest };
}

describe('read-only persisted tee-time controller inputs', () => {
  it('loads frozen authority and exact committed binary base, with separate run scope', async () => {
    const f = await fixture();
    const result = await loadTeeTimeControllerInput(f.deps, f.run.id, f.config);
    expect(result.authority.baseSha).not.toBe(result.authority.runScopeSha);
    expect(result.base.baseCommit).toBe(f.authority.baseSha);
    const frame = JSON.parse(Buffer.from(result.base.frameBase64, 'base64').toString('ascii'));
    expect(frame.files.find((v: { path: string }) => v.path === 'data.bin').contentBase64).toBe(
      Buffer.from([0, 255, 1]).toString('base64')
    );
    expect(result.helperExecution).toBe('frozen-files-no-image-attestation');
    expect(result.worktreeState).toBe('ownership-only-head-unverified');
    f.authority.baseSha = '0'.repeat(40);
    expect(result.authority.baseSha).not.toBe(f.authority.baseSha);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.authority)).toBe(true);
  });
  it('rejects foreign run/codebase/policy and changed frozen specification', async () => {
    const f = await fixture();
    f.run.metadata.execution_policy = { hash: 'foreign' };
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.run.metadata.execution_policy = teeTimeRunPolicy(
      f.codebase.id,
      policyDigest(parseWorkflow(BUNDLED_WORKFLOWS[TEE_TIME_WORKFLOW], 'fixture.yaml').workflow),
      f.authority.woId
    );
    await writeFile(join(f.artifacts, 'authority', 'work-order.md'), 'changed');
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
  it('rejects missing commit and changed helper bytes', async () => {
    const f = await fixture();
    f.config.helperHashes['teetime_git_base.py'] = '0'.repeat(64);
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.config.helperHashes['teetime_git_base.py'] = createHash('sha256')
      .update(await readFile(join(f.config.helperRoot, 'teetime_git_base.py')))
      .digest('hex');
    f.authority.baseSha = '0'.repeat(40);
    await f.writeManifest();
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
  it('rejects a project root override and artifact junction escape', async () => {
    const f = await fixture();
    await expect(
      loadTeeTimeControllerInput(f.deps, f.run.id, { ...f.config, projectRoot: f.root })
    ).rejects.toThrow();
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await rm(join(f.artifacts, 'authority'), { recursive: true });
    await symlink(outside, join(f.artifacts, 'authority'), 'junction');
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
  it('rejects records that change during helper execution', async () => {
    const f = await fixture();
    let reads = 0;
    f.deps.store.getWorkflowRun = async () => {
      reads++;
      return { ...f.run, metadata: reads === 1 ? f.run.metadata : { execution_policy: {} } };
    };
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    expect(reads).toBeGreaterThan(1);
  });
  it('rejects a mismatched executable identity before running it', async () => {
    const f = await fixture();
    f.config.binaryHashes.pythonBinary = '0'.repeat(64);
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
  it('rejects absent or foreign persisted run and repository records', async () => {
    const f = await fixture();
    const getRun = f.deps.store.getWorkflowRun;
    f.deps.store.getWorkflowRun = async () => null;
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.deps.store.getWorkflowRun = getRun;
    f.run.workflow_name = 'foreign';
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.run.workflow_name = TEE_TIME_WORKFLOW;
    f.codebase.name = 'foreign';
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.codebase.name = 'thinmansoftware/whats-that-tee-time';
    f.codebase.repository_url = 'https://github.com/foreign/project.git';
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
  it('rejects duplicate authority keys and stale runtime revisions', async () => {
    const f = await fixture();
    const manifest = join(f.artifacts, 'authority', 'run-authority.json');
    const original = await readFile(manifest, 'utf8');
    await writeFile(manifest, original.replace('{\n', '{\n  "runId": "fixture-run",\n'));
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
    f.authority.engineRevision = 'sha256:' + '0'.repeat(64);
    await f.writeManifest();
    await expect(loadTeeTimeControllerInput(f.deps, f.run.id, f.config)).rejects.toThrow();
  });
});
