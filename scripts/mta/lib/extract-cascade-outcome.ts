'use strict';
/**
 * Pure extractor: one remote_agent_workflow_runs row -> cascade outcome record.
 * Read-only. No I/O. Frozen format_version 1.0.
 *
 * Parse tokens (frozen in docs/mta/cascade-outcome-export.md):
 *   WO_ID=<id> or a WO-[A-Z0-9-]+ token
 *   --project <name>
 *   prior_tier=<value> or prior-tier <value>
 *
 * No in-repo prior-tier narrative preamble exists; do not invent one.
 */

export const CASCADE_OUTCOME_FORMAT_VERSION = '1.0';

export interface WorkflowRunExportRow {
  id: string;
  workflow_name: string;
  user_message: string | null;
  status: string;
  metadata: unknown;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  // Honest run-outcome scorecard columns (WO-HARNESS-RUN-OUTCOME-SCORECARD-01),
  // LEFT JOINed from remote_agent_run_outcomes. All optional/nullable because
  // not every run has a scored outcome row (unscored -> honest status 'failed').
  landing_ok?: number | string | null;
  landing_skipped?: number | string | null;
  terminal_event?: string | null;
  pipeline_axis?: string | null;
  module_axis?: string | null;
  last_failed_step?: string | null;
  honest_success?: number | string | null;
  score_partial?: number | string | null;
  score_version?: string | null;
  gh_pr_url?: string | null;
  gh_join_complete?: number | string | null;
  status_column?: string | null;
}

export interface NodeCounts {
  completed?: number;
  failed?: number;
  skipped?: number;
  total?: number;
}

export interface NodeModelSummaryEntry {
  node_id?: string;
  declared_model_id?: string;
  requested_model_id?: string;
  served_model_id?: string;
  servedModelId?: string;
  mismatch?: boolean;
  served_model_mismatch?: boolean;
  servedModelMismatch?: boolean;
}

export interface WorkflowRunMetadata {
  node_counts?: unknown;
  node_model_summary?: unknown;
  total_cost_usd?: unknown;
  total_tokens?: unknown;
  prior_tier?: unknown;
  priorTier?: unknown;
}

export interface CascadeOutcomeRecord {
  format_version: string;
  run_id: string;
  wo_id: string | null;
  project: string | null;
  workflow_name: string;
  prior_tier: string | null;
  status: string;
  node_counts: NodeCounts | null;
  models_served: string[];
  model_mismatches: number;
  cost_usd: number | null;
  tokens: number | null;
  started_at: string | null;
  completed_at: string | null;
  duration_s: number | null;
  attribution_complete: boolean;
  // Optional honest-scorecard extras (WO-HARNESS-RUN-OUTCOME-SCORECARD-01).
  // MTA cascade_reader ignores unknown keys; format_version stays 1.0. The
  // `status` field above is now DERIVED from landing_ok/landing_skipped/
  // terminal_event -- never a copy of runs.status (that copy is `status_column`).
  landing_ok: number | null;
  landing_skipped: number | null;
  pipeline_axis: string | null;
  module_axis: string | null;
  last_failed_step: string | null;
  honest_success: number | null;
  score_partial: number | null;
  score_version: string | null;
  gh_pr_url: string | null;
  gh_join_complete: number | null;
  status_column: string | null;
}

const WO_ID_ASSIGN_RE = /(?:^|\n)\s*WO_ID\s*=\s*(WO-[A-Z0-9-]+)/m;
const WO_ID_TOKEN_RE = /\bWO-[A-Z0-9-]+\b/;
const PROJECT_RE = /--project(?:\s+|=)([A-Za-z0-9._/-]+)/;
const PRIOR_TIER_TOKEN_RE =
  /(?:^|[\s,;|])(?:--)?prior[_-]?tier(?:\s*[:=]\s*|\s+)["']?([A-Za-z0-9._-]+)["']?/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseWoId(userMessage: string | null | undefined): string | null {
  if (userMessage == null || userMessage === '') return null;
  const assigned = WO_ID_ASSIGN_RE.exec(userMessage);
  if (assigned?.[1]) return assigned[1];
  const bare = WO_ID_TOKEN_RE.exec(userMessage);
  return bare ? bare[0] : null;
}

