import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import type { IWorkflowStore } from '../store';
import type { RunAuthorityRecord } from './types';

export interface FrozenSpecSource {
  readonly woId: string;
  readonly specSource: string;
  readonly specRevision: string;
  readonly specBytes: Uint8Array;
}

export interface RunAuthorityDispatch extends FrozenSpecSource {
  readonly dispatchId: string;
}

export interface RunAuthorityInput extends Omit<RunAuthorityRecord, 'specHash'> {
  readonly specBytes: Uint8Array;
}

const REQUIRED_TEXT_FIELDS = [
  'runId',
  'dispatchId',
  'woId',
  'specSource',
  'specRevision',
  'workflowName',
  'codebaseId',
  'canonicalRemote',
  'baseBranch',
  'baseSha',
  'runScopeSha',
  'headBranch',
  'worktreePath',
  'workflowRevision',
  'bundleRevision',
  'engineRevision',
  'createdAt',
] as const satisfies readonly (keyof RunAuthorityInput)[];

function assertAuthorityInput(input: RunAuthorityInput): void {
  for (const field of REQUIRED_TEXT_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`scope_authority_missing: ${field}`);
    }
  }
  if (input.specBytes.byteLength === 0) {
    throw new Error('scope_authority_missing: specBytes');
  }
}

export function buildRunAuthority(input: RunAuthorityInput): RunAuthorityRecord {
  assertAuthorityInput(input);
  const { specBytes, ...authority } = input;
  return {
    ...authority,
    specHash: `sha256:${createHash('sha256').update(specBytes).digest('hex')}`,
  };
}

function authoritiesEqual(left: RunAuthorityRecord, right: RunAuthorityRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function ensureArtifact(path: string, expected: Uint8Array, name: string): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(expected))) {
      throw new Error(`authority_conflict: artifact ${name} drifted`);
    }
    return;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') throw error;
  }

  try {
    await writeFile(path, expected, { flag: 'wx' });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (!existing.equals(Buffer.from(expected))) {
      throw new Error(`authority_conflict: artifact ${name} drifted`);
    }
  }
}

export async function persistRunAuthority(
  store: IWorkflowStore,
  artifactsDir: string,
  input: RunAuthorityInput
): Promise<RunAuthorityRecord> {
  const authority = buildRunAuthority(input);
  const existing = await store.getRunAuthority(authority.runId);
  if (existing && !authoritiesEqual(existing, authority)) {
    throw new Error(`authority_conflict: run ${authority.runId}`);
  }

  const authorityDir = join(artifactsDir, 'authority');
  await mkdir(authorityDir, { recursive: true });
  await ensureArtifact(join(authorityDir, 'work-order.md'), input.specBytes, 'work-order.md');
  const manifestBytes = Buffer.from(`${JSON.stringify(authority, null, 2)}\n`, 'utf8');
  await ensureArtifact(
    join(authorityDir, 'run-authority.json'),
    manifestBytes,
    'run-authority.json'
  );
  await store.createRunAuthority(authority);
  return authority;
}
