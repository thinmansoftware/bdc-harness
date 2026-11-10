/**
 * Trace a pull request back to the Cauldron run that opened it (bdc-harness 5308).
 *
 * Why: the merge hold of WO-HARNESS-MERGE-HOLD-FAILED-EVIDENCE-01 keys on the
 * originating run. A PR discovered by the PR-first sweep carries a synthetic
 * `pr-discovery:` run id, so without this lookup a PR the run itself opened
 * (the agent pushing the run's worktree branch mid-run) or whose head was later
 * hand-fixed merges on the run-less path with no hold. Two independent traces:
 *   1. the PR head branch equals the tail of a run's own worktree path
 *      (`.../worktrees/archon/task-web-worker-<id>`), and
 *   2. the PR URL appears in the run's open-pr-if-needed / patch-pr-body output.
 * The branch name carries a thread suffix that is NOT the run id, so it is never
 * parsed for an id.
 *
 * A pull request no run opened (a human PR) yields null and keeps the 2026-09-07
 * "proceed on green" rule. The most recent matching run governs.
 */

export interface OriginatingRunCandidate {
  readonly id: string;
  readonly status: string;
  /** SQLite yields a string; PostgreSQL yields a Date (TIMESTAMPTZ) through the pg adapter. */
  readonly started_at: string | Date | null;
  readonly working_path: string | null;
  /** Engine-written codebase name (owner/repo) from the run's codebase FK; null when unlinked. */
  readonly codebase_name?: string | null;
  /** Codebase repository_url (for example https://github.com/owner/repo.git); null when unset. */
  readonly codebase_url?: string | null;
  readonly event_data: string | null;
}

export interface OriginatingRun {
  readonly runId: string;
  readonly status: string;
}

export interface OriginatingRunLookupInput {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headRef?: string;
}

export type ListOriginatingRunCandidates = (
  input: OriginatingRunLookupInput
) => Promise<readonly OriginatingRunCandidate[]>;

/** Statuses after which a run's evidence gate has had its chance to run. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'escalated']);

export function isRunTerminal(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status.trim().toLowerCase());
}

/**
 * Epoch milliseconds for a run start. A SQLite `YYYY-MM-DD HH:MM:SS` string carries no zone
 * and is UTC; a Date is used as is; anything unparseable sorts oldest.
 */
export function startedAtEpoch(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  const text = value.trim();
  if (text === '') return 0;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const iso = text.includes('T') ? text : text.replace(' ', 'T');
  const ms = Date.parse(hasZone ? iso : iso + 'Z');
  return Number.isNaN(ms) ? 0 : ms;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIALS, '\\$&');
}

function mentionsPullRequest(eventData: string, input: OriginatingRunLookupInput): boolean {
  const owner = escapeRegExp(input.owner);
  const repo = escapeRegExp(input.repo);
  const pattern = new RegExp(
    'github\\.com/' + owner + '/' + repo + '/pull/' + String(input.number) + '(?!\\d)',
    'i'
  );
  return pattern.test(eventData);
}

/**
 * A worktree branch is only unique within one repository: two repos can use the same
 * `archon/task-web-worker-<id>` shape. Bind the candidate to the target repo through the
 * engine-written codebase link, strongest source first:
 *   1. the codebase `repository_url` (an authoritative owner/repo when it parses),
 *   2. the codebase name: `owner/repo`, or a BARE repo name (existing registrations use both),
 *   3. the `/<owner>/<repo>/` segment of the engine-written worktree path.
 * The first source that yields an identity decides; a bare name matches on the repo part only.
 */
function belongsToRepo(
  candidate: OriginatingRunCandidate,
  input: OriginatingRunLookupInput
): boolean {
  const owner = input.owner.toLowerCase();
  const repo = input.repo.toLowerCase();
  const want = owner + '/' + repo;

  const url = (candidate.codebase_url ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '');
  const urlMatch = /[:/]([^/:]+)\/([^/]+)$/.exec(url);
  if (urlMatch) return urlMatch[1] === owner && urlMatch[2] === repo;

  const name = (candidate.codebase_name ?? '').trim().toLowerCase();
  if (name !== '') {
    if (name.includes('/')) return name === want || name.endsWith('/' + want);
    return name === repo;
  }

  const path = (candidate.working_path ?? '')
    .split(String.fromCharCode(92))
    .join('/')
    .toLowerCase();
  return path.includes('/' + want + '/');
}

function worktreeEndsWithBranch(workingPath: string, headRef: string): boolean {
  const normalized = workingPath.split('\\').join('/').replace(/\/+$/, '');
  return normalized === headRef || normalized.endsWith('/' + headRef);
}

/**
 * Return the most recent run that opened the pull request, or null when none
 * did. A rejection from `list` propagates: the caller must fail closed.
 */
export async function findOriginatingRunForPullRequest(
  input: OriginatingRunLookupInput,
  list: ListOriginatingRunCandidates
): Promise<OriginatingRun | null> {
  const candidates = await list(input);
  const headRef = (input.headRef ?? '').trim();
  const matches = new Map<string, OriginatingRunCandidate>();
  for (const candidate of candidates) {
    const byBranch =
      headRef !== '' &&
      typeof candidate.working_path === 'string' &&
      worktreeEndsWithBranch(candidate.working_path, headRef) &&
      belongsToRepo(candidate, input);
    const byUrl =
      typeof candidate.event_data === 'string' && mentionsPullRequest(candidate.event_data, input);
    if (!byBranch && !byUrl) continue;
    if (!matches.has(candidate.id)) matches.set(candidate.id, candidate);
  }
  const ordered = [...matches.values()].sort(
    (a, b) => startedAtEpoch(b.started_at) - startedAtEpoch(a.started_at)
  );
  const latest = ordered[0];
  return latest ? { runId: latest.id, status: latest.status } : null;
}
