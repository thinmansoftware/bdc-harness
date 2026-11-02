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

/**
 * M-10.2 ratified this constraint in these exact words:
 *
 *   "agent_message MUST NOT carry repo-mutating INSTRUCTIONS"
 *
 * The architect seat named the real concern: agent_message accepts unrestricted
 * prompt text while only task-type labels are allowlisted, so a caller could
 * smuggle "go rebase and force-push" past a benign label. That is the threat.
 *
 * WHY THE FIRST IMPLEMENTATION WAS REPLACED (2026-07-26)
 * -----------------------------------------------------
 * v1 was `MUTATING_ACTION_RE && REPO_TARGET_RE` -- any text containing a mutation
 * verb anywhere near a repo noun. That tests VOCABULARY, not INTENT, and the
 * board's core business IS repos, branches, merges and deploys. Measured against
 * the 97 real motion files in bdc-xo docs/board/motions:
 *
 *     85 of 97 (87%) would have been REJECTED.
 *
 * Rejected items included M-73 (staging-to-production path), M-76 (give the site
 * its own repo), M-68/69/70/71 (rebuild the engine) -- and, definitively,
 * M-20260710-10-dispatch-dropbox-exception.md itself. The bus could not carry the
 * motion that authorized the bus.
 *
 * A guard that blocks 87% of legitimate traffic is not filtering; it is off. It
 * also promised an escape hatch that did not exist: the doc comment told operators
 * to "restate such requests as review/draft/report", but those task types ran the
 * identical check. The only exempt path was board_motion, which ships DISABLED by
 * design -- so the documented remedy was fictional and the sole open door was one
 * nobody is permitted to walk through.
 *
 * THE DISTINCTION THIS VERSION DRAWS
 * ----------------------------------
 * DISCUSSING mutation is the board's job. COMMANDING mutation is what M-10.2 bans.
 *
 *   "Should we give the board its own repo?"        -> discussion, ALLOW
 *   "Set one standard staging-to-production path"   -> discussion, ALLOW
 *   "Rebuild the engine so the fix is running"      -> discussion, ALLOW
 *   "Go rebase feature/x and force-push to main"    -> instruction, REJECT
 *   "Merge PR #123 now"                             -> instruction, REJECT
 *
 * The signal for an INSTRUCTION is imperative directed at the recipient, not the
 * presence of a repo noun. We detect the command form and keep the surrounding
 * prose out of it.
 */

/**
 * Mutation verbs, used ONLY in imperative position (see IMPERATIVE_MUTATION_RE).
 * Kept as a shared fragment so the verb list has one definition.
 */
const MUTATION_VERB = String.raw`(?:commit|push|merge|deploy|release|publish|tag|rebase|force[-\s]?push|revert|reset|cherry[-\s]?pick|amend|squash)`;

/**
 * An INSTRUCTION looks like a command aimed at the recipient. Three shapes:
 *
 *  1. bare imperative at the start of a line or after a bullet/number:
 *       "Merge PR #123", "- push the branch", "2. deploy to prod"
 *  2. second-person directive:
 *       "you should merge", "please push", "go ahead and deploy", "you must rebase"
 *  3. explicit now/immediately framing:
 *       "merge this now", "push it immediately"
 *
 * Deliberately NOT matched: infinitives and gerunds ("to merge", "merging",
 * "whether we should split"), past tense ("we merged", "was deployed"), questions
 * ("should we merge?"), and any mention inside quoted evidence -- all of which are
 * how a board actually talks about this work.
 */
const IMPERATIVE_MUTATION_RE = new RegExp(
  [
    // shape 1: line-initial imperative, optionally after a list marker
    String.raw`(?:^|\n)\s*(?:[-*+]|\d+[.)])?\s*${MUTATION_VERB}\b\s+(?:the\s+|this\s+|that\s+|it\b|pr\b|#\d)`,
    // shape 2: second-person directive
    String.raw`\b(?:you\s+(?:should|must|need\s+to|can|will)|please|go\s+ahead\s+and|now)\s+${MUTATION_VERB}\b`,
    // shape 3: imperative + urgency marker
    String.raw`\b${MUTATION_VERB}\s+(?:it|this|that|the\s+\S+)\s+(?:now|immediately|right\s+away)\b`,
  ].join('|'),
  'im'
);

/**
 * Raw shell/git command lines are unambiguous instructions regardless of prose.
 * This is the semantic-loophole case the architect seat raised: a benign label
 * wrapping an executable command.
 */
const EXECUTABLE_COMMAND_RE =
  /(?:^|\n)\s*(?:\$\s*)?(?:git\s+(?:push|merge|rebase|reset|commit|cherry-pick|tag)|gh\s+pr\s+merge|npm\s+publish|docker\s+(?:push|compose\s+up))\b(?!-)/im;

/**
 * board_motion is exempt from content assessment and remains gated ELSEWHERE
 * (board_delivery.enabled=false; M-27 authorized spec/prep only). Listing it here
 * does not enable it, and it must never be used to route around this guard --
 * doing so would flip a governance gate as a side effect of a payload error.
 */
const CONTENT_EXEMPT_TASK_TYPES: ReadonlySet<DispatchTaskType> = new Set(['board_motion']);

/**
 * Every non-exempt task type is checked for INSTRUCTIONS. The label is not
 * trusted: the architect seat's M-10.2 concern was precisely that a caller could
 * wrap an executable command in a benign task type. So `run_report` carrying
 * "Push this branch and merge it to dev" is still rejected.
 *
 * What changed from v1 is the TEST, not the coverage: instruction-shape rather
 * than vocabulary. Advisory traffic may freely DISCUSS merges, deploys and repos
 * -- that is the board's subject matter -- and may quote a failing `git push` as
 * evidence without being blinded to the failure it exists to review.
 */
export function assessDispatchMessageBody(
  taskType: DispatchTaskType,
  body: string
): DispatchContentAssessment {
  if (CONTENT_EXEMPT_TASK_TYPES.has(taskType)) return { allowed: true };

  const isInstruction = EXECUTABLE_COMMAND_RE.test(body) || IMPERATIVE_MUTATION_RE.test(body);
  if (!isInstruction) return { allowed: true };

  return {
    allowed: false,
    reason:
      taskType === 'agent_message'
        ? 'repo_mutating_agent_message_rejected'
        : 'repo_mutating_dispatch_body_rejected',
  };
}
