/**
 * Node-failure Dispatch notification
 * (WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01).
 *
 * Every Overseer `escalate` decision on a node failure -- bash node or AI node,
 * ANY error class including `unknown`, with or without an escalationContext --
 * writes one Dispatch message to recipient 'duty-officer' so the Duty Officer
 * digest carries it instead of the run dying silently (anchor: run 3993fe05,
 * 2026-10-14, a commit-hook lint failure escalated with ZERO rows in
 * agent_dispatch_messages). A blocker ALSO writes a second message to recipient
 * 'xo' at priority 'blocker'.
 *
 * This is DELIBERATELY separate from `runEscalation` (escalate.ts), which builds
 * and persists an operator card on the small set of silent-dead-end classes that
 * populate `escalationContext`. That path is unchanged: this module ADDS a
 * Dispatch write alongside it and fires on EVERY escalate, not only the
 * context-bearing ones.
 *
 * NO-LOOP GUARANTEE: the write is wrapped in try/catch. A failure logs
 * `overseer.node_failure_notify_failed` and returns -- it never throws, never
 * re-enters handleNodeFailure, and never re-enters any escalation path. The
 * run's own failed NodeOutput is produced by the caller regardless.
 */

import type { Logger } from '@archon/paths';
import * as dispatch from '@archon/core/db/dispatch';

/**
 * Error classes that are ALWAYS a blocker: no retry path exists and a person
 * must be told at priority blocker. commit_hook_lint_failure is NOT in this set
 * because it is a blocker only on its second occurrence (attempt >= 2), which
 * the decision layer surfaces via DecisionResult.blocker; the caller ORs that
 * flag with membership here. A single exported constant so the xo-escalation
 * table has one source of truth (Test 12).
 */
export const BLOCKER_ERROR_CLASSES: readonly string[] = ['out_of_credits', 'auth_failed'];

/** True when an error class is always-blocker by the exported table alone. */
export function isAlwaysBlockerClass(errorClass: string): boolean {
  return BLOCKER_ERROR_CLASSES.includes(errorClass);
}

/** Max length of the single error line carried in the body. */
const MAX_ERROR_LINE = 300;

/**
 * Redact anything that looks like a secret from one error line before it is
 * placed in a Dispatch body. Conservative: a token/key/password/Authorization
 * assignment or header has its VALUE replaced with [redacted]. The body never
 * carries more than this first line regardless.
 */
export function redactSecretsFromErrorLine(line: string): string {
  const assignment =
    /\b(authorization|api[_-]?key|access[_-]?token|secret|password|passwd|pwd|token|key)\b["']?\s*[:=]\s*|\bauthorization\b\s+|\bbearer\s+/gi;
  const pieces: string[] = [];
  let copied = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(line)) !== null) {
    let end = assignment.lastIndex;
    const authorization = /^authorization\b/i.test(match[0]);
    const quote = line[end];
    if (quote === '"' || quote === "'") {
      end += 1;
      // Escapes consume the next character. An unterminated value consumes
      // the remaining line, rather than exposing a partially quoted secret.
      while (end < line.length) {
        if (line[end] === '\\') {
          end = Math.min(end + 2, line.length);
        } else if (line[end++] === quote) {
          break;
        }
      }
    } else {
      // Unquoted Authorization may include Basic or another scheme plus a
      // credential. Conservatively remove its whole field through a delimiter.
      const delimiter = authorization ? /[,;]/ : /[\s,;]/;
      while (end < line.length && !delimiter.test(line[end])) end += 1;
    }
    pieces.push(line.slice(copied, assignment.lastIndex), '[redacted]');
    copied = end;
    assignment.lastIndex = end;
  }
  pieces.push(line.slice(copied));
  return pieces.join('');
}

/**
 * The first non-empty line of the error text, redacted and truncated to 300
 * characters. The body never carries more than this one line (Test 13).
 */
