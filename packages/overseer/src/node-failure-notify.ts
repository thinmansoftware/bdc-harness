import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import type { ErrorClass } from './classify';
import type { Decision } from './decide';

export const NODE_FAILURE_BLOCKER_CLASSES = ['out_of_credits', 'auth_failed'] as const;
export const NODE_FAILURE_IDEMPOTENCY_PREFIX = 'overseer-node-failure';
export const NODE_FAILURE_BLOCKER_IDEMPOTENCY_PREFIX = 'overseer-node-failure-blocker';

const SECRET_PATTERNS: readonly RegExp[] = [
  /authorization\s*:\s*(?:bearer\s+)?\S+/gi,
  /\b(?:token|api[_-]?key|password|secret)\s*[:=]\s*\S+/gi,
  /\bbearer\s+\S+/gi,
];

export function redactFailureText(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

export function firstSafeErrorLine(error: string): string {
  const line = error.split(/\r?\n/).find(candidate => candidate.trim().length > 0) ?? 'unavailable';
  return redactFailureText(line.trim()).slice(0, 300);
}

export interface NodeFailureNoticeInput {
  runId: string;
  workflowName: string;
  nodeId: string;
  errorClass: ErrorClass;
  decision: Decision;
  attempt: number;
  error: string;
  metadata?: Record<string, unknown>;
  userMessage?: string;
  loadBearing?: boolean;
  retryPathRemaining?: boolean;
}

interface NoticeLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

function issueNumber(input: NodeFailureNoticeInput): string | undefined {
  const metadata = input.metadata ?? {};
  for (const value of [metadata.wo_issue_number, metadata.issue_number, input.userMessage]) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    const match = /(?:bdc-xo#|issue\s*#?|#)(\d+)\b/i.exec(text);
    if (match) return match[1];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return undefined;
}

export function isNodeFailureBlocker(input: NodeFailureNoticeInput): boolean {
  return (
    (NODE_FAILURE_BLOCKER_CLASSES as readonly string[]).includes(input.errorClass) ||
    (input.errorClass === 'commit_hook_lint_failure' && input.attempt >= 2) ||
    (input.loadBearing === true && input.retryPathRemaining === false)
  );
}

export function buildNodeFailureNoticeBody(input: NodeFailureNoticeInput): string {
  return [
    `Run: ${input.runId}`,
    `Workflow: ${input.workflowName}`,
    `Node: ${input.nodeId}`,
    `Class: ${input.errorClass}`,
    `Decision: ${input.decision}`,
    `Attempt: ${input.attempt}`,
    `Error: ${firstSafeErrorLine(input.error)}`,
  ].join('\n');
}

export async function notifyNodeFailure(
  input: NodeFailureNoticeInput,
  log: NoticeLogger,
  send: typeof createAuthenticatedMessage = createAuthenticatedMessage
): Promise<void> {
  if (input.decision !== 'escalate') return;
  const subjectIssue = issueNumber(input);
  const common = {
    correlation_id: input.runId,
    task_type: 'agent_message' as const,
    repeat_reason: 'node_failure_escalation',
    body: buildNodeFailureNoticeBody(input),
    ...(subjectIssue ? { subject_key: `gh:thinmansoftware/bdc-xo#${subjectIssue}` } : {}),
  };
  const messages = [
    {
      ...common,
      idempotency_key: `${NODE_FAILURE_IDEMPOTENCY_PREFIX}:${input.runId}:${input.nodeId}`,
      recipient: 'duty-officer',
      priority: 'normal' as const,
    },
    ...(isNodeFailureBlocker(input)
      ? [
          {
            ...common,
            idempotency_key: `${NODE_FAILURE_BLOCKER_IDEMPOTENCY_PREFIX}:${input.runId}:${input.nodeId}`,
            recipient: 'xo',
            priority: 'blocker' as const,
          },
        ]
      : []),
  ];
  for (const message of messages) {
    try {
      await send({ kind: 'system', sender: 'overseer' }, message);
    } catch (err) {
      log.error(
        { err, runId: input.runId, nodeId: input.nodeId, recipient: message.recipient },
        'overseer.node_failure_notify_failed'
      );
    }
  }
}
