import { createHash } from 'crypto';

export interface ProviderProbeBinding {
  readonly bindingKey?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly authContextId: string;
  readonly assistantConfigHash: string;
  readonly nodeOverrideHash: string;
  readonly options?: Record<string, unknown>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function computeBindingKey(binding: Omit<ProviderProbeBinding, 'bindingKey'>): string {
  return stableHash({
    providerId: binding.providerId,
    modelId: binding.modelId,
    authContextId: binding.authContextId,
    assistantConfigHash: binding.assistantConfigHash,
    nodeOverrideHash: binding.nodeOverrideHash,
  });
}

export function withBindingKey(binding: Omit<ProviderProbeBinding, 'bindingKey'>): ProviderProbeBinding {
  return { ...binding, bindingKey: computeBindingKey(binding) };
}
