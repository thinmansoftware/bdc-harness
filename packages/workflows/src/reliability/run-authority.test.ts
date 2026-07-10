import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { IWorkflowStore } from '../store';
import { buildRunAuthority, persistRunAuthority, type RunAuthorityInput } from './run-authority';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'archon-run-authority-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })));
});

function input(overrides: Partial<RunAuthorityInput> = {}): RunAuthorityInput {
  return {
    runId: 'run-1',
    dispatchId: 'dispatch-1',
    woId: 'WO-TEST-01',
    specSource: 'github:bluedevilcollectibles/bdc-xo:docs/work-orders/WO-TEST-01.md',
    specRevision: '1111111111111111111111111111111111111111',
    specBytes: Buffer.from('# Test\nExact bytes.\n', 'utf8'),
    workflowName: 'bdc-feature-development',
    codebaseId: 'codebase-1',
    canonicalRemote: 'https://github.com/bluedevilcollectibles/bdc-harness.git',
    baseBranch: 'dev',
    baseSha: '2222222222222222222222222222222222222222',
    runScopeSha: '2222222222222222222222222222222222222222',
    headBranch: 'archon/thread-test',
    worktreePath: '/worktrees/thread-test',
    workflowRevision: '3333333333333333333333333333333333333333',
    bundleRevision: 'bundle-v1',
    engineRevision: 'engine-v1',
    runtimeImageRevision: null,
    createdAt: '2026-07-09T12:00:00.000Z',
    ...overrides,
  };
}

function store(createResult: 'created' | 'unchanged' = 'created'): IWorkflowStore {
  return {
    getRunAuthority: async () => null,
    createRunAuthority: async () => createResult,
  } as unknown as IWorkflowStore;
}

describe('buildRunAuthority', () => {
  it('hashes the exact spec bytes', () => {
    const lf = buildRunAuthority(input({ specBytes: Buffer.from('line\n', 'utf8') }));
    const crlf = buildRunAuthority(input({ specBytes: Buffer.from('line\r\n', 'utf8') }));

    expect(lf.specHash).toBe(
      'sha256:c73b73af8851e9e91bc6b4dc12e7dace0a2bfb931c1d0b8b36ef367319f58cd1'
    );
    expect(crlf.specHash).not.toBe(lf.specHash);
  });

  it('fails closed when an authority field or the spec is missing', () => {
    expect(() => buildRunAuthority(input({ canonicalRemote: '   ' }))).toThrow(
      'scope_authority_missing: canonicalRemote'
    );
    expect(() => buildRunAuthority(input({ specBytes: Buffer.alloc(0) }))).toThrow(
      'scope_authority_missing: specBytes'
    );
  });
});

describe('persistRunAuthority', () => {
  it('stores exact spec bytes and a mechanical authority manifest', async () => {
    const artifactsDir = await temporaryDirectory();
    const authority = await persistRunAuthority(store(), artifactsDir, input());

    expect(await readFile(join(artifactsDir, 'authority', 'work-order.md'))).toEqual(
      Buffer.from('# Test\nExact bytes.\n', 'utf8')
    );
    expect(
      JSON.parse(await readFile(join(artifactsDir, 'authority', 'run-authority.json'), 'utf8'))
    ).toEqual(authority);
  });

  it('is idempotent for identical bytes and rejects artifact drift', async () => {
    const artifactsDir = await temporaryDirectory();
    await persistRunAuthority(store('created'), artifactsDir, input());
    await expect(
      persistRunAuthority(store('unchanged'), artifactsDir, input())
    ).resolves.toBeDefined();
    await expect(
      persistRunAuthority(
        store('unchanged'),
        artifactsDir,
        input({ specBytes: Buffer.from('# Changed\n', 'utf8') })
      )
    ).rejects.toThrow('authority_conflict: artifact work-order.md drifted');
  });
});
