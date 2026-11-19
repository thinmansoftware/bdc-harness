import {
  ACTIVE_OPERATOR_CARD_CHANNELS,
  appendDeliveryReceipt,
  claimDueDeliveryJob,
  completeDeliveryJob,
  getOperatorCard,
  type DeliveryJobRecord,
  type DeliveryOutcome,
  type OperatorCardChannelName,
  type OperatorCardView,
} from '@archon/core/db/overseer-briefing';
import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import {
  isXoResponsibleActor,
  OPERATOR_RECIPIENT,
  T3_DESKTOP_RECIPIENT,
  UNOWNED_RESPONSIBLE_ACTOR,
} from '@archon/core/db/dispatch-routing';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { createLogger } from '@archon/paths';
import { buildDispatchRunReportBody } from './escalate';
import {
  readOwnerRoutingMode,
  resolveWoBoardSeatOwner,
  type OwnerRoutingMode,
} from './owner-resolution';

const log = createLogger('overseer/escalation-delivery');

export interface ChannelDeliveryResult {
  outcome: DeliveryOutcome;
  sanitized_status: string;
  error_class?: string | null;
  provider_receipt_id?: string | null;
}

export interface OperatorCardChannel {
  channel: OperatorCardChannelName;
  deliver(card: OperatorCardView, idempotencyKey: string): Promise<ChannelDeliveryResult>;
  reconcile(card: OperatorCardView, attempt: number): Promise<ChannelDeliveryResult>;
}

export interface DeliveryStore {
  claimDueDeliveryJob: typeof claimDueDeliveryJob;
  getOperatorCard: typeof getOperatorCard;
  appendDeliveryReceipt: typeof appendDeliveryReceipt;
  completeDeliveryJob: typeof completeDeliveryJob;
}

