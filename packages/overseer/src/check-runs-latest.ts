/**
 * Reduce a head's raw check-runs to the newest run per check NAME.
 *
 * GitHub's `checks.listForRef` returns EVERY run at a head, including older
 * runs of a check that has since been re-run. Counting them all lets a stale
 * failure block a PR whose check later passed (or vice versa: a stale success
 * hide a real regression). This module groups the runs by trimmed name and, per
 * name, keeps only the current run:
 *
 * - the newest COMPLETED run, ordered by `completed_at` then by `id` (id breaks
 *   completed_at ties -- see #1048 live evidence where two runs share a head);
 * - unless a same-name run that is NOT completed has a higher `id` than that
 *   newest completed run, in which case the check is running again and its
 *   current state is that in-flight (pending) run, never the older completed
 *   conclusion.
 *
 * Fail closed on the legacy stub shape: if ANY run in a name group lacks a
 * numeric `id` we cannot order the group, so it is returned unreduced (every
 * run kept in `current`, nothing superseded). This preserves the exact
 * behaviour existing `{ name, status, conclusion }` callers/tests rely on.
 *
 * Pure function, no SDK/octokit imports -- safe to import from tests and from
 * the collection sites in adapters/github-real-deps.ts.
 */

/** A single check-run as reported by GitHub (fields beyond these are ignored). */
export interface LatestCheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
  id?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

/** A superseded (older) run, tagged with the id of the run that replaced it. */
export interface SupersededCheckRun extends LatestCheckRun {
  superseded_by: number;
}

/** Result of reducing a head's runs to the current run per check name. */
export interface ReducedCheckRuns {
  current: LatestCheckRun[];
  superseded: SupersededCheckRun[];
}

type IdentifiedCheckRun = LatestCheckRun & { id: number };

function hasNumericId(run: LatestCheckRun): run is IdentifiedCheckRun {
  return typeof run.id === 'number';
}

function isCompleted(run: LatestCheckRun): boolean {
  return run.status === 'completed';
}

/**
 * Sortable rank for `completed_at`. A missing or unparseable timestamp ranks
 * lowest so a run that carries a real timestamp always wins over one that does
 * not; the `id` tie-break then orders equal timestamps deterministically.
 */
function completedAtRank(run: LatestCheckRun): number {
  if (!run.completed_at) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(run.completed_at);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** True when `run` is a newer COMPLETED run than `best` (completed_at, then id). */
function isNewerCompleted(run: IdentifiedCheckRun, best: IdentifiedCheckRun): boolean {
  const runRank = completedAtRank(run);
  const bestRank = completedAtRank(best);
  if (runRank !== bestRank) return runRank > bestRank;
  return run.id > best.id;
}

/**
 * Group `runs` by trimmed name and return the current run per name plus the
 * older runs it superseded. Distinct names are preserved in first-seen order;
 * single-run names pass through unchanged.
 */
export function reduceToLatestCheckRuns(runs: LatestCheckRun[]): ReducedCheckRuns {
  const groups = new Map<string, LatestCheckRun[]>();
  for (const run of runs) {
    const key = (run.name ?? '').trim();
    const existing = groups.get(key);
    if (existing) {
      existing.push(run);
    } else {
      groups.set(key, [run]);
    }
  }

  const current: LatestCheckRun[] = [];
  const superseded: SupersededCheckRun[] = [];

  for (const group of groups.values()) {
    // Fail closed on the legacy stub shape: without a numeric id on every run
    // we cannot order the group, so keep every run and supersede nothing.
    if (!group.every(hasNumericId)) {
      current.push(...group);
      continue;
    }

    const identified = group as IdentifiedCheckRun[];

    let newestCompleted: IdentifiedCheckRun | undefined;
    let newestInflight: IdentifiedCheckRun | undefined;
    for (const run of identified) {
      if (isCompleted(run)) {
        if (newestCompleted === undefined || isNewerCompleted(run, newestCompleted)) {
          newestCompleted = run;
        }
      } else if (newestInflight === undefined || run.id > newestInflight.id) {
        newestInflight = run;
      }
    }

    let winner: IdentifiedCheckRun;
    if (newestCompleted !== undefined && newestInflight !== undefined) {
      // A newer in-flight run (higher id) means the check is running again, so
      // its current state is pending -- never the older completed conclusion.
      winner = newestInflight.id > newestCompleted.id ? newestInflight : newestCompleted;
    } else {
      // The group is non-empty, so exactly one of the two is defined here.
      winner = (newestCompleted ?? newestInflight) as IdentifiedCheckRun;
    }

    current.push(winner);
    for (const run of identified) {
      if (run === winner) continue;
      superseded.push({ ...run, superseded_by: winner.id });
    }
  }

  return { current, superseded };
}
