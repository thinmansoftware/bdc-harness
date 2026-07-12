import { createHash } from 'crypto';

export interface ProviderBindingFingerprint {
  readonly providerId: string;
  readonly modelId: string;
  readonly authContextId: string;
  readonly assistantConfigHash: string;
  readonly nodeOverrideHash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function createBindingKey(binding: ProviderBindingFingerprint): string {
  return stableHash({
    providerId: binding.providerId,
    modelId: binding.modelId,
    authContextId: binding.authContextId,
    assistantConfigHash: binding.assistantConfigHash,
    nodeOverrideHash: binding.nodeOverrideHash,
  });
}

export function hashAssistantConfig(config: unknown): string {
  return stableHash(redactSecrets(config));
}

export function hashNodeOverride(config: unknown): string {
  return stableHash(redactSecrets(config));
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /token|secret|password|api[_-]?key|credential/i.test(key) ? '[REDACTED]' : redactSecrets(item),
    ])
  );
}
