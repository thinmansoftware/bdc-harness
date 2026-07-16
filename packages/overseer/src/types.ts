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
}

export interface GrokJudgeEvidence {
  woId: string;
  prNumber: number;
  prTitle: string;
  checksSummary: PullRequestCheckSummary;
  filesChangedCount: number;
  diffStat: string;
}

export interface WatchedRunRecord {
  runId: string;
  woId: string;
  repo: string;
  owner: string;
  status: WatchedRunStatus;
  headBranch?: string;
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
  judgeSecondOpinion?(evidence: GrokJudgeEvidence): Promise<'approve' | 'hold'>;
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
