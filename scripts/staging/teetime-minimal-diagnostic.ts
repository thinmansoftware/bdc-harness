// Unregistered data collector only. No account, worker, CLI or artifact entry.
import type { MessageChunk } from '../../packages/providers/src/types';
import { readCodexFailureOrigin, readCodexSdkFailureEvidence, type CodexFailureOriginRecord } from '../../packages/providers/src/codex/provider';
import type { SdkFailureEvidence } from '../../packages/providers/src/codex/sdk-failure-evidence';
import { ArtifactProviderLifecycle } from './teetime-sdk-lifecycle';
import { classifyCanaryException } from './teetime-canary-result';

export const MINIMAL_DIAGNOSTIC_PROMPT = 'Reply with exactly OK.';
type FailureCode = 'provider_exception' | 'chunk_limit' | 'content_rejected' | 'content_limit'
  | 'unexpected_chunk' | 'order_rejected' | 'terminal_rejected' | 'response_mismatch'
  | 'stream_incomplete' | 'lifecycle_incomplete' | 'aborted' | 'cleanup_failed';
type Hint = 'none' | 'aborted' | 'auth_hint' | 'quota_hint' | 'model_access_hint'
  | 'transport_hint' | 'process_hint' | 'other';
interface Failure {
  readonly code: FailureCode;
  readonly cleanupFailure: boolean;
  readonly exceptionCategory: Hint;
  readonly provenance: Readonly<CodexFailureOriginRecord>;
}
export interface MinimalDiagnosticResult {
  version: 1;
  kind: 'teetime-minimal-diagnostic';
  passed: boolean;
  responseVerified: boolean;
  modelInvocations: number;
  assistantCount: number;
  resultCount: number;
  thinkingCount: number;
  chunkCount: number;
  normalProviderEnd: boolean;
  providerIteratorClosed: boolean;
  aborted: boolean;
  failure: Readonly<Failure> | null;
}
interface FailureV2 extends Failure {
  readonly sdkEvidence: Readonly<SdkFailureEvidence> | null;
}
export interface MinimalDiagnosticV2Result extends Omit<MinimalDiagnosticResult, 'version' | 'failure'> {
  version: 2;
  failure: Readonly<FailureV2> | null;
}
type InternalResult = Omit<MinimalDiagnosticResult, 'version' | 'failure'> & {
  version: 1 | 2;
  failure: Readonly<Failure | FailureV2> | null;
};
function hint(error: unknown, aborted: boolean): Hint {
  try { return classifyCanaryException(error, aborted) as Hint; }
  catch { return aborted ? 'aborted' : 'other'; }
}
function failure(code: FailureCode, provenance = readCodexFailureOrigin(null),
  exceptionCategory: Hint = 'none'): Readonly<Failure> {
  return Object.freeze({ code, provenance, exceptionCategory, cleanupFailure: false });
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

// The future caller must independently enforce its process deadline/reaping and
// all authority/credential/workspace gates. This function grants none of them.
export function collectMinimalDiagnostic(
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  controller: AbortController,
  onClosed: () => void
): Promise<Readonly<MinimalDiagnosticResult>> {
  return collect(1, query, controller, onClosed) as Promise<Readonly<MinimalDiagnosticResult>>;
}

// Source-only v2 API. No runtime entry or installed execution package selects it.
export function collectMinimalDiagnosticV2(
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  controller: AbortController,
  onClosed: () => void
): Promise<Readonly<MinimalDiagnosticV2Result>> {
  return collect(2, query, controller, onClosed) as Promise<Readonly<MinimalDiagnosticV2Result>>;
}

async function collect(version: 1 | 2,
  query: (prompt: string, signal: AbortSignal) => AsyncIterable<MessageChunk>,
  controller: AbortController, onClosed: () => void): Promise<Readonly<InternalResult>> {
  const result: InternalResult = {
    version, kind: 'teetime-minimal-diagnostic', passed: false, responseVerified: false,
    modelInvocations: 0, assistantCount: 0, resultCount: 0, thinkingCount: 0,
    chunkCount: 0, normalProviderEnd: false, providerIteratorClosed: false,
    aborted: false, failure: null,
  };
  let primary: Readonly<Failure | FailureV2> | undefined;
  function recordFailure(code: FailureCode, provenance = readCodexFailureOrigin(null),
    category: Hint = 'none', error?: unknown): Readonly<Failure | FailureV2> {
    const base = failure(code, provenance, category);
    return version === 1 ? base : Object.freeze({...base,
      sdkEvidence: provenance.origin === 'sdk_iterator_exception' ? readCodexSdkFailureEvidence(error) : null});
  }
  let cleanupFailed = false, examinedBytes = 0, assistantText = '';
  function reject(code: FailureCode, provenance = readCodexFailureOrigin(null)): never {
    primary ??= recordFailure(code, provenance);
    throw new Error('minimal diagnostic rejected');
  }
  const lifecycle = new ArtifactProviderLifecycle(controller, () => {
    try { onClosed(); }
    catch {
      cleanupFailed = true;
      primary ??= recordFailure('cleanup_failed');
      throw new Error('minimal diagnostic cleanup failed');
    }
  });
  try {
    if (controller.signal.aborted) reject('aborted');
    result.modelInvocations = 1;
    async function* chunks(): AsyncGenerator<MessageChunk> {
      try { for await (const chunk of query(MINIMAL_DIAGNOSTIC_PROMPT, controller.signal)) yield chunk; }
      catch (error) {
        // Snapshot before lifecycle cleanup can change the signal. Raw error
        // text stays in the existing hint classifier and never enters a packet.
        if (primary) cleanupFailed = true; // An exception while unwinding a known failure.
        else primary = recordFailure('provider_exception', readCodexFailureOrigin(error),
          hint(error, controller.signal.aborted), error);
        throw error;
      }
    }
    for await (const chunk of lifecycle.observe(chunks())) {
      try {
        result.chunkCount++;
        if (result.chunkCount > 64) reject('chunk_limit');
        if (controller.signal.aborted) reject('aborted');
        if (!chunk || typeof chunk !== 'object') reject('content_rejected');
        if (chunk.type === 'result') {
          result.resultCount++;
          if ((chunk.isError !== undefined && chunk.isError !== false)
            || (chunk.errors !== undefined && (!Array.isArray(chunk.errors) || chunk.errors.length !== 0))
            || chunk.errorSubtype !== undefined) {
            reject('terminal_rejected', readCodexFailureOrigin(chunk));
          }
          if (result.resultCount !== 1 || result.assistantCount !== 1) reject('order_rejected');
          continue;
        }
        if (chunk.type !== 'assistant' && chunk.type !== 'thinking') reject('unexpected_chunk');
        if (chunk.type === 'assistant') result.assistantCount++;
        else result.thinkingCount++;
        if (result.resultCount || result.assistantCount > 1) reject('order_rejected');
        const content = chunk.content;
        if (typeof content !== 'string') reject('content_rejected');
        if (content.length > 16384) reject('content_limit');
        if (!wellFormed(content)) reject('content_rejected');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > 16384 || examinedBytes + bytes > 16384
          || (chunk.type === 'assistant' && bytes > 64)) reject('content_limit');
        examinedBytes += bytes;
        if (chunk.type === 'assistant') assistantText = content;
      } catch (error) {
        // Latch interpretation failures before for-await closes the SDK iterator.
        primary ??= recordFailure('content_rejected');
        throw error;
      }
    }
    if (controller.signal.aborted) reject('aborted');
    if (result.assistantCount !== 1 || result.resultCount !== 1) reject('stream_incomplete');
    if (!lifecycle.closed || !lifecycle.normalEnd) reject('lifecycle_incomplete');
    // Deliberately ASCII-only trim. Unicode whitespace never becomes success.
    if (assistantText.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '') !== 'OK') reject('response_mismatch');
    result.passed = result.responseVerified = true;
  } catch {
    result.passed = result.responseVerified = false;
    primary ??= recordFailure('content_rejected');
  } finally {
    assistantText = '';
    lifecycle.abortIfActive();
    result.normalProviderEnd = lifecycle.normalEnd;
    result.providerIteratorClosed = lifecycle.closed;
    result.aborted = controller.signal.aborted;
    if (primary) result.failure = Object.freeze({ ...primary, cleanupFailure: cleanupFailed });
  }
  return Object.freeze(result);
}
