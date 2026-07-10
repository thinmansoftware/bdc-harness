import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { WorkflowDefinition } from '../schemas';
import { BUNDLED_POLICIES } from '../defaults/bundled-defaults';

const ENGINE_SOURCE_URL = new URL('../executor.ts', import.meta.url);

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function hashWorkflowDefinition(workflow: WorkflowDefinition): string {
  return sha256(JSON.stringify(workflow));
}

export async function captureRuntimeRevisions(workflow: WorkflowDefinition): Promise<{
  readonly workflowRevision: string;
  readonly bundleRevision: string;
  readonly engineRevision: string;
  readonly runtimeImageRevision: string | null;
}> {
  return {
    workflowRevision: hashWorkflowDefinition(workflow),
    bundleRevision: sha256(JSON.stringify(BUNDLED_POLICIES)),
    engineRevision: sha256(await readFile(ENGINE_SOURCE_URL)),
    runtimeImageRevision: process.env.ARCHON_RUNTIME_IMAGE_REVISION ?? null,
  };
}
