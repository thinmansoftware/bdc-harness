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

import {
  appendOperatorCard,
  getOperatorCard,
  type OperatorCardRecord,
} from '@archon/core/db/overseer-briefing';
import { UNOWNED_RESPONSIBLE_ACTOR } from '@archon/core/db/dispatch-routing';
import { createLogger } from '@archon/paths';
import {
  buildOperatorCard,
  OPERATOR_CARD_IDENTITY_VERSION,
  type ActionableEventIdentity,
  type OperatorCardPayload,
} from './operator-card';
import {
  readOwnerRoutingMode,
  resolveWorkOwner,
  type WorkOwnerLookupInput,
  type WorkOwnerResolution,
} from './owner-resolution';
import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

const log = createLogger('overseer/escalate');

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

/** Injected dependencies; tests replace the GitHub-backed owner resolver. */
export interface EscalationDeps {
  resolveOwner?: (input: WorkOwnerLookupInput) => Promise<WorkOwnerResolution>;
}

/**
 * WO-HARNESS-OVERSEER-OWNER-ROUTING-01 (mode on): the card fields an owner
 * resolution implies when the caller did not pass its own. Never an XO
 * principal unless the recorded owner IS xo (M-93 clause 3).
 */
function ownerCardFields(
  assignment: WorkOwnerResolution,
  woId: string
): { responsible_actor: string; next_permitted_action: string } {
  if (assignment.kind === 'owned') {
    return {
      responsible_actor: assignment.owner,
      next_permitted_action: `owner ${assignment.owner} acts on this card`,
    };
  }
  const issueNumber = assignment.source_issue?.split('#')[1];
  return {
    responsible_actor: UNOWNED_RESPONSIBLE_ACTOR,
    next_permitted_action: issueNumber
      ? `John assigns an owner on bdc-xo#${issueNumber}`
      : `John assigns an owner (no WO issue found for ${woId})`,
  };
}

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
  source: EscalationSourceEvent,
  deps: EscalationDeps = {}
): Promise<OperatorCardRecord> {
  if (!context.woId) throw new Error('operator_card_identity_invalid:wo_id');
  // WO-HARNESS-OVERSEER-OWNER-ROUTING-01: off (default) never calls the
  // resolver and leaves the payload byte-identical; shadow records the
  // resolution only; on also derives the actor and next action from it.
  const ownerRoutingMode = readOwnerRoutingMode();
  const ownerAssignment =
    ownerRoutingMode === 'off'
      ? null
      : await (deps.resolveOwner ?? resolveWorkOwner)({
          woId: context.woId,
          repository: textValue(context.repository),
          prNumber: numberValue(context.prNumber),
        });
  const routedFields =
    ownerRoutingMode === 'on' && ownerAssignment
      ? ownerCardFields(ownerAssignment, context.woId)
      : null;
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
    next_permitted_action:
      textValue(context.nextPermittedAction) ??
      routedFields?.next_permitted_action ??
      'await operator ruling',
    responsible_actor:
      textValue(context.responsibleActor) ?? routedFields?.responsible_actor ?? 'acting-xo',
    actionable_event_at: source.eventCreatedAt,
    required_ruling: textValue(context.requiredRuling),
    evidence_links: objectValue(context.evidenceLinks),
    lifecycle_classification: textValue(context.lifecycleClassification) ?? 'recovery',
    governance_classification: textValue(context.governanceClassification) ?? 'information-only',
    ...(ownerAssignment ? { owner_assignment: ownerAssignment } : {}),
  };
  const built = buildOperatorCard(identity, payload);
  try {
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
  } catch (error) {
    // Retry safety with owner routing active: the same source event can
    // resolve a different owner on a retry (a label changed in between).
    // The card id is the event identity, so the first resolution wins and
    // the existing card is returned instead of throwing.
    if (
      ownerRoutingMode === 'off' ||
      (error as Error).message !== 'operator_card_digest_conflict'
    ) {
      throw error;
    }
    const view = await getOperatorCard(built.card_id);
    if (!view) throw new Error('operator_card_not_found_after_conflict');
    log.warn(
      {
        cardId: built.card_id,
        woId: context.woId,
        existingDigest: view.card.payload_digest,
        retryDigest: built.payload_digest,
      },
      'overseer.owner_routing.digest_conflict_first_resolution_kept'
    );
    return view.card;
  }
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

function isOperatorCardRecord(
  value: EscalationContext | OperatorCardRecord
): value is OperatorCardRecord {
  return typeof (value as Partial<OperatorCardRecord>).payload_digest === 'string';
}
