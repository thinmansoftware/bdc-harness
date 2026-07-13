export type DispatchTaskType =
  | 'agent_message'
  | 'run_review'
  | 'draft_spec'
  | 'run_report'
  | 'board_motion';

export interface DispatchContentAssessment {
  allowed: boolean;
  reason?: string;
}

const MUTATING_ACTION_RE =
  /\b(commit|push|merge|deploy|release|publish|tag|rebase|force[-\s]?push|open\s+a\s+pr|create\s+a\s+pull\s+request|apply\s+the\s+patch|land\s+the\s+change)\b/i;
const REPO_TARGET_RE =
  /\b(git|github|branch|repo(?:sitory)?|pull\s+request|pr|main|dev|staging|production|prod|worktree|checkout)\b/i;

/**
 * M-10.2 guardrail: v1 agent_message packets are for review/draft/report relay,
 * not repo mutation. This heuristic intentionally rejects obvious mutation verbs
 * paired with repo/deploy nouns. It is conservative and may false-positive on
 * meta-discussion; operators can restate such requests as review/draft/report.
 */
export function assessDispatchMessageBody(
  taskType: DispatchTaskType,
  body: string
): DispatchContentAssessment {
  if (taskType !== 'agent_message') return { allowed: true };

  const normalized = body.replace(/\s+/g, ' ').trim();
  if (MUTATING_ACTION_RE.test(normalized) && REPO_TARGET_RE.test(normalized)) {
    return {
      allowed: false,
      reason: 'repo_mutating_agent_message_rejected',
    };
  }

  return { allowed: true };
}
