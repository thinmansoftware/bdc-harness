/**
 * Honest run-outcome scorer (WO-HARNESS-RUN-OUTCOME-SCORECARD-01).
 *
 * Turns a run row + its workflow events into a durable, honest score. The
 * governing rule: DO NOT treat remote_agent_workflow_runs.status = 'completed'
 * as success. A run "succeeded" only if a landing node actually completed
 * (landing_ok) or the build was legitimately skipped as already-satisfied
 * (landing_skipped). Everything else -- including status='completed' with no
 * landing and no skip -- is honest_success = 0.
 *
 * Pure and synchronous: no I/O, no DB, no GitHub. The optional gh join result
 * is resolved by the caller (backfill --gh) via an injectable lookup and folded
 * in here; the forward path and default backfill pass no gh result at all
 * (gh_join_complete = 0). A gh miss NEVER flips landing_ok or honest_success.
 *
 * wo_id parsing uses the one canonical parseWoId. It lives in this package so
 * the runtime image does not import scripts/ (that tree is not in the image).
 */
import { parseWoId } from './parse-wo-id';
import type { ModuleAxis, PipelineAxis, RunScorecard } from '@archon/workflows/reliability/types';

/** score_version 1.0 -- the rubric contract. Do not bump without a new rubric. */
export const RUN_SCORECARD_VERSION = '1.0';

/**
 * Landing node ids in the bundled bdc-feature-development lane. A node_completed
 * for either id proves the substantive work landed (branch pushed / PR opened).
 * Verified against .archon/workflows/defaults/bdc-feature-development.yaml.
 */
export const LANDING_NODE_IDS: ReadonlySet<string> = new Set([
  'commit-and-push',
  'open-pr-if-needed',
]);

/** The precheck/gate nodes that can carry an already-satisfied verdict. */
const SKIP_NODE_IDS: ReadonlySet<string> = new Set([
  'check-already-satisfied',
  'gate-already-satisfied',
]);

/**
 * Positive already-satisfied signal. Matches BOTH the token form emitted by
 * check-already-satisfied (ALREADY_SATISFIED=true) and the JSON form emitted by
 * gate-already-satisfied ("ALREADY_SATISFIED":true / PRECHECK_VERDICT:
 * already-satisfied|already-merged-on-base). A needs-build gate emits
 * ALREADY_SATISFIED=false / PRECHECK_VERDICT=needs-build and MUST NOT match --
 * that is why we require the positive value, not merely the presence of a
 * check-already-satisfied node_completed (which fires in both cases).
 */
// The value class allows quotes/backslashes/whitespace so both the token form
// (ALREADY_SATISFIED=true) and the JSON-escaped form ("ALREADY_SATISFIED":true,
// which becomes \"ALREADY_SATISFIED\":true after JSON.stringify) match.
const SKIP_SIGNAL_RE =
  /already_satisfied["'\\\s]*[:=]["'\\\s]*true|precheck_verdict["'\\\s]*[:=]["'\\\s]*(?:already-satisfied|already-merged-on-base)/i;

/**
 * pipeline_axis seed map (score_version 1.0). Keys are step_name (node id) of the
 * latest failure; if there is no failed step the terminal_event is used, and
 * terminal_event values fall through to 'unknown' by design. Extend ONLY with
 * node ids that appear in the workflow YAML / events.
 */
export const PIPELINE_AXIS_MAP: Readonly<Record<string, PipelineAxis>> = {
  plan: 'spec',
  'plan-review': 'spec',
  'read-spec': 'spec',
  'spec-repair': 'spec',
  implement: 'build',
  'implement-loop': 'build',
  loop: 'build',
  'commit-and-push': 'landing',
  'open-pr-if-needed': 'landing',
  'patch-pr-body': 'landing',
  review: 'review',
  overseer: 'review',
  'plan-review-repair': 'review',
  deploy: 'deploy',
  promote: 'deploy',
};

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'workflow_completed',
  'workflow_failed',
  'workflow_cancelled',
]);

export interface ScorecardEventInput {
  readonly event_type: string;
  readonly step_name: string | null;
  readonly data?: Record<string, unknown> | null;
  readonly created_at: string;
}

/** Resolved GitHub join result. joinComplete=true means the lookup ran (or was N/A). */
export interface GhLookupResult {
  readonly prUrl: string | null;
  readonly joinComplete: boolean;
}

export interface ScoreRunInput {
  /** runs.status at score time -- stored as status_column for contrast only. */
  readonly status: string;
  readonly userMessage: string | null;
  readonly workflowName: string;
  readonly events: readonly ScorecardEventInput[];
  /** Optional resolved gh join (backfill --gh only). Omitted => gh_join_complete = 0. */
  readonly gh?: GhLookupResult;
}

/**
 * Feature-dev family lanes. Non-family lanes force score_partial = 1 because the
 * landing/skip contract is defined against the feature-dev DAG. Prefixes grepped
 * from .archon/workflows/defaults (bdc-feature-development*, archon-feature-development).
 */
export function isFeatureDevFamily(workflowName: string): boolean {
  return (
    workflowName.startsWith('bdc-feature-development') ||
    workflowName === 'archon-feature-development'
  );
}

