/**
 * Operator inbox consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / bdc-xo#1455).
 *
 * Drains agent_dispatch_messages where recipient='operator' AND status='queued'
 * (listMessages also requires addressed_at IS NULL). Classifies each message,
 * surfaces needs-human items to a durable JSONL log (NOT Telegram/SMS -- that
 * gate stays dark per #1456), and marks handled via the existing DAL
 * acknowledgeMessage + addressMessage primitives.
 *
 * Scheduler skeleton cloned from packages/server/src/taskmaster/loop.ts
 * startTaskmaster (singleton timer, inFlight guard, env interval, 0 = off)
 * and the api.ts NODE_ENV !== 'test' gate at the call site.
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  acknowledgeMessage,
  addressMessage,
  listMessages,
  type DispatchMessage,
  type DispatchMailboxResult,
} from '@archon/core/db/dispatch';
import { createLogger, getArchonHome } from '@archon/paths';

const log = createLogger('dispatch/operator-inbox-consumer');

export const OPERATOR_INBOX_PRINCIPAL = 'operator';
export const DEFAULT_OPERATOR_INBOX_INTERVAL_MS = 60_000;

/** Minimal message shape the consumer needs (full DispatchMessage also works). */
export interface OperatorInboxMessage {
  id: string;
  task_type: string;
  sender: string;
  recipient: string;
  body: string;
  status: string;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  addressed_at: string | null;
  addressed_by: string | null;
}

export type ClassificationKind = 'digest_only' | 'code_actionable' | 'needs_human';

export interface Classification {
  kind: ClassificationKind;
  reason: string;
  /** Best-effort WO id extracted from body, if any. */
  woId: string | null;
  /** Best-effort GitHub issue ref like owner/repo#N, if any. */
  issueRef: string | null;
}

export interface SurfaceEntry {
  messageId: string;
  classification: ClassificationKind;
  reason: string;
  sender: string;
  taskType: string;
  createdAt: string;
  originalBody: string;
  woId: string | null;
  issueRef: string | null;
  surfacedAt: string;
}

export interface DrainResult {
  found: number;
  processed: number;
  failed: number;
  digests: number;
  codeActionable: number;
  needsHuman: number;
  errors: string[];
}

export interface OperatorInboxDeps {
  listMessages?: (filters: {
    recipient?: string;
    status?: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
    limit?: number;
  }) => Promise<OperatorInboxMessage[]>;
  acknowledgeMessage?: (data: {
    id: string;
    principal_id: string;
  }) => Promise<
    | DispatchMailboxResult
    | { ok: true; message: OperatorInboxMessage }
    | { ok: false; reason: string }
  >;
  addressMessage?: (data: {
    id: string;
    principal_id: string;
  }) => Promise<
    | DispatchMailboxResult
    | { ok: true; message: OperatorInboxMessage }
    | { ok: false; reason: string }
  >;
  surface?: (entry: SurfaceEntry) => Promise<void>;
  principalId?: string;
  now?: () => Date;
  /**
   * Optional code-actionable hook: comment/link on a findable GitHub issue.
   * Failures here must NOT prevent durable surface + address (conservative).
   */
  commentOnIssue?: (issueRef: string, body: string) => Promise<void>;
}

export interface OperatorInboxRuntime {
  intervalMs: number;
  lastDrainResult: DrainResult | null;
  ticks: number;
}

// ---------------------------------------------------------------------------
// Classification -- conservative: when in doubt, needs_human.
// ---------------------------------------------------------------------------

const KNOWN_ACTIONABLE_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /judge[_ ]?daily[_ ]?budget[_ ]?e(xceeded)?/i,
    reason: 'known_pattern:judge_daily_budget_exceeded',
  },
  {
    re: /judge health failure/i,
    reason: 'known_pattern:judge_health_failure',
  },
  {
    re: /pr[- ]?lookup|pull request.*(fail|error|creation)|quote-wrap/i,
    reason: 'known_pattern:pr_lookup_or_creation',
  },
  {
    re: /evidence_unavailable/i,
    reason: 'known_pattern:evidence_unavailable',
  },
];

const DIGEST_PATTERNS: RegExp[] = [/taskmaster daily digest/i, /no actions in the last 24h/i];

function extractWoId(text: string): string | null {
  const match = /\bWO-[A-Z0-9][A-Z0-9-]{2,}\b/i.exec(text);
  return match ? match[0].toUpperCase() : null;
}

function extractIssueRef(text: string): string | null {
  const full = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/.exec(text);
  if (full) return `${full[1]}#${full[2]}`;
  // Bare #N is not enough to comment safely without a default repo.
  return null;
}

function bodyText(message: OperatorInboxMessage): string {
  return message.body;
}

