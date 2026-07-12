import type { IAgentProvider, SendQueryOptions } from '../types';
import { classifyProbeError, type ProbeClassification } from './probe-classifier';

export interface ProviderProbeBinding {
  readonly providerId: string;
  readonly modelId?: string;
  readonly options?: SendQueryOptions;
}

export type ProviderFactory = (providerId: string) => IAgentProvider;

export interface ProviderProbeResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly classification?: ProbeClassification;
}

export async function runProviderProbe(
  binding: ProviderProbeBinding,
  cwd: string,
  getProvider: ProviderFactory,
  options: { readonly retryDelayMs?: number } = {}
): Promise<ProviderProbeResult> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let lastClassification: ProbeClassification | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const provider = getProvider(binding.providerId);
      const requestOptions: SendQueryOptions = {
        ...(binding.options ?? {}),
        model: binding.modelId ?? binding.options?.model,
      };
      for await (const _chunk of provider.sendQuery(
        'Reply with exactly: OK',
        cwd,
        undefined,
        requestOptions
      )) {
        // Consuming the stream is the evidence that the provider accepted the request.
      }
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastClassification = classifyProbeError(error);
      if (attempt === 1 && shouldRetry(lastClassification)) {
        await delay(retryDelayMs);
        continue;
      }
      return { ok: false, attempts: attempt, classification: lastClassification };
    }
  }

  return { ok: false, attempts: 2, classification: lastClassification };
}

function shouldRetry(classification: ProbeClassification): boolean {
  return classification.kind === 'transient' || classification.kind === 'unknown';
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