export function firstRedactedErrorLine(errorMsg: string | undefined): string {
  const line = (errorMsg ?? '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(l => l.length > 0);
  if (!line) return '';
  const redacted = redactSecretsFromErrorLine(line);
  return redacted.length > MAX_ERROR_LINE ? redacted.slice(0, MAX_ERROR_LINE) : redacted;
}

export interface NodeFailureNotifyInput {
  runId: string;
  workflowName: string;
  nodeId: string;
  errorClass: string;
  decision: string;
  attempt: number;
  /** Raw node error text; only the first redacted line reaches the body. */
  errorMsg: string;
  /** True -> ALSO message recipient 'xo' at priority blocker. */
  blocker: boolean;
  /**
   * `gh:thinmansoftware/bdc-xo#<issue>` when derivable from the run, else null.
   * When null the message carries no subject_key (dispatch treats it as absent),
   * so the Duty Officer routing still digests it via recipient.
   */
  subjectKey: string | null;
}

export interface NodeFailureNotifyDeps {
  log: Logger;
  /**
   * Seam over the real dispatch DAL. Defaults to the authenticated writer so
   * production and tests both exercise the real createAuthenticatedMessage
   * against whatever database getDatabase() returns -- tests point that at a
   * real SQLite harness rather than mocking the DAL itself.
   */
  createMessage?: typeof dispatch.createAuthenticatedMessage;
}

/** Human-readable, single-string body for the digest. Always a STRING. */
export function buildNodeFailureNotifyBody(input: NodeFailureNotifyInput): string {
  const errorLine = firstRedactedErrorLine(input.errorMsg);
  return [
    `Cauldron run ${input.runId} node failure escalated by the Overseer.`,
    `workflow: ${input.workflowName}`,
    `node: ${input.nodeId}`,
    `class: ${input.errorClass}`,
    `decision: ${input.decision}`,
    `attempt: ${input.attempt}`,
    input.blocker ? 'blocker: yes' : 'blocker: no',
    `error: ${errorLine}`,
  ].join('\n');
}

/**
 * Write the duty-officer message (and, when blocker, the xo message) for one
 * escalated node failure. Idempotent by construction: the idempotency_key is
 * unique, so a repeat write for the same (runId, nodeId) is a no-op.
 *
 * Never throws. createMessage is invoked at most twice (once per recipient).
 */
export async function notifyNodeFailureEscalation(
  deps: NodeFailureNotifyDeps,
  input: NodeFailureNotifyInput
): Promise<void> {
  const create = deps.createMessage ?? dispatch.createAuthenticatedMessage;
  const body = buildNodeFailureNotifyBody(input);
  const subjectKeyField = input.subjectKey ? { subject_key: input.subjectKey } : {};
  try {
    await create(
      { kind: 'system', sender: 'overseer' },
      {
        correlation_id: input.runId,
        idempotency_key: `overseer-node-failure:${input.runId}:${input.nodeId}`,
        task_type: 'agent_message',
        recipient: 'duty-officer',
        priority: 'normal',
        body,
        ...subjectKeyField,
      }
    );
    if (input.blocker) {
      await create(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: input.runId,
          idempotency_key: `overseer-node-failure-blocker:${input.runId}:${input.nodeId}`,
          task_type: 'agent_message',
          recipient: 'xo',
          priority: 'blocker',
          body,
          ...subjectKeyField,
        }
      );
    }
  } catch (err) {
    // No-loop guarantee: log and return. Never throw, never re-enter the
    // escalation path.
    deps.log.error(
      {
        err,
        runId: input.runId,
        nodeId: input.nodeId,
        errorClass: input.errorClass,
        blocker: input.blocker,
      },
      'overseer.node_failure_notify_failed'
    );
  }
}

/**
 * Best-effort derivation of the bdc-xo issue number for a run, for the
 * `gh:thinmansoftware/bdc-xo#<n>` subject_key. Checks common metadata keys
 * first, then falls back to a `bdc-xo#<n>` reference in the user message. Returns
 * null when nothing is derivable (the message is then written with no
 * subject_key).
 */
export function deriveBdcXoIssueNumber(run: {
  metadata: Record<string, unknown> | null | undefined;
  user_message: string | null | undefined;
}): number | null {
  const metadata = run.metadata ?? {};
  const metaKeys = ['woIssueNumber', 'issueNumber', 'issue_number', 'bdcXoIssue', 'xoIssue'];
  for (const key of metaKeys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (parsed > 0) return parsed;
    }
  }
  const match = /bdc-xo#(\d+)/i.exec(typeof run.user_message === 'string' ? run.user_message : '');
  if (match?.[1]) {
    const parsed = Number(match[1]);
    if (parsed > 0) return parsed;
  }
  return null;
}

/** Build the bdc-xo subject_key for a run, or null when no issue is derivable. */
export function bdcXoSubjectKeyForRun(run: {
  metadata: Record<string, unknown> | null | undefined;
  user_message: string | null | undefined;
}): string | null {
  const issue = deriveBdcXoIssueNumber(run);
  return issue === null ? null : `gh:thinmansoftware/bdc-xo#${issue}`;
}
