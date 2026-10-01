/**
 * Reduce a head's raw check-runs to the newest run per check NAME + PRODUCER.
 *
 * GitHub's `checks.listForRef` returns EVERY run at a head, including older
 * runs of a check that has since been re-run. Counting them all lets a stale
 * failure block a PR whose check later passed (or vice versa: a stale success
 * hide a real regression). This module groups the runs by trimmed name and producer
 * (App + workflow run) and, per group, keeps only the current run:
 *
 * - the newest COMPLETED run, ordered by run creation identity (`id`, higher =
 *   newer). Completion time is deliberately NOT used: an older run that
 *   completes after a newer run must not suppress the newer result (#1048);
 * - unless a same-name run that is NOT completed has a higher `id` than that
 *   newest completed run, in which case the check is running again and its
 *   current state is that in-flight (pending) run, never the older completed
 *   conclusion.
 *
 * Within a single Actions workflow run, same-name runs may be independent jobs
 * or re-attempts and cannot be told apart, so none is superseded there (see
 * isSuccessorOf).
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
  /** Producing GitHub App (Actions is one app shared by every workflow). */
  app?: { id?: number | null; slug?: string | null } | null;
  /** For Actions runs the URL embeds the workflow run id (`/actions/runs/<id>`). */
  details_url?: string | null;
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

/**
 * Producer identity of a run: producing App plus, for Actions, the workflow run
 * id. Two same-name runs with different producers are independent checks, not
 * reruns of each other, so they must never supersede one another. Runs with no
 * producer metadata (legacy stub shape) all share the empty producer.
 */
function producerKey(run: LatestCheckRun): string {
  const app = run.app?.id ?? run.app?.slug ?? '';
  const wf = workflowRunId(run);
  return `${app}|${wf}`;
}

type IdentifiedCheckRun = LatestCheckRun & { id: number };

function hasNumericId(run: LatestCheckRun): run is IdentifiedCheckRun {
  return typeof run.id === 'number';
}

/** Actions workflow run id embedded in a run's details URL, or '' if absent. */
function workflowRunId(run: LatestCheckRun): string {
  return /\/actions\/runs\/(\d+)/.exec(run.details_url ?? '')?.[1] ?? '';
}

/**
 * True when `newer` (higher id) provably replaces `older` as the current result.
 *
 * Only runs with no Actions workflow-run identity (non-Actions checks or the
 * legacy stub shape) are ordered by id. Inside an Actions workflow run, the
 * check-run payload cannot distinguish a re-attempt of a job from an
 * independent same-name job (no attempt or job-definition id is exposed), so
 * neither id order nor timestamps are evidence: keep both (fail closed).
 */
function isSuccessorOf(newer: IdentifiedCheckRun, older: IdentifiedCheckRun): boolean {
  return workflowRunId(newer) === '' && workflowRunId(older) === '';
}

/**
 * Group `runs` by trimmed name and return the current run per name plus the
 * older runs it superseded. Distinct names are preserved in first-seen order;
 * single-run names pass through unchanged.
 */
export function reduceToLatestCheckRuns(runs: LatestCheckRun[]): ReducedCheckRuns {
  const groups = new Map<string, LatestCheckRun[]>();
  for (const run of runs) {
    const key = `${(run.name ?? '').trim()}#${producerKey(run)}`;
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

    const identified = group;

    // A run is superseded by a higher-id run only when the pair is provably
    // successive attempts (see isSuccessorOf). Anything ambiguous is kept.
    const supersededBy = new Map<IdentifiedCheckRun, IdentifiedCheckRun>();
    for (const run of identified) {
      for (const other of identified) {
        if (other.id > run.id && isSuccessorOf(other, run)) {
          const prev = supersededBy.get(run);
          if (prev === undefined || other.id > prev.id) supersededBy.set(run, other);
        }
      }
    }

    for (const run of identified) {
      const by = supersededBy.get(run);
      if (by === undefined) {
        current.push(run);
      } else {
        superseded.push({ ...run, superseded_by: by.id });
      }
    }
  }

  return { current, superseded };
}
