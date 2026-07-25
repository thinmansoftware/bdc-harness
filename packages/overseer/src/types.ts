import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';

export type WatchedRunStatus = string;

export interface OverseerRunRecord {
  id: string;
  woId: string;
  repo: string;
  owner: string;
  status: WatchedRunStatus;
  headBranch?: string;
  /** Engine-written worktree path. Provenance anchor -- not agent-authored. */
  workingPath?: string;
  metadata?: Record<string, unknown>;
}

export interface OverseerWorkflowEvent {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at?: string;
}

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export type PullRequestState = string;

export interface PullRequestCheckSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  conclusion?: string;
}

export interface PullRequestEvidence {
  exists: boolean;
  state: PullRequestState;
  checks: PullRequestCheckSummary;
  mergeable: boolean | null;
  pr?: PullRequestRef;
  prTitle?: string;
  filesChangedCount?: number;
  diffStat?: string;
  htmlUrl?: string;
  /**
   * Head SHA as reported by the GitHub API for this PR. Independent of run metadata --
   * merge provenance compares this against the run's own worktree tip.
   */
  headSha?: string;
}

export interface GrokJudgeEvidence {
  woId: string;
  prNumber: number;
  prTitle: string;
  headSha: string;
  baseSha: string;
  evidenceDigest: string;
  operator: MergeOperatorIdentity;
  checksSummary: PullRequestCheckSummary;
  filesChangedCount: number;
  diffStat: string;
}

export interface MergeOperatorIdentity {
  identity: string;
  provider: string;
  modelFamily: string;
}

export interface GrokDispositionReceipt {
  schemaVersion: 'overseer-grok-merge-disposition-v1';
  disposition: 'approve' | 'hold';
  reason:
    | 'judge_approve'
    | 'judge_hold'
    | 'judge_output_invalid'
    | 'judge_timeout'
    | 'judge_exit_nonzero'
    | 'judge_error';
  woId: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  evidenceDigest: string;
  operator: MergeOperatorIdentity;
}

export interface WatchedRunRecord {
  runId: string;
  woId: string;
  repo: string;
  owner: string;
  status: WatchedRunStatus;
  headBranch?: string;
  /** Engine-written worktree path. Provenance anchor -- not agent-authored. */
  workingPath?: string;
  metadata?: Record<string, unknown>;
  errorClass?: ErrorClass | 'tail_node_false_fail';
  action: 'success' | 'merge_ready' | 'escalate' | 'ignore';
  reason: string;
  prEvidence: PullRequestEvidence;
  decision?: DecisionResult;
  lastEvent?: OverseerWorkflowEvent;
}

export interface OverseerRunStoreDeps {
  listRunsForWatch(): Promise<OverseerRunRecord[]>;
  listRunEvents(runId: string): Promise<OverseerWorkflowEvent[]>;
}

export interface OverseerActionsDeps {
  insertOverseerAction(record: {
    runId: string;
    woId: string;
    class: string;
    action: string;
    result: string;
  }): Promise<void>;
}

export interface GrokJudgeDeps {
  judgeSecondOpinion?(evidence: GrokJudgeEvidence): Promise<GrokDispositionReceipt>;
}

export interface GitHubPullRequestSearchInput {
  owner: string;
  repo: string;
  headBranch?: string;
  woId?: string;
}

export interface GitHubPullRequestMergeInput extends PullRequestRef {
  commitTitle?: string;
}

export interface GitHubClientDeps {
  findPullRequest(input: GitHubPullRequestSearchInput): Promise<PullRequestEvidence>;
  mergePullRequest(
    input: GitHubPullRequestMergeInput
  ): Promise<{ merged: boolean; message?: string }>;
}
