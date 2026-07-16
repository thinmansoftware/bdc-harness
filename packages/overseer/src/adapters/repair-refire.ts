// Overseer M-42 Slice 4: repair/refire dispatch adapter (injected boundary).
//
// This is the fake/real boundary for replacement-run dispatch. Only a
// deterministic fake is supplied in Slice 4; Slice 8 owns later real wiring
// under separate authority. This module contains no process, network, or
// direct-fire client. The first-attempt path uses the injected on-ramp
// dependency; the later-attempt path uses the injected Smart Cauldron
// conductor (tier selection + cascade) functions. Neither the on-ramp nor the
// conductor is imported from the Smart Cauldron package; both are injected to
// avoid a package cycle.

import type {
  FirstRefireOnRampDepsV1,
  FirstRefireOnRampRequestV1,
  FirstRefireOnRampResultV1,
} from '../actions/repair-refire.ts';

/**
 * Injected Smart Cauldron conductor seam. `pickEntryTier` selects the cheapest
 * appropriate tier; `runCascade` fires that tier and climbs on gate-fail,
 * returning a normalized on-ramp result. Slice 8 supplies the real
 * pickEntryTier/runCascade adaptation; Slice 4 supplies a deterministic fake.
 */
export interface RepairRefireConductorDeps {
  pickEntryTier(input: { readonly woClass?: string; readonly tags?: readonly string[] }): string;
  runCascade(input: {
    readonly woId: string;
    readonly entryTier: string;
    readonly request: FirstRefireOnRampRequestV1;
  }): Promise<FirstRefireOnRampResultV1>;
}

export interface RepairRefireAdapterDeps {
  /** First-attempt direct on-ramp dependency (audit Section 7.5). */
  readonly onRamp: FirstRefireOnRampDepsV1;
  /** Later-attempt Smart Cauldron conductor dependency. */
  readonly conductor: RepairRefireConductorDeps;
  /** Optional WO class forwarded to conductor tier selection. */
  readonly woClass?: string;
  /** Optional WO tags forwarded to conductor tier selection. */
  readonly tags?: readonly string[];
}

export interface RepairRefireAdapter {
  /** Zero-prior-attempt replacement run over the direct on-ramp path. */
  dispatchFirstAttempt(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
  /** Second-attempt replacement run routed through the conductor. */
  dispatchLaterAttempt(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
}

/**
 * Create the injected repair/refire dispatch adapter. The first-attempt path
 * calls the injected on-ramp's startFirstRefire; the later-attempt path calls
 * the injected conductor's pickEntryTier then runCascade. No direct-fire path
 * is reachable, and the two paths never cross: a later attempt never touches
 * the on-ramp, and a first attempt never touches the conductor.
 */
export function createRepairRefireAdapter(deps: RepairRefireAdapterDeps): RepairRefireAdapter {
  return {
    async dispatchFirstAttempt(
      request: FirstRefireOnRampRequestV1
    ): Promise<FirstRefireOnRampResultV1> {
      return deps.onRamp.startFirstRefire(request);
    },

    async dispatchLaterAttempt(
      request: FirstRefireOnRampRequestV1
    ): Promise<FirstRefireOnRampResultV1> {
      const entryTier = deps.conductor.pickEntryTier({ woClass: deps.woClass, tags: deps.tags });
      return deps.conductor.runCascade({ woId: request.wo_id, entryTier, request });
    },
  };
}