export interface OperatorCardChannelDeps {
  fetch: typeof fetch;
  notion_api_key?: string;
  notion_database_id: string;
  builder_monitor_url: string;
  resolve_owner: (woId: string) => Promise<string | null>;
  /** Defaults to OVERSEER_OWNER_ROUTING (exactly 'shadow' or 'on', else off). */
  owner_routing_mode: OwnerRoutingMode;
  /** Defaults to OVERSEER_OWNER_ROUTES_JSON. */
  owner_routes_json: string | undefined;
  /** Receives overseer.owner_routing.routes_invalid; defaults to the module logger. */
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

// ---------------------------------------------------------------------------
// WO-HARNESS-OVERSEER-OWNER-ROUTING-01: owner routing (mode on only).
// Contract: docs/operations/overseer-owner-routing.md.
// ---------------------------------------------------------------------------

/** The only recipient an owner row may target: the T3 desktop relay queue. */
export const OWNER_ROUTE_RECIPIENT = 't3-desk-local';

export interface OwnerRoute {
  recipient: typeof OWNER_ROUTE_RECIPIENT;
  thread_id: string;
}

export interface OwnerRouteTable {
  /** Keyed by lower-cased owner handle. */
  routes: ReadonlyMap<string, OwnerRoute>;
  /** Why the table was rejected; null for a valid (possibly empty) table. */
  invalid_reason: string | null;
}

const EMPTY_ROUTES: ReadonlyMap<string, OwnerRoute> = new Map();

/**
 * Parse OVERSEER_OWNER_ROUTES_JSON:
 *   { "<handle>": { "recipient": "t3-desk-local", "thread_id": "<T3 thread id>" } }
 * Unset or blank is a valid empty table. Fail closed: invalid JSON, a
 * non-object, an entry whose recipient is not exactly t3-desk-local, or a
 * missing/blank thread_id rejects the WHOLE table, which then behaves as
 * empty (no owner rows are written). Worker or model recipients are never
 * accepted.
 */
export function parseOwnerRouteTable(raw: string | undefined): OwnerRouteTable {
  if (raw === undefined || raw.trim() === '') {
    return { routes: EMPTY_ROUTES, invalid_reason: null };
  }
  const invalid = (reason: string): OwnerRouteTable => ({
    routes: EMPTY_ROUTES,
    invalid_reason: reason,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid('not_an_object');
  }
  const routes = new Map<string, OwnerRoute>();
  for (const [handle, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const key = handle.trim().toLowerCase();
    if (!key) return invalid('blank_handle');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return invalid('entry_not_an_object');
    }
    const { recipient, thread_id: threadId } = entry as Record<string, unknown>;
    if (recipient !== OWNER_ROUTE_RECIPIENT) return invalid('recipient_not_t3_desk_local');
    if (typeof threadId !== 'string' || threadId.trim() === '') {
      return invalid('thread_id_missing');
    }
    if (routes.has(key)) return invalid('duplicate_handle');
    routes.set(key, { recipient: OWNER_ROUTE_RECIPIENT, thread_id: threadId.trim() });
  }
  return { routes, invalid_reason: null };
}

/** Owner-handoff text: ASCII, at most this many characters. */
export const OWNER_TEXT_MAX_CHARS = 1500;

/** Fixed last line of every owner row (John 2026-11-08, M-20261108b). */
export const OWNER_ESCALATION_LINE =
  'You own this as your own developer work. If you need more capability, ' +
  'escalate to a stronger model or subagent yourself instead of waiting or ' +
  'escalating to XO or John.';

/**
 * One line of printable ASCII: control characters become spaces, non-ASCII
 * and at-signs are dropped (no mention can be forged), whitespace collapses,
 * and the result is capped at maxChars (truncated text ends in "...").
 */
function ownerTextValue(raw: unknown, maxChars: number): string {
  if (typeof raw !== 'string') return '';
  let printable = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) printable += ' ';
    else if (code > 0x7e || ch === '@') continue;
    else printable += ch;
  }
  const cleaned = printable.replace(/ {2,}/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

/**
 * The owner-handoff text. The WHOLE text is capped at OWNER_TEXT_MAX_CHARS:
 * the blocker takes whatever budget the other lines leave (up to 600), so
 * the fixed last line always survives intact.
 */
export function buildOwnerEscalationText(card: OperatorCardView['card']): string {
  const head = [`Overseer escalation for ${ownerTextValue(card.wo_id, 200)}.`];
  const prUrl = ownerTextValue(card.pr_url, 300);
  if (prUrl) head.push(`PR: ${prUrl}`);
  const tail = [`Next: ${ownerTextValue(card.next_permitted_action, 200)}`, OWNER_ESCALATION_LINE];
  const blockerLabel = 'Blocker: ';
  const fixedLength =
    [...head, ...tail].reduce((total, line) => total + line.length + 1, 0) + blockerLabel.length;
  const blockerBudget = Math.min(600, OWNER_TEXT_MAX_CHARS - fixedLength);
  const blocker = ownerTextValue(card.blocker, Math.max(4, blockerBudget));
  return [...head, `${blockerLabel}${blocker}`, ...tail].join('\n');
}

type OwnerDeliveryPlan =
  | { kind: 'standard' }
  | { kind: 'owner_route'; owner: string; route: OwnerRoute; body: string }
  | {
      kind: 'needs_owner';
      reason: 'unowned' | 'owner_route_missing' | 'owner_row_rejected';
      detail: string;
    };

function issueUrl(sourceIssue: unknown): string | null {
  if (typeof sourceIssue !== 'string') return null;
  const match = /^thinmansoftware\/bdc-xo#([1-9][0-9]*)$/.exec(sourceIssue);
  return match ? `https://github.com/thinmansoftware/bdc-xo/issues/${match[1]}` : null;
}

/**
 * Decide how a card is delivered in mode on. 'standard' is today's path
 * (operator row for an XO principal, t3-desktop row always). A card whose
 * actor was passed explicitly by the caller (not derived from the
 * resolution) also takes the standard path.
 */
function planOwnerDelivery(
  card: OperatorCardView['card'],
  routes: OwnerRouteTable
): OwnerDeliveryPlan {
  const actor = card.responsible_actor.trim();
  if (isXoResponsibleActor(actor)) return { kind: 'standard' };
  const assignment = (card.payload as { owner_assignment?: unknown }).owner_assignment;
  if (!assignment || typeof assignment !== 'object') return { kind: 'standard' };
  const resolved = assignment as Record<string, unknown>;
  const url = issueUrl(resolved.source_issue);
  if (resolved.kind === 'owned' && typeof resolved.owner === 'string') {
    if (resolved.owner.toLowerCase() !== actor.toLowerCase()) return { kind: 'standard' };
    const route = routes.routes.get(resolved.owner.toLowerCase());
    if (route) {
      // One t3-thread-nudge/v1 row for the owner's T3 thread (the
      // approval-stalls row shape). The content guard is pure, so both
      // adapters agree: a rejected body never reaches the owner and the
      // builder monitor is told needs_owner instead of a silent skip.
      const body = JSON.stringify({
        schema: 't3-thread-nudge/v1',
        thread_id: route.thread_id,
        text: buildOwnerEscalationText(card),
        reason: 'owner-escalation',
        request_id: card.card_id,
      });
      if (assessDispatchMessageBody('agent_message', body).allowed) {
        return { kind: 'owner_route', owner: resolved.owner, route, body };
      }
      return {
        kind: 'needs_owner',
        reason: 'owner_row_rejected',
        detail: `${card.blocker} | owner_row_rejected for owner ${resolved.owner}${url ? `: ${url}` : ''}`,
      };
    }
    return {
      kind: 'needs_owner',
      reason: 'owner_route_missing',
      detail: `${card.blocker} | owner_route_missing for owner ${resolved.owner}${url ? `: ${url}` : ''}`,
    };
  }
  if (resolved.kind === 'unowned' && actor === UNOWNED_RESPONSIBLE_ACTOR) {
    return {
      kind: 'needs_owner',
      reason: 'unowned',
      detail: url
        ? `${card.blocker} | assign an owner: ${url}`
        : `${card.blocker} | assign an owner (no WO issue found for ${card.wo_id})`,
    };
  }
  return { kind: 'standard' };
}

const defaultStore: DeliveryStore = {
  claimDueDeliveryJob,
  getOperatorCard,
  appendDeliveryReceipt,
  completeDeliveryJob,
};

const DEFAULT_BUILDER_MONITOR_URL = 'https://n8n.bluedevilcollectibles.com/webhook/builder-status';
const ACTIVE_OPERATOR_CARD_CHANNEL_SET = new Set<string>(ACTIVE_OPERATOR_CARD_CHANNELS);

function classifyHttpFailure(status: number, channel: string): ChannelDeliveryResult {
  if (status >= 500 && status <= 599) {
    return {
      outcome: 'indeterminate',
      sanitized_status: `${channel}_provider_state_unknown`,
      error_class: `http_${status}`,
    };
  }
  const retrySafe = status === 429;
  return {
    outcome: retrySafe ? 'transient_failure' : 'permanent_failure',
    sanitized_status: retrySafe ? `${channel}_retryable` : `${channel}_rejected`,
    error_class: `http_${status}`,
  };
}

export function createDefaultOperatorCardChannels(
  overrides: Partial<OperatorCardChannelDeps> = {}
): OperatorCardChannel[] {
  const deps = {
    fetch: overrides.fetch ?? globalThis.fetch,
    builder_monitor_url:
      overrides.builder_monitor_url ??
      process.env.BUILDER_MONITOR_WEBHOOK_URL ??
      DEFAULT_BUILDER_MONITOR_URL,
    resolve_owner: overrides.resolve_owner ?? resolveWoBoardSeatOwner,
    owner_routing_mode: overrides.owner_routing_mode ?? readOwnerRoutingMode(),
    owner_routes_json:
      'owner_routes_json' in overrides
        ? overrides.owner_routes_json
        : process.env.OVERSEER_OWNER_ROUTES_JSON,
    logger: overrides.logger,
  };
  // WO-HARNESS-OVERSEER-OWNER-ROUTING-01: the route table is parsed once per
  // channel build and only matters in mode on.
  const ownerRoutes =
    deps.owner_routing_mode === 'on'
      ? parseOwnerRouteTable(deps.owner_routes_json)
      : { routes: EMPTY_ROUTES, invalid_reason: null };
  if (ownerRoutes.invalid_reason) {
    reportInvalidRoutes(ownerRoutes.invalid_reason, deps.owner_routes_json ?? '', deps.logger);
  }
  const planFor = (card: OperatorCardView): OwnerDeliveryPlan =>
    deps.owner_routing_mode === 'on'
      ? planOwnerDelivery(card.card, ownerRoutes)
      : { kind: 'standard' };

  const dispatch: OperatorCardChannel = {
    channel: 'dispatch',
    deliver: async (card, idempotencyKey) => {
      // WO-HARNESS-DISPATCH-ROUTING-CUTOFF-01: always deliver to the T3 results
      // queue (plus the operator mailbox for XO-owned reports, below); the
      // resolved board-seat owner rides in the body as owner_seat so the
      // desktop bridge can address it (null when unresolved).
      const ownerSeat = (await deps.resolve_owner(card.card.wo_id)) ?? null;
      const body = JSON.stringify({
        ...(JSON.parse(buildDispatchRunReportBody(card.card)) as Record<string, unknown>),
        owner_seat: ownerSeat,
      });
      const assessment = assessDispatchMessageBody('run_report', body);
      if (!assessment.allowed) {
        return {
          outcome: 'permanent_failure',
          sanitized_status: 'dispatch_content_rejected',
          error_class: assessment.reason ?? 'content_guard_rejected',
        };
      }
      // Fence 281: a run report whose responsible actor is an XO principal
      // must ALSO reach the operator mailbox (the XO drain and the
      // operator-inbox-consumer read it). The T3 copy is kept so the T3
      // results bridge still sees every report. Both rows share the run id
      // as correlation_id; the operator copy gets its own idempotency key so
      // redelivery and reconcile stay exactly-once per mailbox.
      const plan = planFor(card);
      if (plan.kind === 'owner_route') {
        // WO-HARNESS-OVERSEER-OWNER-ROUTING-01: keyed '<key>:owner' so
        // redelivery and reconcile write no second row.
        await createAuthenticatedMessage(
          { kind: 'system', sender: 'overseer' },
          {
            correlation_id: card.card.run_id,
            idempotency_key: `${idempotencyKey}:owner`,
            task_type: 'agent_message',
            recipient: plan.route.recipient,
            body: plan.body,
          }
        );
      } else if (plan.kind === 'needs_owner' && plan.reason === 'owner_row_rejected') {
        log.warn(
          { cardId: card.card.card_id, woId: card.card.wo_id },
          'overseer.owner_routing.owner_row_content_rejected'
        );
      }
      if (plan.kind === 'standard' && isXoResponsibleActor(card.card.responsible_actor)) {
        await createAuthenticatedMessage(
          { kind: 'system', sender: 'overseer' },
          {
            correlation_id: card.card.run_id,
            idempotency_key: `${idempotencyKey}:${OPERATOR_RECIPIENT}`,
            task_type: 'run_report',
            recipient: OPERATOR_RECIPIENT,
            body,
          }
        );
      }
      const message = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: card.card.run_id,
          idempotency_key: idempotencyKey,
          task_type: 'run_report',
          recipient: T3_DESKTOP_RECIPIENT,
          body,
        }
      );
      return {
        outcome: 'succeeded',
        sanitized_status: 'dispatch_queued',
        provider_receipt_id: message.id,
      };
    },
    reconcile: async card => dispatch.deliver(card, `operator-card:${card.card.card_id}:dispatch`),
  };

