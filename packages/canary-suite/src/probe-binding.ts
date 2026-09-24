import {
  probeProviderBinding,
  type IAgentProvider,
  type ProviderProbeResult,
} from '@archon/providers';

export interface ProbeBindingDeps {
  readonly getAgentProvider: (providerId: string) => IAgentProvider;
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function runProbeBinding(
  providerId: string,
  modelId: string,
  cwd: string,
  deps: ProbeBindingDeps
): Promise<ProviderProbeResult> {
  return probeProviderBinding(
    {
      providerId,
      modelId,
      authContextId: 'canary-cli',
      assistantConfigHash: 'canary-cli',
      nodeOverrideHash: 'canary-cli',
      options: { model: modelId },
    },
    cwd,
    deps
  );
}

export function formatProbeBindingResult(result: ProviderProbeResult): string {
  if (result.ok) return `ok: ${result.binding.providerId}/${result.binding.modelId}`;
  return `${result.classification.kind}: ${result.classification.errorClass}`;
}
