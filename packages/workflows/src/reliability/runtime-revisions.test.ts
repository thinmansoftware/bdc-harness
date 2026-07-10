import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { expect, test } from 'bun:test';
import { BUNDLED_POLICIES } from '../defaults/bundled-defaults';
import type { WorkflowDefinition } from '../schemas';
import { captureRuntimeRevisions, hashWorkflowDefinition } from './runtime-revisions';

const workflow = {
  name: 'fixture',
  description: 'fixture',
  provider: 'claude',
  nodes: [],
} as WorkflowDefinition;

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('workflow hashing is deterministic and prefixed', () => {
  expect(hashWorkflowDefinition(workflow)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(hashWorkflowDefinition(workflow)).toBe(sha256(JSON.stringify(workflow)));
});

test('runtime revisions preserve executor, bundle, and image authority values', async () => {
  const original = process.env.ARCHON_RUNTIME_IMAGE_REVISION;
  process.env.ARCHON_RUNTIME_IMAGE_REVISION = 'sha256:image-fixture';
  try {
    const revisions = await captureRuntimeRevisions(workflow);
    const executorSource = await readFile(new URL('../executor.ts', import.meta.url));
    expect(revisions.engineRevision).toBe(sha256(executorSource));
    expect(revisions.bundleRevision).toBe(sha256(JSON.stringify(BUNDLED_POLICIES)));
    expect(revisions.workflowRevision).toBe(hashWorkflowDefinition(workflow));
    expect(revisions.runtimeImageRevision).toBe('sha256:image-fixture');
  } finally {
    if (original === undefined) delete process.env.ARCHON_RUNTIME_IMAGE_REVISION;
    else process.env.ARCHON_RUNTIME_IMAGE_REVISION = original;
  }
});
