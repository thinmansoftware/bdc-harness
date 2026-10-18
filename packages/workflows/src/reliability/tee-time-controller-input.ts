// Read-only inputs for a future controller. No worker, approval or dispatch authority.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { execFileAsync, toRepoPath, toWorktreePath, verifyWorktreeOwnership } from '@archon/git';
import { getProjectRoot, getProjectWorktreesPath, getRunArtifactsPath } from '@archon/paths';
import {
  assertTeeTimeRunPolicy,
  policyDigest,
  teeTimeRunPolicy,
  TEE_TIME_REPOSITORY,
  TEE_TIME_WORKFLOW,
} from '@archon/paths/tee-time-policy';
import type { WorkflowDeps } from '../deps';
import { BUNDLED_WORKFLOWS } from '../defaults/bundled-defaults';
import { parseWorkflow } from '../loader';
import { assertRestrictedAuthority } from '../tee-time-policy';
import { captureRuntimeRevisions } from './runtime-revisions';
import type { RunAuthorityRecord } from './types';

export const TEE_TIME_BASE_HELPERS = Object.freeze([
  'teetime_git_base.py',
  'teetime_bounded_process.py',
  'teetime_git_objects.py',
  'teetime_materialization_frame.py',
  'teetime_snapshot.py',
  'teetime_artifact_contract.py',
]);

export interface TeeTimeControllerConfig {
  projectRoot: string;
  repositoryRoot: string;
  helperRoot: string;
  helperHashes: Readonly<Record<string, string>>;
  binaryHashes: Readonly<{ pythonBinary: string; gitBinary: string }>;
  pythonBinary: string;
  gitBinary: string;
}

export interface TeeTimeControllerInput {
  readonly authority: Readonly<RunAuthorityRecord>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly specText: string;
  readonly specBytesBase64: string;
  readonly base: Readonly<{
    baseCommit: string;
    sourceTree: string;
    manifestHash: string;
    frameBase64: string;
  }>;
  readonly helperExecution: 'frozen-files-no-image-attestation';
  readonly worktreeState: 'ownership-only-head-unverified';
  readonly helperHashes: Readonly<Record<string, string>>;
  readonly binaryHashes: Readonly<{ pythonBinary: string; gitBinary: string }>;
}

const hash = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (!isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
  );
}
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('absolute controller-owned path required');
  return realpath(path);
}
async function boundedFile(path: string, root: string, limit = 65536): Promise<Buffer> {
  const target = await realpath(path);
  const info = await lstat(path);
  if (!inside(root, target) || info.isSymbolicLink() || !info.isFile() || info.size > limit)
    throw new Error('trusted file path or bound rejected');
  const raw = await readFile(path);
  if (raw.length > limit) throw new Error('trusted file grew beyond bound');
  return raw;
}
function remote(value: string | null): string {
  const normalized = value?.replace(/\.git$/, '');
  if (
    normalized !== `https://github.com/${TEE_TIME_REPOSITORY}` &&
    normalized !== `git@github.com:${TEE_TIME_REPOSITORY}`
  )
    throw new Error('restricted repository identity differs');
  return TEE_TIME_REPOSITORY;
}

