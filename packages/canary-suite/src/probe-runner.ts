import type { ProviderProbeDeps } from '@archon/providers/probe';

export interface Layer2TrivialFireInput {
  readonly lane: string;
  readonly layer1Green: boolean;
}

export async function runLayer2TrivialFire(input: Layer2TrivialFireInput): Promise<'aborted' | 'build_failed'> {
  if (!input.layer1Green) return 'aborted';
  return 'build_failed';
}

export async function runLayer1Probe(_deps: ProviderProbeDeps): Promise<'probe_passed'> {
  return 'probe_passed';
}
