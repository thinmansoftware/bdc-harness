import type { IAgentProvider, MessageChunk } from '../types';
import { CodexProvider } from './provider';
import { RESTRICTED_MODEL, RESTRICTED_WORKSPACE } from './restricted-policy';

export interface RestrictedWorkerBinding {
  runId: string;
  policyDigest: string;
  workspace: string;
}

// Unregistered worker-local adapter. Syntax is not authority: the future caller
// must verify persisted run authority and the separately reviewed policy first.
// The caller owns process/handle custody; this interface cannot authenticate a
// different run that obtains the handle. Never put it in the global registry.
export function createRestrictedWorkerProvider(input: RestrictedWorkerBinding): IAgentProvider {
  const binding = Object.freeze({ ...input });
  if (
    typeof binding.runId !== 'string' ||
    typeof binding.policyDigest !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(binding.runId) ||
    !/^sha256:[a-f0-9]{64}$/.test(binding.policyDigest) ||
    binding.workspace !== RESTRICTED_WORKSPACE ||
    process.cwd() !== RESTRICTED_WORKSPACE
  )
    throw new Error('invalid restricted worker binding');
  const provider = new CodexProvider({ restricted: true });
  let active = false;
  return Object.freeze({
    getType: () => provider.getType(),
    getCapabilities: () => ({ ...provider.getCapabilities(), sessionResume: false }),
    async *sendQuery(prompt, cwd, resume, options): AsyncGenerator<MessageChunk> {
      if (cwd !== binding.workspace || process.cwd() !== binding.workspace)
        throw new Error('restricted worker workspace mismatch');
      if (resume !== undefined) throw new Error('restricted worker resume is not admitted');
      if (Object.keys(options ?? {}).some(key => key !== 'model' && key !== 'abortSignal'))
        throw new Error('restricted worker option override rejected');
      if (options?.model !== undefined && options.model !== RESTRICTED_MODEL)
        throw new Error('restricted worker model mismatch');
      if (active) throw new Error('restricted worker overlapping call rejected');
      active = true;
      try {
        yield* provider.sendQuery(prompt, binding.workspace, undefined, {
          model: RESTRICTED_MODEL,
          abortSignal: options?.abortSignal,
        });
      } finally {
        active = false;
      }
    },
  } satisfies IAgentProvider);
}
