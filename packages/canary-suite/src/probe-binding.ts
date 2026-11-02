import {
  probeProviderBinding,
  type ProviderProbeBinding,
  type ProviderProbeDeps,
} from '@archon/providers/probe';

export interface ProbeBindingCommandDeps extends ProviderProbeDeps {
  readonly cwd?: string;
}

export interface ProbeBindingCommandResult {
  readonly exitCode: number;
  readonly output: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

export async function runProbeBindingCommand(
  args: readonly string[],
  deps: ProbeBindingCommandDeps
): Promise<ProbeBindingCommandResult> {
  const providerId = flag(args, '--provider');
  const modelId = flag(args, '--model');
  if (!providerId || !modelId) {
    return { exitCode: 2, output: 'probe_binding_missing_required_argument' };
  }

  const binding: ProviderProbeBinding = {
    providerId,
    modelId,
    authContextId: 'cli-probe',
    assistantConfigHash: 'cli-probe',
    nodeOverrideHash: 'cli-probe',
    options: { model: modelId },
  };

  const result = await probeProviderBinding(binding, deps.cwd ?? process.cwd(), deps);
  if (result.ok) return { exitCode: 0, output: 'ok' };
  return { exitCode: 2, output: JSON.stringify(result.classification) };
}