export function parseProject(userMessage: string | null | undefined): string | null {
  if (userMessage == null || userMessage === '') return null;
  const match = PROJECT_RE.exec(userMessage);
  return match?.[1] ?? null;
}

export function parsePriorTier(
  userMessage: string | null | undefined,
  metadata?: WorkflowRunMetadata | null
): string | null {
  const fromMetadata =
    asNonEmptyString(metadata?.prior_tier) ?? asNonEmptyString(metadata?.priorTier);
  if (fromMetadata) return fromMetadata;
  if (userMessage == null || userMessage === '') return null;
  const match = PRIOR_TIER_TOKEN_RE.exec(userMessage);
  return match?.[1] ?? null;
}

export function parseMetadata(raw: unknown): WorkflowRunMetadata {
  if (raw == null) return {};
  if (isRecord(raw)) {
    return {
      node_counts: raw.node_counts,
      node_model_summary: raw.node_model_summary,
      total_cost_usd: raw.total_cost_usd,
      total_tokens: raw.total_tokens,
      prior_tier: raw.prior_tier,
      priorTier: raw.priorTier,
    };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        return {
          node_counts: parsed.node_counts,
          node_model_summary: parsed.node_model_summary,
          total_cost_usd: parsed.total_cost_usd,
          total_tokens: parsed.total_tokens,
          prior_tier: parsed.prior_tier,
          priorTier: parsed.priorTier,
        };
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function timestampMs(value: string | Date | null | undefined): number | null {
  const iso = normalizeTimestamp(value);
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseNodeCounts(value: unknown): NodeCounts | null {
  if (value == null || !isRecord(value)) return null;
  const counts: NodeCounts = {};
  let anyCount = false;
  for (const key of ['completed', 'failed', 'skipped', 'total'] as const) {
    const n = asFiniteNumber(value[key]);
    if (n !== null) {
      counts[key] = n;
      anyCount = true;
    }
  }
  return anyCount ? counts : null;
}

function parseSummaryEntry(entry: unknown): NodeModelSummaryEntry | null {
  if (!isRecord(entry)) return null;
  const parsed: NodeModelSummaryEntry = {};
  const served = asNonEmptyString(entry.served_model_id) ?? asNonEmptyString(entry.servedModelId);
  if (served) {
    parsed.served_model_id = served;
    parsed.servedModelId = served;
  }
  if (
    entry.mismatch === true ||
    entry.served_model_mismatch === true ||
    entry.servedModelMismatch === true
  ) {
    parsed.mismatch = true;
  }
  const nodeId = asNonEmptyString(entry.node_id);
  if (nodeId) parsed.node_id = nodeId;
  return parsed;
}

function extractServedModels(summary: unknown): {
  models: string[];
  mismatches: number;
  hasSummary: boolean;
  allEntriesAttributed: boolean;
} {
  if (!Array.isArray(summary) || summary.length === 0) {
    return { models: [], mismatches: 0, hasSummary: false, allEntriesAttributed: false };
  }

  const models: string[] = [];
  let mismatches = 0;
  let attributed = 0;

  for (const entry of summary) {
    const parsed = parseSummaryEntry(entry);
    if (!parsed) continue;
    if (parsed.served_model_id) {
      models.push(parsed.served_model_id);
      attributed += 1;
    }
    if (parsed.mismatch === true) mismatches += 1;
  }

  return {
    models,
    mismatches,
    hasSummary: true,
    allEntriesAttributed: attributed === summary.length,
  };
}

/**
 * Known gap: model attribution exists on node_completed and is missing on
 * node_failed. A row is attribution_complete only when a node_model_summary
 * is present, every summary entry has a served model, and there are no
 * failed nodes that would lack attribution.
 */
export function computeAttributionComplete(
  metadata: WorkflowRunMetadata,
  served: { hasSummary: boolean; allEntriesAttributed: boolean }
): boolean {
  if (!served.hasSummary || !served.allEntriesAttributed) return false;
  const counts = parseNodeCounts(metadata.node_counts);
  if (counts?.failed !== undefined && counts.failed > 0) return false;
  return true;
}

/** Coerce a nullable INTEGER column (number or string across engines) to number | null. */
export function nullableInt(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableString(value: string | null | undefined): string | null {
  return value == null ? null : value;
}

/**
 * Honest cascade `status` (WO-HARNESS-RUN-OUTCOME-SCORECARD-01). NEVER copies
 * runs.status. Derived ONLY from the scored columns:
 *   completed  iff landing_ok = 1
 *   skipped    iff landing_skipped = 1 and landing_ok != 1
 *   cancelled  iff terminal_event = workflow_cancelled (and not completed/skipped)
 *   failed     otherwise (includes unscored rows and completed-without-landing)
 * MTA cascade_reader counts only {completed, success, succeeded} as success, so a
 * skip is correctly NOT counted as a build success.
 */
export function deriveHonestStatus(row: WorkflowRunExportRow): string {
  const landingOk = nullableInt(row.landing_ok);
  const landingSkipped = nullableInt(row.landing_skipped);
  if (landingOk === 1) return 'completed';
  if (landingSkipped === 1) return 'skipped';
  if (row.terminal_event === 'workflow_cancelled') return 'cancelled';
  return 'failed';
}

export function runRowToOutcomeRecord(row: WorkflowRunExportRow): CascadeOutcomeRecord {
  const metadata = parseMetadata(row.metadata);
  const userMessage = row.user_message ?? '';
  const served = extractServedModels(metadata.node_model_summary);
  const startedAt = normalizeTimestamp(row.started_at);
  const completedAt = normalizeTimestamp(row.completed_at);
  const startMs = timestampMs(row.started_at);
  const endMs = timestampMs(row.completed_at);
  const durationS =
    startMs !== null && endMs !== null ? Math.round((endMs - startMs) / 1000) : null;

  const nodeCounts = parseNodeCounts(metadata.node_counts);

  return {
    format_version: CASCADE_OUTCOME_FORMAT_VERSION,
    run_id: row.id,
    wo_id: parseWoId(userMessage),
    project: parseProject(userMessage),
    workflow_name: row.workflow_name,
    prior_tier: parsePriorTier(userMessage, metadata),
    // Honest status derived from the scorecard -- NEVER a copy of runs.status.
    status: deriveHonestStatus(row),
    node_counts: nodeCounts,
    models_served: served.models,
    model_mismatches: served.mismatches,
    cost_usd: asFiniteNumber(metadata.total_cost_usd),
    tokens: asFiniteNumber(metadata.total_tokens),
    started_at: startedAt,
    completed_at: completedAt,
    duration_s: durationS,
    attribution_complete: computeAttributionComplete(metadata, served),
    // Optional scorecard extras (ignored by MTA cascade_reader).
    landing_ok: nullableInt(row.landing_ok),
    landing_skipped: nullableInt(row.landing_skipped),
    pipeline_axis: nullableString(row.pipeline_axis),
    module_axis: nullableString(row.module_axis),
    last_failed_step: nullableString(row.last_failed_step),
    honest_success: nullableInt(row.honest_success),
    score_partial: nullableInt(row.score_partial),
    score_version: nullableString(row.score_version),
    gh_pr_url: nullableString(row.gh_pr_url),
    gh_join_complete: nullableInt(row.gh_join_complete),
    // status_column preserves runs.status for contrast only.
    status_column: nullableString(row.status_column) ?? row.status,
  };
}
