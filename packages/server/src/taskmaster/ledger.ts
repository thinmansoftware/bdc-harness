/**
 * Taskmaster Slice 1 -- capacity ledger (WO-HARNESS-TASKMASTER-SLICE1-01).
 *
 * The Taskmaster computes its OWN capacity reading. It deliberately does NOT
 * consume the runs-list token meter (api.ts sumWorkflowTokensInWindow), which is
 * fail-open-to-zero: correct for an auxiliary UI line, fatal for a router, because
 * a failed meter is indistinguishable from an empty window.
 *
 * The invariant this module exists to hold:
 *   A FAILED capacity read is represented as UNKNOWN, NEVER as numeric-zero
 *   capacity. currentHeadroom() therefore returns a discriminated union, not a
 *   number -- callers cannot accidentally read 0-on-error as "no headroom".
 */

export type Headroom =
  | { state: 'OK'; value: number }
  | { state: 'UNKNOWN'; isUnknown: true; reason: string };

export interface LedgerDeps {
  /** Read local artifact ledger; may throw. */
  readLocalArtifacts: () => Promise<number>;
  /** Sample the CLI anchor for a capacity figure; may throw. */
  sampleCliAnchor: () => Promise<number>;
  /** Persist an observation (value or is_unknown) for the audit trail. */
  recordUsageSample?: (input: {
    source: string;
    value_json?: string | null;
    confidence?: string | null;
    is_unknown?: boolean;
  }) => Promise<void>;
}

/**
 * Read local workflow artifacts as a capacity signal. Separated so the failure
 * path is explicit and testable. Throws on any read error (the caller decides).
 */
export async function readLocalArtifacts(reader: () => Promise<number>): Promise<number> {
  return reader();
}

/** Sample the CLI anchor. Throws on any failure (the caller decides). */
export async function sampleCliAnchor(sampler: () => Promise<number>): Promise<number> {
  return sampler();
}

/**
 * Compute current headroom. If BOTH the local-artifact read and the CLI anchor
 * sample fail, the result is UNKNOWN -- and an is_unknown usage sample is
 * persisted. This function must NEVER return { state: 'OK', value: 0 } on an
 * error path.
 */
export async function currentHeadroom(deps: LedgerDeps): Promise<Headroom> {
  let local: number | null = null;
  let anchor: number | null = null;
  const failures: string[] = [];

  try {
    local = await readLocalArtifacts(deps.readLocalArtifacts);
  } catch (err) {
    failures.push(`local_artifacts:${(err as Error).message}`);
  }

  try {
    anchor = await sampleCliAnchor(deps.sampleCliAnchor);
  } catch (err) {
    failures.push(`cli_anchor:${(err as Error).message}`);
  }

  // A reading is only trustworthy if at least one source succeeded.
  const readings = [local, anchor].filter((v): v is number => typeof v === 'number');
  if (readings.length === 0) {
    const reason = failures.join('; ') || 'no_capacity_source';
    if (deps.recordUsageSample) {
      await deps.recordUsageSample({ source: 'headroom', is_unknown: true, confidence: 'none' });
    }
    return { state: 'UNKNOWN', isUnknown: true, reason };
  }

  // Conservative: take the minimum of available readings as headroom.
  const value = Math.min(...readings);
  if (deps.recordUsageSample) {
    await deps.recordUsageSample({
      source: 'headroom',
      value_json: JSON.stringify({ value, local, anchor }),
      confidence: readings.length === 2 ? 'high' : 'partial',
      is_unknown: false,
    });
  }
  return { state: 'OK', value };
}
