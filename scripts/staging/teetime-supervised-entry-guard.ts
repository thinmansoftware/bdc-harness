// Pure entry guards. A matching object grants no review, account or execution authority.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function assertPrepareRuntime(platform:string,bunVersion:string):void {
  if(platform!=='win32'||bunVersion!=='1.3.13')throw new Error('fixed Windows staging runtime required');
}

export interface PreparedEntryManifest {
  version: 1;
  kind: 'tee-time-supervised-prepare';
  dispatchId: string;
  harnessSource: string;
  specRevision: string;
  baseSha: string;
  runScopeSha: string;
  specSha256: string;
  caseSha256: string;
  sourceManifestSha256: string;
  planFileHashes: Record<string, string>;
  binaryPaths: { git: string; python: string };
  binaryHashes: { git: string; python: string };
  helperHashes: Record<string, string>;
  assetHashes: Record<string, string>;
}
export const PREPARE_HELPERS = Object.freeze([
  'teetime_git_base.py',
  'teetime_bounded_process.py',
  'teetime_git_objects.py',
  'teetime_materialization_frame.py',
  'teetime_snapshot.py',
  'teetime_artifact_contract.py',
]);
const fields = [
  'version',
  'kind',
  'dispatchId',
  'harnessSource',
  'specRevision',
  'baseSha',
  'runScopeSha',
  'specSha256',
  'caseSha256',
  'sourceManifestSha256',
  'planFileHashes',
  'binaryPaths',
  'binaryHashes',
  'helperHashes',
  'assetHashes',
];
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    throw new Error('closed entry object required');
  return value as Record<string, unknown>;
}
function identity(value: unknown, length: number): void {
  if (typeof value !== 'string' || !new RegExp('^[a-f0-9]{' + length + '}$').test(value))
    throw new Error('frozen entry identity required');
}
export function validatePrepareManifest(
  value: unknown,
  assetPaths: readonly string[]
): PreparedEntryManifest {
  const item = object(value, fields);
  if (
    item.version !== 1 ||
    item.kind !== 'tee-time-supervised-prepare' ||
    typeof item.dispatchId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.dispatchId)
  )
    throw new Error('closed preparation entry required');
  for (const key of ['harnessSource', 'specRevision', 'baseSha', 'runScopeSha'])
    identity(item[key], 40);
  for (const key of ['specSha256', 'caseSha256', 'sourceManifestSha256']) identity(item[key], 64);
  const binaries = object(item.binaryPaths, ['git', 'python']);
  const binaryHashes = object(item.binaryHashes, ['git', 'python']);
  for (const key of ['git', 'python']) {
    if (typeof binaries[key] !== 'string' || !isAbsolute(binaries[key]))
      throw new Error('absolute frozen binary path required');
    identity(binaryHashes[key], 64);
  }
  const helpers = object(item.helperHashes, PREPARE_HELPERS);
  const assets = object(item.assetHashes, assetPaths);
  const plans = object(item.planFileHashes, [
    'work-order.md',
    'ui-contract.md',
    'bootstrap-spec.md',
    'implementation-plan.md',
  ]);
  for (const value of [
    ...Object.values(helpers),
    ...Object.values(assets),
    ...Object.values(plans),
  ])
    identity(value, 64);
  if (plans['work-order.md'] !== item.specSha256) throw new Error('work-order hash differs');
  // JSON roundtrip gives this trusted controller a detached immutable-input copy.
  return JSON.parse(JSON.stringify(item)) as PreparedEntryManifest;
}
export function assertPrepareEnvironment(
  actualRoot: string,
  expectedRoot: string,
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (
    !isAbsolute(actualRoot) ||
    resolve(actualRoot) !== resolve(expectedRoot) ||
    Object.hasOwn(environment, 'DATABASE_URL') ||
    (environment.ARCHON_HOME !== undefined &&
      environment.ARCHON_HOME !== join(expectedRoot, 'archon')) ||
    (environment.DEFAULT_AI_ASSISTANT !== undefined && environment.DEFAULT_AI_ASSISTANT !== 'codex')
  )
    throw new Error('isolated staging environment required before DB imports');
}
export async function ordinaryDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !isAbsolute(path) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('ordinary canonical owned staging directory required');
}
export async function frozenEntryFile(
  path: string,
  sha256: string,
  limit = 65536
): Promise<Buffer> {
  identity(sha256, 64);
  const info = await lstat(path);
  if (
    !isAbsolute(path) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > limit ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('ordinary bounded frozen entry file required');
  const bytes = await readFile(path);
  if (bytes.length > limit || hash(bytes) !== sha256) throw new Error('frozen entry bytes differ');
  return bytes;
}
export function validatePreparationObservation(value: unknown): {
  headCommit: string;
  headBranch: string;
  localStagingCommit: string;
  remoteStagingCommit: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('actual Git observation required');
  const result = value as Record<string, unknown>;
  if (result.origin !== 'https://github.com/thinmansoftware/whats-that-tee-time.git')
    throw new Error('actual repository remote differs');
  const observed = object(result.worktreeObservation, [
    'state',
    'headCommit',
    'headBranch',
    'localStagingCommit',
    'remoteStagingCommit',
  ]);
  if (
    observed.state !== 'registered-head-and-both-bases-observed-stable' ||
    observed.headBranch !== 'demo/simulated-walkthrough-01'
  )
    throw new Error('actual registered worktree observation required');
  for (const key of ['headCommit', 'localStagingCommit', 'remoteStagingCommit'])
    identity(observed[key], 40);
  return {
    headCommit: observed.headCommit as string,
    headBranch: observed.headBranch,
    localStagingCommit: observed.localStagingCommit as string,
    remoteStagingCommit: observed.remoteStagingCommit as string,
  };
}
export async function assertFreshSqliteLocation(archon: string): Promise<void> {
  for (const name of ['archon.db', 'archon.db-wal', 'archon.db-shm', 'archon.db-journal']) {
    try {
      await lstat(join(archon, name));
      throw new Error('existing database or recovery sidecar rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
