/**
 * Escalation side-effect handler for silent-dead-end failures.
 *
 * Fires when @archon/overseer's decide() returns decision='escalate' WITH a populated
 * escalationContext. The executor (overseer-bridge) routes the call here. Three
 * operator-visible signals are produced for every escalation:
 *
 *   1. JSON file at <archonHome>/runs/<runId>/escalation.json containing the full
 *      structured context (errorClass, nodeId, validatorOutput, remediation, timestamp).
 *   2. Notion comment on the WO page (best-effort; needs NOTION_API_KEY + the WO ID).
 *   3. POST to BUILDER_MONITOR_WEBHOOK_URL with action='needs_human' so the n8n
 *      monitor dashboard surfaces the failure to John.
 *
 * Design notes:
 *   - Fail-soft on individual side effects: if Notion is misconfigured, escalation.json
 *     and the webhook STILL fire. The contract is "operator gets at least one signal".
 *   - Idempotent for escalation.json (overwrites cleanly) and webhook (downstream
 *     n8n flow keys on wo_id). Notion comment posts once per (runId, errorClass) by
 *     embedding the runId in the comment body -- operators can re-trigger if they
 *     intentionally retry the same run.
 *   - Notion API access uses the REST API directly (not MCP) so it works inside the
 *     bun-only container at workflow runtime.
 *
 * Anchor: 2026-05-18 Wave A -- silent exit-1 on commit-and-push lost work on
 * WO-AUTH-RETIRE-GAS-PATH-02 and WO-AUTH-SINGLE-PATH-E2E-04. This module is the
 * mechanism that ensures no Cauldron failure ever exits silently again.
 */

import { createLogger, type Logger } from '@archon/paths';
import { appendOperatorCard, type OperatorCardRecord } from '@archon/core/db/overseer-briefing';
import {
  buildOperatorCard,
  OPERATOR_CARD_IDENTITY_VERSION,
  type ActionableEventIdentity,
  type OperatorCardPayload,
} from './operator-card';
import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

// Exported so tests can spyOn the debug/info methods and pin the log-downgrade
// contract (no-match logs debug 'notion_lookup_no_match' and does NOT emit the
// info 'notion_lookup_exhausted' event).
export const log: Logger = createLogger('overseer/escalate');

/**
 * Structured payload accepted by runEscalation. Mirrors the loose shape of
 * DecisionResult.escalationContext but adds runtime-only fields (runId, timestamp,
 * notionPageId) populated by this module rather than the decision layer.
 */
export interface EscalationContext {
  errorClass: ErrorClass;
  nodeId?: string;
  woId?: string;
  validatorOutput?: string;
  remediation?: string[];
  /** Additional ad-hoc diagnostic fields */
  [key: string]: unknown;
}

export interface EscalationSourceEvent {
  sourceEventId: string;
  eventType: string;
  stepName: string;
  eventCreatedAt: string;
}

/**
 * Default Notion database ID for BDC's main Cauldron / WO board.
 * Used as fallback when NOTION_DB_ID env var is not set. Hardcoding this single
 * BDC-specific identifier is acceptable: it is a public discovery ID (not a secret)
 * and the alternative is failing the escalation silently when the env var drifts.
 * Override via NOTION_DB_ID for non-prod environments.
 */
const NOTION_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';

/**
 * Run an escalation for a non-recoverable workflow failure.
 *
 * Side effects are best-effort and isolated: if any one of (escalation.json /
 * Notion comment / webhook) fails, the others are still attempted. Errors are
 * captured and surfaced via the return value rather than thrown -- the caller
 * (overseer-bridge) is in a node-failure code path and should not amplify the
 * failure with an escalation-side error.
 */
