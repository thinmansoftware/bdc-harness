import {
  probeProviderBinding,
  type ProviderProbeDeps,
  type ProviderProbeResult,
} from '@archon/providers';

export interface ProbeBindingRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly cwd?: string;
}

export interface ProbeBindingDeps extends ProviderProbeDeps {
  readonly probe?: typeof probeProviderBinding;
}

/**
 * Manual operator probe for one (provider, model) binding.
 * Placeholder auth/config hashes are intentional: this is not a routed node.
 */
export async function runProbeBinding(
  request: ProbeBindingRequest,
  deps: ProbeBindingDeps
): Promise<ProviderProbeResult> {
  const probe = deps.probe ?? probeProviderBinding;
  return probe(
    {
      providerId: request.providerId,
      modelId: request.modelId,
      authContextId: 'manual-probe',
      assistantConfigHash: 'manual-probe',
      nodeOverrideHash: 'manual-probe',
      options: { model: request.modelId },
    },
    request.cwd ?? process.cwd(),
    { getAgentProvider: deps.getAgentProvider, sleep: deps.sleep }
  );
}
