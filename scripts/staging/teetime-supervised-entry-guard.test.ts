import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  assertPrepareEnvironment,
  validatePrepareManifest,
  frozenEntryFile,
  PREPARE_HELPERS,
  validatePreparationObservation,
  assertFreshSqliteLocation,
} from './teetime-supervised-entry-guard';
import * as guards from './teetime-supervised-entry-guard';

test('operational runtime remains Windows Bun1.3.13 even when CI uses another runner',()=>{
  expect(()=>guards.assertPrepareRuntime('win32','1.3.13')).not.toThrow();
  for(const [platform,version] of [['linux','1.3.13'],['win32','1.3.11'],['win32','1.3.14']])
    expect(()=>guards.assertPrepareRuntime(platform,version)).toThrow();
});

const root = resolve(tmpdir(), 'synthetic-teetime-entry');
const manifest = () => ({
  version: 1,
  kind: 'tee-time-supervised-prepare',
  dispatchId: 'operator-one',
  harnessSource: 'a'.repeat(40),
  specRevision: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  runScopeSha: 'c'.repeat(40),
  specSha256: 'd'.repeat(64),
  caseSha256: 'e'.repeat(64),
  sourceManifestSha256: 'e'.repeat(64),
  planFileHashes: {
    'work-order.md': 'd'.repeat(64),
    'ui-contract.md': 'a'.repeat(64),
    'bootstrap-spec.md': 'b'.repeat(64),
    'implementation-plan.md': 'c'.repeat(64),
  },
  binaryPaths: { git: join(root, 'git'), python: join(root, 'python') },
  binaryHashes: { git: 'f'.repeat(64), python: 'f'.repeat(64) },
  helperHashes: Object.fromEntries(PREPARE_HELPERS.map(name => [name, '0'.repeat(64)])),
  assetHashes: { 'package.json': '1'.repeat(64) },
});
test('observed actual origin must match before a run can be recorded', () => {
  const observation = {
    state: 'registered-head-and-both-bases-observed-stable',
    headCommit: 'a'.repeat(40),
    headBranch: 'demo/simulated-walkthrough-01',
    localStagingCommit: 'b'.repeat(40),
    remoteStagingCommit: 'b'.repeat(40),
  };
  expect(
    validatePreparationObservation({
      origin: 'https://github.com/thinmansoftware/whats-that-tee-time.git',
      worktreeObservation: observation,
    }).headCommit
  ).toBe('a'.repeat(40));
  for (const origin of [
    null,
    'https://github.com/foreign/repo.git',
    'https://token@github.com/thinmansoftware/whats-that-tee-time.git',
  ])
    expect(() =>
      validatePreparationObservation({ origin, worktreeObservation: observation })
    ).toThrow();
});
test('fresh database check includes SQLite recovery sidecars', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teetime-db-sidecar-'));
  try {
    await assertFreshSqliteLocation(dir);
    for (const name of ['archon.db', 'archon.db-wal', 'archon.db-shm', 'archon.db-journal']) {
      const path = join(dir, name);
      await writeFile(path, 'prior state');
      await expect(assertFreshSqliteLocation(dir)).rejects.toThrow();
      await rm(path);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('rejects foreign environment before a database consumer can be imported', () => {
  assertPrepareEnvironment(root, root, {});
  assertPrepareEnvironment(root, root, {
    ARCHON_HOME: join(root, 'archon'),
    DEFAULT_AI_ASSISTANT: 'codex',
  });
  for (const env of [
    { DATABASE_URL: '' },
    { DATABASE_URL: 'shared' },
    { ARCHON_HOME: join(root, 'foreign') },
    { DEFAULT_AI_ASSISTANT: 'claude' },
    { DEFAULT_AI_ASSISTANT: 'fable' },
  ])
    expect(() => assertPrepareEnvironment(root, root, env)).toThrow();
  expect(() => assertPrepareEnvironment(join(root, 'other'), root, {})).toThrow();
});
test('closed prepare manifest rejects alternate actions, helpers and inherited model controls', () => {
  const valid = manifest();
  const read = validatePrepareManifest(valid, ['package.json']);
  valid.assetHashes['package.json'] = '2'.repeat(64);
  expect(read.assetHashes['package.json']).toBe('1'.repeat(64));
  for (const changed of [
    { ...manifest(), kind: 'run' },
    { ...manifest(), model: 'claude' },
    { ...manifest(), helperHashes: {} },
    { ...manifest(), assetHashes: {} },
    { ...manifest(), specRevision: 'latest' },
    { ...manifest(), binaryPaths: { git: 'git', python: 'python' } },
  ])
    expect(() => validatePrepareManifest(changed, ['package.json'])).toThrow();
});
test('frozen entry byte read rejects movement, oversized input and symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teetime-entry-guard-'));
  const path = join(dir, 'input.json');
  const bytes = Buffer.from('{"fixed":true}\n');
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(path, bytes);
    expect(await frozenEntryFile(path, digest)).toEqual(bytes);
    await expect(frozenEntryFile(path, '0'.repeat(64))).rejects.toThrow();
    await expect(frozenEntryFile(path, digest, 2)).rejects.toThrow();
    if (process.platform !== 'win32') {
      const link = join(dir, 'linked');
      await symlink(path, link);
      await expect(frozenEntryFile(link, digest)).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
