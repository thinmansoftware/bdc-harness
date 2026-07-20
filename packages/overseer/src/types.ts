import type { DecisionResult } from './decide.ts';
import type { ErrorClass } from './classify.ts';
import type {
  RepairRefireAssessment,
  RepairRefireAssessmentInput,
} from './actions/repair-refire.ts';
import type { BranchAssessmentResultV1, BranchCandidateInputV1 } from './actions/refresh-rebase.ts';
import type {
  LifecycleAssessmentResultV1,
  LifecycleCandidateInputV1,
} from './actions/lifecycle.ts';

export type WatchedRunStatus = string;

/**
 * WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01 (revised 2026-07-20 after Codex
 * final review): typed assessor result attached to every watched run that the
 * Slice 4-7 wiring evaluated. Executors dispatch on the fully-typed
 * `assessment.disposition` field (e.g. 'repair' | 'refire_first' |
 * 'refire_later' | 'refresh' | 'rebase' | 'eligible' -- see the underlying
 * result types), never by parsing the record `reason` text. Populated for every
 * run assessRun considers, including inert outcomes (reconcile_only /
 * report_only / read_only / ineligible / denied / escalate), so a follow-on
 * per-capability coordinator can inspect the exact assessor outcome without
 * re-running the assessment. When the top-level `action` is `escalate` the
 * `slice8` payload records the last inert disposition each capability produced
 * (repair -> refresh -> lifecycle) for observability.
 */
export type Slice8Disposition =
  | { readonly kind: 'repair_refire'; readonly assessment: RepairRefireAssessment }
  | { readonly kind: 'refresh_rebase'; readonly assessment: BranchAssessmentResultV1 }
  | { readonly kind: 'lifecycle'; readonly assessment: LifecycleAssessmentResultV1 };

/**
 * Optional evidence-assembler seam. When wired (by a follow-on per-capability
 * WO), each assembler returns the evidence-bearing subset of the assessor's
 * candidate input for the run at hand; the watch layer merges that onto the
 * gate/identity defaults and calls the pure assessor. When absent (today's
 * default), the watch path passes explicit no-evidence values so every assessor
 * short-circuits to an inert disposition -- reachable but never dispatchable.
 *
 * This deps interface is the honest replacement for the previous hard-coded
 * inert inputs: the classify path is genuinely reachable through injection, not
 * provably dead. Each capability is independent -- a runtime may wire one
 * assembler without wiring the others.
 */
export interface Slice8EvidenceDeps {
  assembleRepairRefireEvidence?(
    run: OverseerRunRecord,
    prEvidence: PullRequestEvidence
  ): Promise<Partial<RepairRefireAssessmentInput> | null>;
  assembleBranchRefreshEvidence?(
    run: OverseerRunRecord,
    prEvidence: PullRequestEvidence
  ): Promise<Partial<BranchCandidateInputV1> | null>;
  assembleLifecycleEvidence?(
    run: OverseerRunRecord,
    prEvidence: PullRequestEvidence
  ): Promise<Partial<LifecycleCandidateInputV1> | null>;
}

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
  metadata?: Record<string, unknown>;
  errorClass?: ErrorClass | 'tail_node_false_fail';
  // 'repair_refire' | 'refresh_rebase' | 'lifecycle' added by
  // WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01: dispatch targets for the shipped
  // M-42 Slice 4-7 assessors once a per-capability executor/coordinator is wired.
  action:
    | 'success'
    | 'merge_ready'
    | 'repair_refire'
    | 'refresh_rebase'
    | 'lifecycle'
    | 'escalate'
    | 'ignore';
  reason: string;
  prEvidence: PullRequestEvidence;
  decision?: DecisionResult;
  lastEvent?: OverseerWorkflowEvent;
  /**
   * WO-HARNESS-OVERSEER-SLICE8-LIVE-WIRING-01 (revised 2026-07-20): typed
   * Slice 4-7 assessor result. Present whenever the record's action is one of
   * repair_refire / refresh_rebase / lifecycle (dispatchable outcome). Also
   * populated with the last inert assessment when action is `escalate`, so
   * downstream observers can see what each capability concluded without
   * re-running the assessment.
   */
  slice8?: Slice8Disposition;
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