  const builderMonitor: OperatorCardChannel = {
    channel: 'builder_monitor',
    deliver: async card => {
      // WO-HARNESS-OVERSEER-OWNER-ROUTING-01: in mode on an unowned card, or
      // an owned card with no route, asks for an owner (needs_owner) with
      // the WO issue link; everything else is unchanged (needs_human).
      const plan = planFor(card);
      const response = await deps.fetch(deps.builder_monitor_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder: 'Cauldron',
          wo_id: card.card.wo_id,
          action: plan.kind === 'needs_owner' ? 'needs_owner' : 'needs_human',
          detail: plan.kind === 'needs_owner' ? plan.detail : card.card.blocker,
          card_id: card.card.card_id,
        }),
      });
      return response.ok
        ? { outcome: 'succeeded', sanitized_status: 'builder_monitor_accepted' }
        : classifyHttpFailure(response.status, 'builder_monitor');
    },
    reconcile: async () => ({
      outcome: 'indeterminate',
      sanitized_status: 'builder_monitor_provider_state_unknown',
    }),
  };

  return [dispatch, builderMonitor];
}

/** Raw OVERSEER_OWNER_ROUTES_JSON values already reported by the module logger. */
const reportedInvalidRoutes = new Set<string>();

/**
 * Log an invalid route table. The channels are rebuilt every scheduler tick,
 * so the module logger reports each distinct invalid value once; an injected
 * logger (tests) receives every report.
 */