export async function runEscalation(
  runId: string,
  decision: DecisionResult,
  context: EscalationContext,
  source: EscalationSourceEvent
): Promise<OperatorCardRecord> {
  if (!context.woId) throw new Error('operator_card_identity_invalid:wo_id');
  const identity: ActionableEventIdentity = {
    identity_version: OPERATOR_CARD_IDENTITY_VERSION,
    source_event_id: source.sourceEventId,
    run_id: runId,
    wo_id: context.woId,
    event_type: source.eventType,
    step_name: source.stepName,
    event_created_at: source.eventCreatedAt,
    error_class: context.errorClass,
  };
  const payload: OperatorCardPayload = {
    repository: textValue(context.repository) ?? 'thinmansoftware/bdc-harness',
    branch: textValue(context.branch),
    pr_url: textValue(context.prUrl),
    pr_number: numberValue(context.prNumber),
    head_sha: textValue(context.headSha),
    base_branch: textValue(context.baseBranch),
    base_sha: textValue(context.baseSha),
    checks: objectValue(context.checks),
    mergeability: textValue(context.mergeability) ?? 'unknown',
    blocker: decision.reason,
    mechanical_evidence: {
      node_id: context.nodeId ?? null,
      validator_output: context.validatorOutput ?? null,
    },
    recovery_attempted: objectValue(context.recoveryAttempted),
    proposed_remediation: { steps: context.remediation ?? [] },
    next_permitted_action: textValue(context.nextPermittedAction) ?? 'await operator ruling',
    responsible_actor: textValue(context.responsibleActor) ?? 'acting-xo',
    actionable_event_at: source.eventCreatedAt,
    required_ruling: textValue(context.requiredRuling),
    evidence_links: objectValue(context.evidenceLinks),
    lifecycle_classification: textValue(context.lifecycleClassification) ?? 'recovery',
    governance_classification: textValue(context.governanceClassification) ?? 'information-only',
  };
  const built = buildOperatorCard(identity, payload);
  const persisted = await appendOperatorCard({
    card_id: built.card_id,
    identity_version: built.identity_version,
    canonical_event_identity: { ...built.canonical_event_identity },
    payload_digest: built.payload_digest,
    payload: { ...built.payload },
    ...built.payload,
    run_id: runId,
    wo_id: context.woId,
  });
  return persisted.card;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildDispatchRunReportBody(
  context: EscalationContext | OperatorCardRecord,
  decision?: DecisionResult,
  runId?: string,
  timestamp = new Date().toISOString()
): string {
  if (isOperatorCardRecord(context)) {
    return JSON.stringify({
      kind: 'overseer_run_report',
      card_id: context.card_id,
      payload_digest: context.payload_digest,
      ...context.payload,
      delivery_summary: null,
    });
  }
  return JSON.stringify({
    kind: 'overseer_run_report',
    runId: runId ?? 'unknown',
    woId: context.woId ?? 'unknown',
    class: context.errorClass,
    nodeId: context.nodeId ?? null,
    decision: decision?.decision ?? 'escalate',
    reason: decision?.reason ?? context.blocker ?? 'operator card',
    remediation: context.remediation ?? [],
    timestamp,
  });
}

/**
 * Find a Notion page UUID by querying the database with a filter on the WO ID
 * column. Returns null if no match or if Notion returns an error.
 *
 * BDC's WO database surfaces the WO ID under different property names depending
 * on the row -- we try the common ones in order. This is intentionally tolerant:
 * the goal is best-effort discovery, not exact-schema enforcement.
 */
export interface NotionPageLookupResult {
  page_id: string | null;
  failure_outcome: 'transient_failure' | 'permanent_failure' | null;
}

function isRetrySafeHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export async function lookupNotionPage(
  apiKey: string,
  databaseId: string,
  woId: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<NotionPageLookupResult> {
  const url = `${NOTION_API_BASE}/databases/${databaseId}/query`;
  const candidateProps = ['Task', 'WO ID', 'Name', 'Title', 'WO_ID'];
  let sawSuccessfulQuery = false;
  let sawRetrySafeFailure = false;
  for (const property of candidateProps) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_VERSION,
        },
        body: JSON.stringify({
          filter: { property, title: { equals: woId } },
          page_size: 1,
        }),
      });
      if (!res.ok) {
        if (isRetrySafeHttpStatus(res.status)) sawRetrySafeFailure = true;
        continue;
      }
      sawSuccessfulQuery = true;
      const data = (await res.json()) as { results?: { id?: string }[] };
      const first = data.results?.[0];
      if (first?.id) {
        log.info({ property, databaseId, woId }, 'overseer.notion_lookup_matched');
        return { page_id: first.id, failure_outcome: null };
      }
    } catch {
      sawRetrySafeFailure = true;
    }
  }
  // A query that Notion answered successfully but that matched no page is a
  // permanent no-match: an authoritative empty result will not turn into a row
  // on retry. This branch is deliberately generic -- it fires for ANY successful
  // query that matches no page, whether that is a GitHub-only WO with no Notion
  // row, a mistyped woId, or a legitimately deleted page. There is no date or
  // cutover check here by design. Classify it as permanent so escalation-delivery
  // does not retry it, and log at debug WITHOUT the "exhausted" failure event --
  // for the common GitHub-only case this is not a failure at all.
  if (sawSuccessfulQuery && !sawRetrySafeFailure) {
    log.debug({ candidateProps, databaseId, woId }, 'overseer.notion_lookup_no_match');
    return {
      page_id: null,
      failure_outcome: 'permanent_failure',
    };
  }
  // Genuine failure path: either no candidate query ever succeeded, or a
  // retry-safe transport/rate-limit error (429/5xx/network) was seen. Keep the
  // existing classification and the informational "exhausted" log for this case.
  const failureOutcome = sawRetrySafeFailure ? 'transient_failure' : 'permanent_failure';
  log.info(
    { candidateProps, databaseId, woId, failureOutcome },
    'overseer.notion_lookup_exhausted'
  );
  return {
    page_id: null,
    failure_outcome: failureOutcome,
  };
}

export async function lookupNotionPageId(
  apiKey: string,
  databaseId: string,
  woId: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string | null> {
  return (await lookupNotionPage(apiKey, databaseId, woId, fetchImpl)).page_id;
}

function isOperatorCardRecord(
  value: EscalationContext | OperatorCardRecord
): value is OperatorCardRecord {
  return typeof (value as Partial<OperatorCardRecord>).payload_digest === 'string';
}