/** Parse a created_at value (ISO or 'YYYY-MM-DD HH:MM:SS') to epoch ms; null if unparseable. */
function createdAtMs(value: string): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function serializeEvent(event: ScorecardEventInput): string {
  const parts: string[] = [];
  if (event.step_name) parts.push(event.step_name);
  if (event.data != null) {
    try {
      parts.push(JSON.stringify(event.data));
    } catch {
      // Non-serializable data (cycles) -- skip; step_name still contributes.
    }
  }
  return parts.join(' ');
}

function hasSkipSignal(events: readonly ScorecardEventInput[]): boolean {
  return events.some(event => {
    // Only completed nodes carry a decided verdict; a started/failed gate event
    // does not prove the already-satisfied outcome.
    if (event.event_type !== 'node_completed') return false;
    if (event.step_name != null && !SKIP_NODE_IDS.has(event.step_name)) {
      // Still allow a matching token elsewhere, but the common path is the gate node.
      return SKIP_SIGNAL_RE.test(serializeEvent(event));
    }
    return SKIP_SIGNAL_RE.test(serializeEvent(event));
  });
}

interface LastFailure {
  readonly stepName: string | null;
  readonly tie: boolean;
}

function computeLastFailedStep(events: readonly ScorecardEventInput[]): LastFailure {
  const failures = events.filter(event => event.event_type === 'node_failed');
  if (failures.length === 0) return { stepName: null, tie: false };

  let maxMs = Number.NEGATIVE_INFINITY;
  for (const event of failures) {
    const ms = createdAtMs(event.created_at);
    if (ms !== null && ms > maxMs) maxMs = ms;
  }
  // If none of the timestamps parsed, treat all as tied at the same (unknown) time.
  const atMax =
    maxMs === Number.NEGATIVE_INFINITY
      ? failures
      : failures.filter(event => createdAtMs(event.created_at) === maxMs);

  const names = atMax
    .map(event => event.step_name)
    .filter((name): name is string => name != null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    stepName: names.length > 0 ? names[0] : null,
    tie: atMax.length > 1,
  };
}

function computeTerminalEvent(events: readonly ScorecardEventInput[]): string {
  let latestType = 'none';
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (!TERMINAL_EVENT_TYPES.has(event.event_type)) continue;
    const ms = createdAtMs(event.created_at);
    const rank = ms === null ? Number.NEGATIVE_INFINITY : ms;
    if (latestType === 'none' || rank >= latestMs) {
      latestMs = rank;
      latestType = event.event_type;
    }
  }
  return latestType;
}

/**
 * Score a single run from its row status + events. Always returns a full
 * scorecard; missing/partial events simply yield score_partial = 1.
 */
export function scoreRunFromEvents(input: ScoreRunInput): RunScorecard {
  const { events, workflowName, status } = input;

  const landingOk: 0 | 1 = events.some(
    event =>
      event.event_type === 'node_completed' &&
      event.step_name != null &&
      LANDING_NODE_IDS.has(event.step_name)
  )
    ? 1
    : 0;

  const landingSkipped: 0 | 1 = landingOk === 0 && hasSkipSignal(events) ? 1 : 0;

  const { stepName: lastFailedStep, tie: lastFailedTie } = computeLastFailedStep(events);
  const terminalEvent = computeTerminalEvent(events);

  let pipelineAxis: PipelineAxis;
  if (landingOk === 1) {
    pipelineAxis = 'success';
  } else if (landingSkipped === 1) {
    pipelineAxis = 'skip';
  } else {
    const key = lastFailedStep ?? terminalEvent;
    pipelineAxis = PIPELINE_AXIS_MAP[key] ?? 'unknown';
  }

  let moduleAxis: ModuleAxis;
  if (events.some(event => event.event_type === 'loop_iteration_failed')) {
    moduleAxis = 'loop';
  } else if (events.some(event => event.event_type === 'node_failover')) {
    moduleAxis = 'tools';
  } else if (landingOk === 1 || landingSkipped === 1) {
    moduleAxis = 'none';
  } else {
    moduleAxis = 'unknown';
  }

  const honestSuccess: 0 | 1 = landingOk === 1 || landingSkipped === 1 ? 1 : 0;

  const ghJoinComplete: 0 | 1 = input.gh ? (input.gh.joinComplete ? 1 : 0) : 0;
  const ghPrUrl = input.gh ? input.gh.prUrl : null;

  const scorePartial: 0 | 1 =
    terminalEvent === 'none' ||
    lastFailedTie ||
    ghJoinComplete === 0 ||
    !isFeatureDevFamily(workflowName)
      ? 1
      : 0;

  return {
    scoreVersion: RUN_SCORECARD_VERSION,
    statusColumn: status,
    terminalEvent,
    landingOk,
    landingSkipped,
    lastFailedStep,
    pipelineAxis,
    moduleAxis,
    honestSuccess,
    scorePartial,
    ghPrUrl,
    ghJoinComplete,
    woId: parseWoId(input.userMessage),
  };
}