function reportInvalidRoutes(
  reason: string,
  raw: string,
  logger: OperatorCardChannelDeps['logger'] | undefined
): void {
  const fields = { reason, length: raw.length };
  if (logger) {
    logger.warn(fields, 'overseer.owner_routing.routes_invalid');
    return;
  }
  if (reportedInvalidRoutes.has(raw)) return;
  reportedInvalidRoutes.add(raw);
  log.warn(fields, 'overseer.owner_routing.routes_invalid');
}

function normalizeResult(result: ChannelDeliveryResult): ChannelDeliveryResult {
  if (
    ['succeeded', 'transient_failure', 'permanent_failure', 'indeterminate'].includes(
      result.outcome
    )
  ) {
    return result;
  }
  return {
    outcome: 'indeterminate',
    sanitized_status: 'channel_returned_invalid_outcome',
    error_class: 'invalid_channel_result',
  };
}

function hasUnfinishedStartedReceipt(card: OperatorCardView, job: DeliveryJobRecord): boolean {
  const matches = card.receipts.filter(
    receipt => receipt.channel === job.channel && receipt.attempt_number === job.attempts_started
  );
  return (
    matches.some(receipt => receipt.phase === 'started') &&
    !matches.some(receipt => receipt.phase === 'terminal')
  );
}

