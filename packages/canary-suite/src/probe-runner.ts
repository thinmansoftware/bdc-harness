import type { ProviderProbeDeps } from '@archon/providers/probe';
import type {
  FireTimeProbeDecision,
  FireTimeProbeInput,
} from '@archon/workflows/reliability/fire-time-probe';
import { runFireTimeProbe } from '@archon/workflows/reliability/fire-time-probe';

export interface Layer2TrivialFireResult {
  readonly verdict: 'aborted' | 'build_failed' | 'passed';
  readonly prUrl?: string;
  readonly headSha?: string;
}

export interface Layer2TrivialDispatchResult {
  readonly prUrl: string;
  readonly headSha: string;
}

export type Layer2TrivialDispatch = (input: {
  readonly lane: string;
}) => Promise<Layer2TrivialDispatchResult>;

export interface Layer2TrivialFireInput {
  readonly lane: string;
  readonly layer1Green: boolean;
  readonly providerProbeDeps?: ProviderProbeDeps;
  readonly fireTimeProbeInput?: FireTimeProbeInput;
  readonly runProbe?: (
    deps: ProviderProbeDeps,
    input: FireTimeProbeInput
  ) => Promise<FireTimeProbeDecision>;
  readonly dispatch?: Layer2TrivialDispatch;
}

function hasOpenPrEvidence(result: Layer2TrivialDispatchResult): boolean {
  return (
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(result.prUrl) &&
    /^[a-f0-9]{40}$/.test(result.headSha)
  );
}

function defaultDispatch(): Layer2TrivialDispatch {
  throw new Error('layer2_trivial_fire_dispatch_required');
}

export async function runLayer2TrivialFire(
  input: Layer2TrivialFireInput
): Promise<Layer2TrivialFireResult> {
  if (!input.layer1Green) return { verdict: 'aborted' };
  if (!input.providerProbeDeps || !input.fireTimeProbeInput) {
    throw new Error('layer2_trivial_fire_probe_context_required');
  }

  const probe = input.runProbe ?? runFireTimeProbe;
  const decision = await probe(input.providerProbeDeps, input.fireTimeProbeInput);
  if (decision.blocked) return { verdict: 'build_failed' };

  const dispatch = input.dispatch ?? defaultDispatch();
  const result = await dispatch({ lane: input.lane });
  if (!hasOpenPrEvidence(result)) return { verdict: 'build_failed' };
  return { verdict: 'passed', prUrl: result.prUrl, headSha: result.headSha };
}

export async function runLayer1Probe(_deps: ProviderProbeDeps): Promise<'probe_passed'> {
  return 'probe_passed';
}
