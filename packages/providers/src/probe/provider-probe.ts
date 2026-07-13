import type { IAgentProvider, MessageChunk, SendQueryOptions } from '../types';
import type { ProviderProbeBinding } from './binding-key';
import { classifyProbeError, type ProbeClassification } from './probe-classifier';

export interface ProviderProbeDeps {
  readonly getAgentProvider: (providerId: string) => IAgentProvider;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ProviderProbeResult =
  | { readonly ok: true; readonly binding: ProviderProbeBinding }
  | {
      readonly ok: false;
      readonly binding: ProviderProbeBinding;
      readonly classification: ProbeClassification;
      readonly attempts: number;
    };

function resultChunkFailed(chunk: MessageChunk): string | null {
  if (chunk.type !== 'result' || !chunk.isError) return null;
  return (
    [chunk.stopReason, ...(chunk.errors ?? [])].filter(Boolean).join(' ') || 'probe_result_error'
  );
}

async function runSingleProbe(
  binding: ProviderProbeBinding,
  cwd: string,
  provider: IAgentProvider
): Promise<void> {
  const options = binding.options as SendQueryOptions | undefined;
  for await (const chunk of provider.sendQuery('Reply with exactly: OK', cwd, undefined, {
    ...options,
    maxBudgetUsd: 0.01,
  })) {
    const error = resultChunkFailed(chunk);
    if (error) throw new Error(error);
    if (chunk.type === 'assistant' || chunk.type === 'result') return;
  }
}

export async function probeProviderBinding(
  binding: ProviderProbeBinding,
  cwd: string,
  deps: ProviderProbeDeps
): Promise<ProviderProbeResult> {
  const provider = deps.getAgentProvider(binding.providerId);
  const sleep =
    deps.sleep ??
    ((ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastClassification: ProbeClassification | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await runSingleProbe(binding, cwd, provider);
      return { ok: true, binding };
    } catch (error) {
      const classification = classifyProbeError(error);
      lastClassification = classification;
      if (classification.kind === 'transient' && attempt === 1) {
        await sleep(2000);
        continue;
      }
      if (classification.kind === 'structural' && attempt === 1) {
        await sleep(2000);
        continue;
      }
      return { ok: false, binding, classification, attempts: attempt };
    }
  }

  return {
    ok: false,
    binding,
    classification: lastClassification ?? classifyProbeError(new Error('probe_failed_unknown')),
    attempts: 2,
  };
}