export async function deliverOperatorCard(input: {
  job: DeliveryJobRecord;
  channel: OperatorCardChannel;
  owner: string;
  now: string;
  store?: DeliveryStore;
}): Promise<DeliveryJobRecord> {
  const store = input.store ?? defaultStore;
  const card = await store.getOperatorCard(input.job.card_id);
  if (!card) throw new Error('operator_card_not_found');
  const priorTerminal = card.receipts.find(
    receipt =>
      receipt.channel === input.job.channel &&
      receipt.attempt_number === input.job.attempts_started &&
      receipt.phase === 'terminal'
  );
  if (priorTerminal?.outcome) {
    return store.completeDeliveryJob({
      card_id: input.job.card_id,
      channel: input.job.channel,
      owner: input.owner,
      fencing_token: input.job.fencing_token,
      outcome: priorTerminal.outcome,
      now: input.now,
    });
  }
  const recovering = hasUnfinishedStartedReceipt(card, input.job);

  if (!recovering) {
    await store.appendDeliveryReceipt({
      card_id: input.job.card_id,
      channel: input.job.channel,
      attempt_number: input.job.attempts_started,
      phase: 'started',
      started_at: input.now,
      fencing_token: input.job.fencing_token,
      lease_owner: input.owner,
    });
  }

  let result: ChannelDeliveryResult;
  try {
    result = normalizeResult(
      recovering
        ? await input.channel.reconcile(card, input.job.attempts_started)
        : await input.channel.deliver(
            card,
            `operator-card:${input.job.card_id}:${input.job.channel}`
          )
    );
  } catch {
    result = recovering
      ? {
          outcome: 'indeterminate',
          sanitized_status: 'reconciliation_failed_unknown_provider_state',
          error_class: 'reconciliation_failed',
        }
      : {
          outcome: 'indeterminate',
          sanitized_status: 'channel_transport_state_unknown',
          error_class: 'response_state_unknown',
        };
  }

  const nextAttemptAt =
    result.outcome === 'transient_failure' && input.job.attempts_started < 3
      ? new Date(
          new Date(card.card.created_at).getTime() +
            (input.job.attempts_started === 1 ? 30_000 : 120_000)
        ).toISOString()
      : null;
  await store.appendDeliveryReceipt({
    card_id: input.job.card_id,
    channel: input.job.channel,
    attempt_number: input.job.attempts_started,
    phase: 'terminal',
    started_at: input.now,
    completed_at: input.now,
    outcome: result.outcome,
    sanitized_status: result.sanitized_status,
    error_class: result.error_class ?? null,
    next_attempt_at: nextAttemptAt,
    provider_receipt_id: result.provider_receipt_id ?? null,
    fencing_token: input.job.fencing_token,
    lease_owner: input.owner,
  });
  return store.completeDeliveryJob({
    card_id: input.job.card_id,
    channel: input.job.channel,
    owner: input.owner,
    fencing_token: input.job.fencing_token,
    outcome: result.outcome,
    now: input.now,
  });
}

