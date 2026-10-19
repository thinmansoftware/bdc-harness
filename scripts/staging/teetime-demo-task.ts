// Source-only demo collection. The Python worker must validate the candidate
// against the frozen prepared base before treating these bytes as an artifact.
import { createHash } from 'node:crypto';
import type { MessageChunk } from '../../packages/providers/src/types';
import { collectArtifactStream } from './teetime-artifact-stream';
import { ArtifactProviderLifecycle } from './teetime-sdk-lifecycle';
import { classifyCanaryException } from './teetime-canary-result';

export interface DemoFailureDiagnostic {
  stage: 'input' | 'policy' | 'provider_initialization' | 'stream' | 'finalization';
  exceptionCategory: string;
  lastEvent: 'none' | 'assistant' | 'result' | 'thinking' | 'system' | 'tool_call' | 'tool_result' | 'other';
}

export interface DemoTaskResult {
  kind: 'supervised-demo-v1';
  collected: boolean;
  artifactBase64: string | null;
  modelInvocations: number;
  assistantCount: number;
  resultCount: number;
  thinkingCount: number;
  normalProviderEnd: boolean;
  providerIteratorClosed: boolean;
  aborted: boolean;
  servedModelVerified: false;
  failureDiagnostic?: Readonly<DemoFailureDiagnostic>;
}

export async function collectDemoTask(
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  prompt: string,
  expectedPromptHash: string,
  controller: AbortController,
  onClosed: () => void
): Promise<Readonly<DemoTaskResult>> {
  const result: DemoTaskResult = {
    kind: 'supervised-demo-v1',
    collected: false,
    artifactBase64: null,
    modelInvocations: 0,
    assistantCount: 0,
    resultCount: 0,
    thinkingCount: 0,
    normalProviderEnd: false,
    providerIteratorClosed: false,
    aborted: false,
    servedModelVerified: false,
  };
  const lifecycle = new ArtifactProviderLifecycle(controller, onClosed);
  let stage: DemoFailureDiagnostic['stage'] = 'input';
  let lastEvent: DemoFailureDiagnostic['lastEvent'] = 'none';
  let providerException: string | undefined;
  try {
    if (
      typeof prompt !== 'string' ||
      !/^[\x01-\x7f]{1,131072}$/.test(prompt) ||
      typeof expectedPromptHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedPromptHash) ||
      createHash('sha256').update(prompt, 'ascii').digest('hex') !== expectedPromptHash ||
      controller.signal.aborted
    )
      throw new Error('demo input rejected');
    result.modelInvocations++;
    stage = 'stream';
    async function* providerChunks(): AsyncGenerator<MessageChunk> {
      try {
        for await (const chunk of query(prompt, controller.signal)) yield chunk;
      } catch (error) {
        // Classify the original exception before the collector redacts it and
        // before cleanup can change the abort signal. Never retain raw text.
        providerException = classifyCanaryException(error, controller.signal.aborted);
        throw error;
      }
    }
    const stream = lifecycle.observe(providerChunks());
    async function* observed(): AsyncGenerator<MessageChunk> {
      for await (const chunk of stream) {
        lastEvent = ['assistant','result','thinking','system','tool_call','tool_result'].includes(chunk.type)
          ? chunk.type as DemoFailureDiagnostic['lastEvent'] : 'other';
        if (chunk.type === 'assistant') result.assistantCount++;
        if (chunk.type === 'result') result.resultCount++;
        if (chunk.type === 'thinking') result.thinkingCount++;
        yield chunk;
      }
    }
    const raw = await collectArtifactStream(observed(), controller.signal);
    stage = 'finalization';
    if (!lifecycle.closed || !lifecycle.normalEnd || controller.signal.aborted)
      throw new Error('demo collection did not close normally');
    // This is explicitly unvalidated data, never an approval or successful build.
    result.artifactBase64 = Buffer.from(raw).toString('base64');
    result.collected = true;
  } catch (error) {
    result.artifactBase64 = null;
    result.failureDiagnostic = Object.freeze({stage, lastEvent,
      exceptionCategory: providerException ?? classifyCanaryException(error, controller.signal.aborted)});
  } finally {
    lifecycle.abortIfActive();
    result.normalProviderEnd = lifecycle.normalEnd;
    result.providerIteratorClosed = lifecycle.closed;
    result.aborted = controller.signal.aborted;
  }
  return Object.freeze(result);
}
