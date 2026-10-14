import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import type { ErrorClass } from './classify';
import type { Decision } from './decide';

export const NODE_FAILURE_BLOCKER_CLASSES = [
  'out_of_credits',
  'auth_failed',
] as const satisfies readonly ErrorClass[];

export interface NodeFailureNotificationInput {
  runId: string;
  workflowName: string;
  nodeId: string;
  errorClass: ErrorClass;
  decision: Decision;
  attempt: number;
  error: string;
  issueNumber?: number;
  loadBearing?: boolean;
  retryPathRemaining?: boolean;
  log: { error(fields: Record<string, unknown>, message: string): void };
}

export function sanitizeFailureLine(error: string): string {
  const line =
    error
      .split(/\r?\n/)
      .find(value => value.trim())
      ?.trim() ?? '(no error text)';
  return line
    .replace(/\b(Authorization)\s*:\s*(?:Bearer\s+)?\S+/gi, '$1: [REDACTED]')
    .replace(/\b(token|key|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 300);
}

export function buildNodeFailureDispatchBody(input: NodeFailureNotificationInput): string {
  return [
    `Run: ${input.runId}`,
    `Workflow: ${input.workflowName}`,
    `Node: ${input.nodeId}`,
    `Error class: ${input.errorClass}`,
    `Decision: ${input.decision}`,
    `Attempt: ${input.attempt}`,
    `Error: ${sanitizeFailureLine(input.error)}`,
  ].join('\n');
}

export function isNodeFailureBlocker(input: NodeFailureNotificationInput): boolean {
  return (
    (NODE_FAILURE_BLOCKER_CLASSES as readonly string[]).includes(input.errorClass) ||
    (input.errorClass === 'commit_hook_lint_failure' && input.attempt >= 2) ||
    (input.loadBearing === true && input.retryPathRemaining === false)
  );
}

export async function notifyNodeFailure(input: NodeFailureNotificationInput): Promise<void> {
  const common = {
    correlation_id: input.runId,
    task_type: 'agent_message' as const,
    ...(input.issueNumber ? { subject_key: `gh:thinmansoftware/bdc-xo#${input.issueNumber}` } : {}),
    body: buildNodeFailureDispatchBody(input),
  };
  const writes = [
    createAuthenticatedMessage(
      { kind: 'system', sender: 'overseer' },
      {
        ...common,
        recipient: 'duty-officer',
        priority: 'normal',
        idempotency_key: `overseer-node-failure:${input.runId}:${input.nodeId}`,
      }
    ),
    ...(isNodeFailureBlocker(input)
      ? [
          createAuthenticatedMessage(
            { kind: 'system', sender: 'overseer' },
            {
              ...common,
              recipient: 'xo',
              priority: 'blocker',
              idempotency_key: `overseer-node-failure-blocker:${input.runId}:${input.nodeId}`,
            }
          ),
        ]
      : []),
  ];
  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === 'rejected') {
      input.log.error(
        { err: result.reason, runId: input.runId, nodeId: input.nodeId },
        'overseer.node_failure_notify_failed'
      );
    }
  }
}