async function retireInactiveOperatorCardChannel(input: {
  job: DeliveryJobRecord;
  owner: string;
  now: string;
  store: DeliveryStore;
}): Promise<DeliveryJobRecord> {
  await input.store.appendDeliveryReceipt({
    card_id: input.job.card_id,
    channel: input.job.channel,
    attempt_number: input.job.attempts_started,
    phase: 'terminal',
    started_at: input.now,
    completed_at: input.now,
    outcome: 'permanent_failure',
    sanitized_status: 'channel_retired',
    fencing_token: input.job.fencing_token,
    lease_owner: input.owner,
  });
  return input.store.completeDeliveryJob({
    card_id: input.job.card_id,
    channel: input.job.channel,
    owner: input.owner,
    fencing_token: input.job.fencing_token,
    outcome: 'permanent_failure',
    now: input.now,
  });
}

export async function runDueOperatorCardDeliveries(input: {
  channels: OperatorCardChannel[];
  owner: string;
  now?: string;
  max_jobs?: number;
  store?: DeliveryStore;
}): Promise<DeliveryJobRecord[]> {
  const store = input.store ?? defaultStore;
  const now = input.now ?? new Date().toISOString();
  const channels = new Map(input.channels.map(channel => [channel.channel, channel]));
  const completed: DeliveryJobRecord[] = [];
  for (let count = 0; count < (input.max_jobs ?? 100); count += 1) {
    const job = await store.claimDueDeliveryJob({ owner: input.owner, now });
    if (!job) break;
    if (!ACTIVE_OPERATOR_CARD_CHANNEL_SET.has(job.channel)) {
      completed.push(
        await retireInactiveOperatorCardChannel({ job, owner: input.owner, now, store })
      );
      continue;
    }
    const channel = channels.get(job.channel);
    if (!channel) throw new Error(`operator_card_channel_missing:${job.channel}`);
    completed.push(await deliverOperatorCard({ job, channel, owner: input.owner, now, store }));
  }
  return completed;
}