export function classifyOperatorMessage(message: OperatorInboxMessage): Classification {
  const text = bodyText(message);
  const woId = extractWoId(text);
  const issueRef = extractIssueRef(text);

  // Taskmaster digests and similar agent_message no-action traffic.
  if (message.task_type === 'agent_message') {
    const isDigest =
      DIGEST_PATTERNS.some(re => re.test(text)) ||
      (message.sender === 'taskmaster' && /digest/i.test(text));
    if (isDigest) {
      return {
        kind: 'digest_only',
        reason: 'taskmaster_or_daily_digest_no_action',
        woId,
        issueRef,
      };
    }
  }

  for (const pattern of KNOWN_ACTIONABLE_PATTERNS) {
    if (pattern.re.test(text)) {
      return {
        kind: 'code_actionable',
        reason: pattern.reason,
        woId,
        issueRef,
      };
    }
  }

  // A run_report with an explicit WO id is still needs_human unless the
  // blocker matches a known pattern -- we link the WO when surfacing but do
  // not auto-resolve unknown failures.
  return {
    kind: 'needs_human',
    reason: 'unrecognized_or_ambiguous_blocker',
    woId,
    issueRef,
  };
}

// ---------------------------------------------------------------------------
// Durable human surface (JSONL under ARCHON_HOME/operator-inbox/)
// ---------------------------------------------------------------------------

export function defaultOperatorInboxSurfacePath(): string {
  return join(getArchonHome(), 'operator-inbox', 'surface.jsonl');
}