export async function loadTeeTimeControllerInput(
  deps: WorkflowDeps,
  runId: string,
  config: TeeTimeControllerConfig
): Promise<TeeTimeControllerInput> {
  const settings = {
    ...config,
    helperHashes: { ...config.helperHashes },
    binaryHashes: { ...config.binaryHashes },
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId))
    throw new Error('trusted run identity required');
  const loadedRun = await deps.store.getWorkflowRun(runId);
  if (
    loadedRun?.id !== runId ||
    !loadedRun.codebase_id ||
    loadedRun.workflow_name !== TEE_TIME_WORKFLOW
  )
    throw new Error('persisted restricted run missing or foreign');
  const run = {
    id: loadedRun.id,
    codebase_id: loadedRun.codebase_id,
    workflow_name: loadedRun.workflow_name,
    policyDigest: policyDigest(loadedRun.metadata?.execution_policy),
  };
  const loadedAuthority = await deps.store.getRunAuthority(runId);
  const loadedCodebase = await deps.store.getCodebase(run.codebase_id);
  if (
    !loadedAuthority ||
    loadedCodebase?.id !== run.codebase_id ||
    loadedCodebase.name !== TEE_TIME_REPOSITORY
  )
    throw new Error('persisted codebase or authority missing or foreign');
  const authority = Object.freeze({ ...loadedAuthority });
  const codebase = Object.freeze({ ...loadedCodebase });
  if (
    authority.runId !== runId ||
    authority.codebaseId !== run.codebase_id ||
    authority.workflowName !== TEE_TIME_WORKFLOW ||
    !/^WO-TEETIME-FOUNDATION-[0-9]+$/.test(authority.woId) ||
    !/^[a-f0-9]{40}$/.test(authority.baseSha) ||
    !/^[a-f0-9]{40}$/.test(authority.runScopeSha) ||
    authority.baseBranch !== 'staging'
  )
    throw new Error('frozen authority identity or staging base differs');
  remote(authority.canonicalRemote);
  remote(codebase.repository_url);
  const parsed = parseWorkflow(BUNDLED_WORKFLOWS[TEE_TIME_WORKFLOW], TEE_TIME_WORKFLOW + '.yaml');
  if (!parsed.workflow) throw new Error('source-owned foundation workflow missing');
  const expectedPolicy = teeTimeRunPolicy(
    codebase.id,
    policyDigest(parsed.workflow),
    authority.woId
  );
  assertTeeTimeRunPolicy(loadedRun.metadata?.execution_policy, expectedPolicy);
  const revisions = await captureRuntimeRevisions(parsed.workflow);
  if (
    Object.entries(revisions).some(
      ([key, value]) => authority[key as keyof typeof revisions] !== value
    )
  )
    throw new Error('authority runtime source revisions differ');
  const owner = 'thinmansoftware';
  const repo = 'whats-that-tee-time';
  const projectRoot = await directory(settings.projectRoot);
  if (projectRoot !== (await directory(getProjectRoot(owner, repo))))
    throw new Error('configured project path differs');
  const repositoryRoot = await directory(settings.repositoryRoot);
  if (repositoryRoot !== (await directory(codebase.default_cwd)))
    throw new Error('registered repository root differs');
  const worktreesRoot = await directory(getProjectWorktreesPath(owner, repo));
  const worktree = await directory(authority.worktreePath);
  const artifacts = await directory(getRunArtifactsPath(owner, repo, runId));
  const helperRoot = await directory(settings.helperRoot);
  if (
    !inside(projectRoot, worktreesRoot) ||
    !inside(worktreesRoot, worktree) ||
    worktree === worktreesRoot ||
    !inside(projectRoot, artifacts) ||
    inside(worktree, artifacts) ||
    inside(worktree, helperRoot)
  )
    throw new Error('restricted roots or worktree custody escaped');
  await verifyWorktreeOwnership(toWorktreePath(worktree), toRepoPath(repositoryRoot));
  const specPath = join(artifacts, 'authority', 'work-order.md');
  const manifestPath = join(artifacts, 'authority', 'run-authority.json');
  const spec = await boundedFile(specPath, artifacts);
  const manifest = await boundedFile(manifestPath, artifacts);
  const decode = (bytes: Uint8Array): string =>
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const manifestText = decode(manifest);
  const parsedManifest: unknown = JSON.parse(manifestText);
  // persistRunAuthority owns this exact pretty format; duplicate keys cannot round-trip.
  if (JSON.stringify(parsedManifest, null, 2) + '\n' !== manifestText)
    throw new Error('noncanonical authority manifest');
  await assertRestrictedAuthority(
    deps,
    loadedRun,
    expectedPolicy,
    TEE_TIME_WORKFLOW,
    worktree,
    artifacts
  );
  const specText = decode(spec);
  if (
    'sha256:' + hash(spec) !== authority.specHash ||
    policyDigest(parsedManifest) !== policyDigest(authority)
  )
    throw new Error('actual frozen bytes differ from loaded authority');
  const expectedHashes = Object.freeze({ ...settings.helperHashes });
  if (Object.keys(expectedHashes).sort().join(',') !== [...TEE_TIME_BASE_HELPERS].sort().join(','))
    throw new Error('complete helper closure required');
  async function verifyHelpers(): Promise<void> {
    for (const name of TEE_TIME_BASE_HELPERS) {
      if (
        !/^[a-f0-9]{64}$/.test(expectedHashes[name]) ||
        hash(await boundedFile(join(helperRoot, name), helperRoot, 1024 * 1024)) !==
          expectedHashes[name]
      )
        throw new Error('frozen base helper changed');
    }
  }
  await verifyHelpers();
  const binaries = Object.freeze({
    pythonBinary: await realpath(settings.pythonBinary),
    gitBinary: await realpath(settings.gitBinary),
  });
  const binaryHashes = Object.freeze({ ...settings.binaryHashes });
  async function verifyExecutables(): Promise<void> {
    for (const key of ['pythonBinary', 'gitBinary'] as const) {
      if (
        !isAbsolute(settings[key]) ||
        (await realpath(settings[key])) !== binaries[key] ||
        !/^[a-f0-9]{64}$/.test(binaryHashes[key]) ||
        hash(await boundedFile(binaries[key], dirname(binaries[key]), 64 * 1024 * 1024)) !==
          binaryHashes[key]
      )
        throw new Error('frozen executable identity differs');
    }
  }
  await verifyExecutables();
  const env: NodeJS.ProcessEnv = { PATH: dirname(binaries.pythonBinary), PYTHONNOUSERSITE: '1' };
  for (const key of ['SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  let output: string;
  try {
    const result = await execFileAsync(
      binaries.pythonBinary,
      [
        '-I',
        '-B',
        join(helperRoot, 'teetime_git_base.py'),
        binaries.gitBinary,
        repositoryRoot,
        authority.baseSha,
      ],
      { cwd: helperRoot, env, timeout: 25000, maxBuffer: 65536 }
    );
    if (result.stderr) throw new Error('unexpected helper stderr');
    output = result.stdout;
  } catch {
    throw new Error('trusted committed base read unavailable');
  }
  if (Buffer.byteLength(output) > 65536 || Buffer.from(output).some(byte => byte > 127))
    throw new Error('bounded ASCII base output required');
  const base = JSON.parse(output) as Record<string, unknown>;
  if (
    Object.keys(base).sort().join(',') !==
      'baseCommit,frameBase64,manifestHash,origin,sourceTree,version' ||
    base.version !== 1 ||
    base.baseCommit !== authority.baseSha ||
    typeof base.sourceTree !== 'string' ||
    !/^[a-f0-9]{40}$/.test(base.sourceTree) ||
    typeof base.manifestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(base.manifestHash) ||
    typeof base.frameBase64 !== 'string' ||
    Buffer.from(base.frameBase64, 'base64').toString('base64') !== base.frameBase64 ||
    JSON.stringify(base) !== output.trim()
  )
    throw new Error('complete base result rejected');
  remote(typeof base.origin === 'string' ? base.origin : null);
  await verifyHelpers();
  await verifyExecutables();
  const currentRun = await deps.store.getWorkflowRun(runId);
  const currentAuthority = await deps.store.getRunAuthority(runId);
  const currentCodebase = await deps.store.getCodebase(run.codebase_id);
  if (
    currentRun?.id !== run.id ||
    currentRun.codebase_id !== run.codebase_id ||
    currentRun.workflow_name !== run.workflow_name ||
    policyDigest(currentRun.metadata?.execution_policy) !== run.policyDigest ||
    policyDigest(currentAuthority) !== policyDigest(authority) ||
    policyDigest(currentCodebase) !== policyDigest(codebase) ||
    !(await boundedFile(specPath, artifacts)).equals(spec) ||
    !(await boundedFile(manifestPath, artifacts)).equals(manifest)
  )
    throw new Error('controller inputs changed during capture');
  return Object.freeze({
    authority,
    policy: Object.freeze({ ...expectedPolicy }),
    specText,
    specBytesBase64: spec.toString('base64'),
    base: Object.freeze({
      baseCommit: base.baseCommit,
      sourceTree: base.sourceTree,
      manifestHash: base.manifestHash,
      frameBase64: base.frameBase64,
    }),
    helperExecution: 'frozen-files-no-image-attestation' as const,
    worktreeState: 'ownership-only-head-unverified' as const,
    helperHashes: expectedHashes,
    binaryHashes,
  });
}
