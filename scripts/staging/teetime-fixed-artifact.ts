// Fixed compliance fixture only. Not a general product prompt or authority loader.
import { createHash } from 'node:crypto';
import type { MessageChunk } from '../../packages/providers/src/types';
import { collectArtifactStream } from './teetime-artifact-stream';
import { ArtifactProviderLifecycle } from './teetime-sdk-lifecycle';

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export function createFixedArtifactContract(
  nonce: string,
  policyHash: string
): Readonly<{
  runId: string;
  expectedText: string;
  prompt: string;
}> {
  if (
    typeof nonce !== 'string' ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    typeof policyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(policyHash)
  )
    throw new Error('fixed artifact binding rejected');
  // Exact sorted-key snapshot_manifest representation, independently derived in Python.
  const binary = Buffer.from([0, 255, ...Buffer.from('binary')]);
  const executable = Buffer.from('#!/bin/sh\nexit 0\n');
  const manifest = JSON.stringify({
    files: [
      { mode: '100644', path: 'data.bin', sha256: sha256(binary), size: binary.length },
      { mode: '100755', path: 'src/run.sh', sha256: sha256(executable), size: executable.length },
    ],
    version: 1,
  });
  const runId = 'teetime-artifact-' + nonce;
  const expectedText = JSON.stringify({
    version: 1,
    binding: {
      runId,
      nodeId: 'implement',
      attempt: 1,
      authorityHash: 'sha256:' + 'a'.repeat(64),
      policyHash: 'sha256:' + policyHash,
      baseManifestHash: sha256(manifest),
    },
    operations: [
      {
        action: 'write',
        path: 'index.html',
        baseHash: null,
        mode: '100644',
        content: '<p>synthetic-artifact-ready</p>\n',
      },
    ],
  });
  const prompt =
    'Synthetic infrastructure compliance check, not application work. ' +
    'Do not read files, use tools, run commands, modify paths, call services, or add commentary. ' +
    'Return exactly the following JSON bytes in one assistant message. ' +
    'No markdown, surrounding spaces, or trailing newline. The authority binding is synthetic.\n' +
    expectedText;
  return Object.freeze({ runId, expectedText, prompt });
}

export interface FixedArtifactResult {
  kind: 'fixed-artifact-v1';
  passed: boolean;
  artifactBase64: string | null;
  modelInvocations: number;
  assistantCount: number;
  resultCount: number;
  thinkingCount: number;
  normalProviderEnd: boolean;
  providerIteratorClosed: boolean;
  aborted: boolean;
  failureCategory: 'none' | 'rejected';
  servedModelVerified: false;
}

export async function runFixedArtifactTask(
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  nonce: string,
  policyHash: string,
  controller: AbortController,
  onClosed: () => void
): Promise<Readonly<FixedArtifactResult>> {
  const contract = createFixedArtifactContract(nonce, policyHash);
  const lifecycle = new ArtifactProviderLifecycle(controller, onClosed);
  const result: FixedArtifactResult = {
    kind: 'fixed-artifact-v1',
    passed: false,
    artifactBase64: null,
    modelInvocations: 0,
    assistantCount: 0,
    resultCount: 0,
    thinkingCount: 0,
    normalProviderEnd: false,
    providerIteratorClosed: false,
    aborted: false,
    failureCategory: 'rejected',
    servedModelVerified: false,
  };
  try {
    if (controller.signal.aborted) throw new Error('fixed task aborted');
    result.modelInvocations++;
    const stream = lifecycle.observe(query(contract.prompt, controller.signal));
    async function* observed(): AsyncGenerator<MessageChunk> {
      for await (const chunk of stream) {
        if (chunk.type === 'assistant') result.assistantCount++;
        if (chunk.type === 'result') result.resultCount++;
        if (chunk.type === 'thinking') result.thinkingCount++;
        yield chunk;
      }
    }
    const raw = await collectArtifactStream(observed(), controller.signal);
    if (
      !Buffer.from(raw).equals(Buffer.from(contract.expectedText, 'utf8')) ||
      !lifecycle.closed ||
      !lifecycle.normalEnd ||
      controller.signal.aborted
    )
      throw new Error('fixed artifact bytes rejected');
    // Equality to the fixed canonical JSON proves schema/binding/content before emission.
    // No rejected raw bytes, provider text or exception strings reach this result.
    result.artifactBase64 = Buffer.from(raw).toString('base64');
    result.passed = true;
    result.failureCategory = 'none';
  } catch {
    result.artifactBase64 = null;
    lifecycle.abortIfActive();
  } finally {
    lifecycle.abortIfActive();
    result.normalProviderEnd = lifecycle.normalEnd;
    result.providerIteratorClosed = lifecycle.closed;
    result.aborted = controller.signal.aborted;
  }
  return Object.freeze(result);
}