export async function appendDurableSurfaceLog(entry: SurfaceEntry): Promise<void> {
  const path = defaultOperatorInboxSurfacePath();
  await mkdir(join(getArchonHome(), 'operator-inbox'), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  log.info(
    {
      messageId: entry.messageId,
      classification: entry.classification,
      woId: entry.woId,
      path,
    },
    'operator_inbox.surfaced'
  );
}

// ---------------------------------------------------------------------------
// Drain tick
// ---------------------------------------------------------------------------

function toInboxMessage(message: DispatchMessage | OperatorInboxMessage): OperatorInboxMessage {
  return {
    id: message.id,
    task_type: message.task_type,
    sender: message.sender,
    recipient: message.recipient,
    body: message.body,
    status: message.status,
    created_at: message.created_at,
    acknowledged_at: message.acknowledged_at,
    acknowledged_by: message.acknowledged_by,
    addressed_at: message.addressed_at,
    addressed_by: message.addressed_by,
  };
}

async function processOne(
  message: OperatorInboxMessage,
  deps: Required<
    Pick<
      OperatorInboxDeps,
      'acknowledgeMessage' | 'addressMessage' | 'surface' | 'principalId' | 'now'
    >
  > &
    Pick<OperatorInboxDeps, 'commentOnIssue'>
): Promise<{ classification: ClassificationKind }> {
  const classification = classifyOperatorMessage(message);
  const principalId = deps.principalId;
  const surfacedAt = deps.now().toISOString();

  if (classification.kind !== 'digest_only') {
    const entry: SurfaceEntry = {
      messageId: message.id,
      classification: classification.kind,
      reason: classification.reason,
      sender: message.sender,
      taskType: message.task_type,
      createdAt: message.created_at,
      originalBody: message.body,
      woId: classification.woId,
      issueRef: classification.issueRef,
      surfacedAt,
    };
    await deps.surface(entry);

    if (
      classification.kind === 'code_actionable' &&
      classification.issueRef &&
      deps.commentOnIssue
    ) {
      try {
        await deps.commentOnIssue(
          classification.issueRef,
          [
            '## Operator inbox auto-classification',
            '',
            `- message_id: \`${message.id}\``,
            `- classification: \`${classification.kind}\``,
            `- reason: ${classification.reason}`,
            `- wo_id: ${classification.woId ?? 'n/a'}`,
            `- created_at: ${message.created_at}`,
            '',
            '### Original body',
            '```',
            message.body.slice(0, 4000),
            '```',
            '',
            '_Surfaced by operator-inbox-consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01). Telegram/SMS gate stays dark (#1456)._',
          ].join('\n')
        );
      } catch (error) {
        // Best-effort only -- durable surface already written.
        log.warn(
          { err: error as Error, messageId: message.id, issueRef: classification.issueRef },
          'operator_inbox.github_comment_failed'
        );
      }
    }
  }

  const ack = await deps.acknowledgeMessage({ id: message.id, principal_id: principalId });
  if (!ack.ok) {
    throw new Error(`acknowledge_failed:${ack.reason}:${message.id}`);
  }
  const addressed = await deps.addressMessage({ id: message.id, principal_id: principalId });
  if (!addressed.ok) {
    throw new Error(`address_failed:${addressed.reason}:${message.id}`);
  }

  log.info(
    {
      messageId: message.id,
      classification: classification.kind,
      reason: classification.reason,
      woId: classification.woId,
    },
    'operator_inbox.message_processed'
  );

  return { classification: classification.kind };
}

/**
 * One drain tick: list queued operator messages, classify, surface, ack+address.
 * Failures on individual messages are collected; the tick continues so a single
 * bad row cannot permanently stop the drain (mirror of the failure mode this
 * WO exists to eliminate).
 */
export async function drainOperatorInbox(deps: OperatorInboxDeps = {}): Promise<DrainResult> {
  const list =
    deps.listMessages ??
    (async (filters: {
      recipient?: string;
      status?: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
      limit?: number;
    }): Promise<OperatorInboxMessage[]> => {
      const rows = await listMessages({
        recipient: filters.recipient,
        status: filters.status,
        limit: filters.limit,
      });
      return rows.map(toInboxMessage);
    });
  const ack =
    deps.acknowledgeMessage ??
    ((data: { id: string; principal_id: string }): Promise<DispatchMailboxResult> =>
      acknowledgeMessage(data));
  const address =
    deps.addressMessage ??
    ((data: { id: string; principal_id: string }): Promise<DispatchMailboxResult> =>
      addressMessage(data));
  const surface = deps.surface ?? appendDurableSurfaceLog;
  const principalId = deps.principalId ?? OPERATOR_INBOX_PRINCIPAL;
  const now = deps.now ?? ((): Date => new Date());

  const result: DrainResult = {
    found: 0,
    processed: 0,
    failed: 0,
    digests: 0,
    codeActionable: 0,
    needsHuman: 0,
    errors: [],
  };

  let messages: OperatorInboxMessage[];
  try {
    messages = await list({
      recipient: OPERATOR_INBOX_PRINCIPAL,
      status: 'queued',
      limit: 500,
    });
  } catch (error) {
    const err = error as Error;
    log.error({ err }, 'operator_inbox.list_failed');
    result.failed = 1;
    result.errors.push(`list_failed:${err.message}`);
    return result;
  }

  result.found = messages.length;
  if (messages.length === 0) return result;

  for (const message of messages) {
    // Already addressed elsewhere -- listMessages should exclude these, but
    // keep the guard for injected/stale views.
    if (message.addressed_at !== null) continue;

    try {
      const { classification } = await processOne(message, {
        acknowledgeMessage: ack,
        addressMessage: address,
        surface,
        principalId,
        now,
        commentOnIssue: deps.commentOnIssue,
      });
      result.processed += 1;
      if (classification === 'digest_only') result.digests += 1;
      else if (classification === 'code_actionable') result.codeActionable += 1;
      else result.needsHuman += 1;
    } catch (error) {
      const err = error as Error;
      result.failed += 1;
      result.errors.push(`${message.id}:${err.message}`);
      log.error({ err, messageId: message.id }, 'operator_inbox.message_process_failed');
    }
  }

  if (result.processed > 0 || result.failed > 0) {
    log.info(
      {
        found: result.found,
        processed: result.processed,
        failed: result.failed,
        digests: result.digests,
        codeActionable: result.codeActionable,
        needsHuman: result.needsHuman,
      },
      'operator_inbox.drain_completed'
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler singleton (cloned from taskmaster/loop.ts startTaskmaster)
// ---------------------------------------------------------------------------

let operatorInboxTimer: ReturnType<typeof setInterval> | undefined;
let operatorInboxRuntime: OperatorInboxRuntime | undefined;

/**
 * Parse OPERATOR_INBOX_INTERVAL_MS: integer > 0 enables at that interval;
 * 0 disables (KILLED); anything else falls back to 60000.
 */
export function resolveOperatorInboxIntervalMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  return DEFAULT_OPERATOR_INBOX_INTERVAL_MS;
}

export function stopOperatorInboxConsumer(): void {
  if (operatorInboxTimer) clearInterval(operatorInboxTimer);
  operatorInboxTimer = undefined;
  operatorInboxRuntime = undefined;
}

export function getOperatorInboxRuntime(): OperatorInboxRuntime | undefined {
  return operatorInboxRuntime;
}

/**
 * Start the operator inbox consumer. Module-scope singleton: subsequent calls
 * while a timer exists are no-ops. OPERATOR_INBOX_INTERVAL_MS=0 disables.
 */
export function startOperatorInboxConsumer(deps: OperatorInboxDeps = {}): void {
  if (operatorInboxTimer !== undefined) return;
  const intervalMs = resolveOperatorInboxIntervalMs(process.env.OPERATOR_INBOX_INTERVAL_MS);
  if (intervalMs === 0) {
    log.info({}, 'operator_inbox.disabled_by_interval_env');
    return;
  }
  const runtime: OperatorInboxRuntime = {
    intervalMs,
    lastDrainResult: null,
    ticks: 0,
  };
  operatorInboxRuntime = runtime;
  let inFlight = false;
  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const drainResult = await drainOperatorInbox(deps);
      runtime.lastDrainResult = drainResult;
      runtime.ticks += 1;
    } catch (error) {
      // Outer guard: drainOperatorInbox already isolates per-message errors;
      // this catches unexpected top-level throws so the timer keeps firing.
      log.error({ err: error as Error }, 'operator_inbox.tick_failed');
    } finally {
      inFlight = false;
    }
  };
  operatorInboxTimer = setInterval(() => void runTick(), intervalMs);
  operatorInboxTimer.unref?.();
  void runTick();
}
