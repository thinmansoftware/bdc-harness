// Overseer M-42 Slice 4: repair/refire dispatch adapter (injected boundary).
//
// This is the fake/real boundary for replacement-run and in-place-repair
// dispatch. Only a deterministic fake is supplied in Slice 4; Slice 8 owns
// later real wiring under separate authority. This module contains no
// process, network, or direct-fire client. The three dispatch paths are
// strictly distinct: `dispatchInPlaceRepair` uses the injected in-place
// repair dependency (scope-preserving patch on the exact target, no new
// run), `dispatchFirstAttempt` uses the injected on-ramp (zero-prior-attempt
// replacement run), and `dispatchLaterAttempt` uses the injected Smart
// Cauldron conductor (tier selection + cascade). The three paths never
// cross, and none are imported from the Smart Cauldron package; all are
// injected to avoid a package cycle.

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

/**
 * Injected in-place repair seam. `startInPlaceRepair` applies a
 * scope-preserving patch on the exact target and returns a normalized
 * on-ramp result. Slice 8 supplies the real adaptation; Slice 4 supplies a
 * deterministic fake. This seam is intentionally separate from the on-ramp
 * and the conductor so the `repair` disposition can never be silently
 * downgraded into a replacement-run dispatch.
 */
export interface RepairRefireInPlaceRepairDeps {
  startInPlaceRepair(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
}

export interface RepairRefireAdapterDeps {
  /** First-attempt direct on-ramp dependency (audit Section 7.5). */
  readonly onRamp: FirstRefireOnRampDepsV1;
  /** Later-attempt Smart Cauldron conductor dependency. */
  readonly conductor: RepairRefireConductorDeps;
  /** In-place repair dependency (scope-preserving patch on exact target). */
  readonly inPlaceRepair: RepairRefireInPlaceRepairDeps;
  /** Optional WO class forwarded to conductor tier selection. */
  readonly woClass?: string;
  /** Optional WO tags forwarded to conductor tier selection. */
  readonly tags?: readonly string[];
}

export interface RepairRefireAdapter {
  /**
   * Scope-preserving in-place patch on the exact target. This path never
   * touches the on-ramp or the conductor; it never creates a replacement
   * run.
   */
  dispatchInPlaceRepair(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
  /** Zero-prior-attempt replacement run over the direct on-ramp path. */
  dispatchFirstAttempt(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
  /** Second-attempt replacement run routed through the conductor. */
  dispatchLaterAttempt(request: FirstRefireOnRampRequestV1): Promise<FirstRefireOnRampResultV1>;
}

/**
 * Create the injected repair/refire dispatch adapter. The in-place repair
 * path calls the injected inPlaceRepair.startInPlaceRepair; the first-attempt
 * path calls the injected on-ramp's startFirstRefire; the later-attempt path
 * calls the injected conductor's pickEntryTier then runCascade. No
 * direct-fire path is reachable, and the three paths never cross: a repair
 * never touches the on-ramp or the conductor, a later attempt never touches
 * the on-ramp or in-place repair, and a first attempt never touches the
 * conductor or in-place repair.
 */
export function createRepairRefireAdapter(deps: RepairRefireAdapterDeps): RepairRefireAdapter {
  return {
    async dispatchInPlaceRepair(
      request: FirstRefireOnRampRequestV1
    ): Promise<FirstRefireOnRampResultV1> {
      return deps.inPlaceRepair.startInPlaceRepair(request);
    },

    async dispatchFirstAttempt(
      request: FirstRefireOnRampRequestV1
    ): Promise<FirstRefireOnRampResultV1> {
      return deps.onRamp.startFirstRefire(request);
    },

    async dispatchLaterAttempt(
      request: FirstRefireOnRampRequestV1
    ): Promise<FirstRefireOnRampResultV1> {
      // An explicit workflow/lane override on the request always wins over
      // class/tag-based ruleset routing -- see repair-refire.ts:61
      // (workflow_name, frozen contract, audit Section 7.5).
      const entryTier =
        request.workflow_name ||
        deps.conductor.pickEntryTier({ woClass: deps.woClass, tags: deps.tags });
      return deps.conductor.runCascade({ woId: request.wo_id, entryTier, request });
    },
  };
}
