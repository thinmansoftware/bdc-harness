import { createHash } from 'node:crypto';
import {
  assessQualifiedMerge as defaultAssessQualifiedMerge,
  handleMergeReady as defaultHandleMergeReady,
  type ExecuteQualifiedMergeDeps,
  type FusionEvidence,
  type IndependentReviewEvidence,
  type QualifiedMergeEvidence,
  type QualifiedMergeAssessment,
  type QualifiedMergeExecution,
} from './actions/merge-ready';
import type { OverseerActionPolicyRegistry, OverseerDeploymentEffect } from './policy-registry';
import type {
  GrokDispositionReceipt,
  MergeOperatorIdentity,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types';

export interface AssembledQualifiedMergeEvidence {
  readonly evidence: QualifiedMergeEvidence;
  readonly evidenceDigest: string;
}

export interface MergeEvidenceAssemblyDeps {
  readPolicy(record: WatchedRunRecord): Promise<{
    readonly registry: OverseerActionPolicyRegistry;
    readonly credentialPrincipal: string;
    readonly resultingDeploymentEffect: OverseerDeploymentEffect;
  }>;
  readPullRequest(record: WatchedRunRecord): Promise<{
    readonly owner: string;
    readonly repository: string;
    readonly baseBranch: string;
    readonly changedFiles: readonly string[];
    readonly prNumber: number;
    readonly headSha: string;
    readonly baseSha: string;
    readonly prEvidence: PullRequestEvidence;
    readonly requiredChecks: QualifiedMergeEvidence['required_checks'];
    readonly reviews: QualifiedMergeEvidence['reviews'];
  }>;
  readIndependentReview(record: WatchedRunRecord): Promise<IndependentReviewEvidence | null>;
  readManifestV2(record: WatchedRunRecord): Promise<{ readonly valid: boolean } | null>;
  readM31Proposal(record: WatchedRunRecord): Promise<{
    readonly proposalId: string | null;
    readonly present: boolean;
    readonly verifierRegistryDigest: string;
  }>;
  readFusionEvidence(record: WatchedRunRecord): Promise<FusionEvidence | null>;
  compareFinalState(record: WatchedRunRecord): Promise<boolean>;
  readonly operator: MergeOperatorIdentity;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export async function assembleQualifiedMergeEvidence(
  record: WatchedRunRecord,
  deps: MergeEvidenceAssemblyDeps
): Promise<AssembledQualifiedMergeEvidence> {
  const [policy, pullRequest, independentReview, manifest, proposal, fusion, finalState] =
    await Promise.all([
      deps.readPolicy(record),
      deps.readPullRequest(record),
      deps.readIndependentReview(record),
      deps.readManifestV2(record),
      deps.readM31Proposal(record),
      deps.readFusionEvidence(record),
      deps.compareFinalState(record),
    ]);
  const evidence: QualifiedMergeEvidence = {
    record: { ...record, prEvidence: pullRequest.prEvidence },
    registry: policy.registry,
    owner: pullRequest.owner,
    repository: pullRequest.repository,
    base_branch: pullRequest.baseBranch,
    resulting_deployment_effect: policy.resultingDeploymentEffect,
    credential_principal: policy.credentialPrincipal,
    action_kind: 'MERGE',
    changed_files: pullRequest.changedFiles,
    pr_number: pullRequest.prNumber,
    head_sha: pullRequest.headSha,
    base_sha: pullRequest.baseSha,
    required_checks: pullRequest.requiredChecks,
    reviews: pullRequest.reviews,
    independent_review: independentReview,
    operator: {
      identity: deps.operator.identity,
      provider: deps.operator.provider,
      model_family: deps.operator.modelFamily,
    },
    manifest,
    proposal_id: proposal.proposalId,
    proposal_present: proposal.present,
    fusion,
    expected_verifier_registry_digest: proposal.verifierRegistryDigest,
    final_state_consistent: finalState,
  };
  const evidenceDigest = createHash('sha256')
    .update(
      canonical({
        woId: record.woId,
        policy,
        pullRequest,
        independentReview,
        manifest,
        proposal,
        fusion,
        finalState,
        operator: deps.operator,
      })
    )
    .digest('hex');
  return { evidence, evidenceDigest };
}

export interface MergeCoordinatorDeps {
  readonly assembleEvidence: (record: WatchedRunRecord) => Promise<AssembledQualifiedMergeEvidence>;
  readonly judge: (input: {
    readonly woId: string;
    readonly prNumber: number;
    readonly prTitle: string;
    readonly headSha: string;
    readonly baseSha: string;
    readonly evidenceDigest: string;
    readonly operator: MergeOperatorIdentity;
    readonly checksSummary: QualifiedMergeEvidence['record']['prEvidence']['checks'];
    readonly filesChangedCount: number;
    readonly diffStat: string;
  }) => Promise<GrokDispositionReceipt>;
  readonly assess?: (evidence: QualifiedMergeEvidence) => QualifiedMergeAssessment;
  readonly handleMergeReady?: typeof defaultHandleMergeReady;
  readonly executionDeps: ExecuteQualifiedMergeDeps;
  readonly insertOverseerAction: ExecuteQualifiedMergeDeps['insertOverseerAction'];
}

export type MergeCoordinatorResult =
  | {
      readonly status: 'executed';
      readonly receipt: GrokDispositionReceipt;
      readonly execution: QualifiedMergeExecution;
    }
  | { readonly status: 'held'; readonly receipt: GrokDispositionReceipt; readonly execution: null }
  | {
      readonly status: 'gated';
      readonly receipt: null;
      readonly execution: QualifiedMergeExecution;
    };

function holdReceipt(
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string,
  reason: GrokDispositionReceipt['reason']
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition: 'hold',
    reason,
    woId: evidence.record.woId,
    prNumber: evidence.pr_number,
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    operator: {
      identity: evidence.operator.identity,
      provider: evidence.operator.provider,
      modelFamily: evidence.operator.model_family,
    },
  };
}

function receiptMatches(
  receipt: GrokDispositionReceipt,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string
): boolean {
  return (
    receipt.schemaVersion === 'overseer-grok-merge-disposition-v1' &&
    receipt.woId === evidence.record.woId &&
    receipt.prNumber === evidence.pr_number &&
    receipt.headSha === evidence.head_sha &&
    receipt.baseSha === evidence.base_sha &&
    receipt.evidenceDigest === evidenceDigest &&
    receipt.operator.identity === evidence.operator.identity &&
    receipt.operator.provider === evidence.operator.provider &&
    receipt.operator.modelFamily === evidence.operator.model_family &&
    ((receipt.disposition === 'approve' && receipt.reason === 'judge_approve') ||
      (receipt.disposition === 'hold' && receipt.reason !== 'judge_approve'))
  );
}

export async function coordinateMergeReady(
  record: WatchedRunRecord,
  deps: MergeCoordinatorDeps
): Promise<MergeCoordinatorResult> {
  const assembled = await deps.assembleEvidence(record);
  const { evidence, evidenceDigest } = assembled;
  const assess = deps.assess ?? defaultAssessQualifiedMerge;
  const preflight = assess(evidence);
  const execute = deps.handleMergeReady ?? defaultHandleMergeReady;
  if (!preflight.eligible) {
    const execution = await execute(evidence, deps.executionDeps);
    return { status: 'gated', receipt: null, execution };
  }
  let disposition: GrokDispositionReceipt;
  try {
    disposition = await deps.judge({
      woId: record.woId,
      prNumber: evidence.pr_number,
      prTitle: evidence.record.prEvidence.prTitle ?? '',
      headSha: evidence.head_sha,
      baseSha: evidence.base_sha,
      evidenceDigest,
      operator: {
        identity: evidence.operator.identity,
        provider: evidence.operator.provider,
        modelFamily: evidence.operator.model_family,
      },
      checksSummary: evidence.record.prEvidence.checks,
      filesChangedCount:
        evidence.record.prEvidence.filesChangedCount ?? evidence.changed_files.length,
      diffStat: evidence.record.prEvidence.diffStat ?? '',
    });
  } catch {
    disposition = holdReceipt(evidence, evidenceDigest, 'judge_error');
  }
  if (!receiptMatches(disposition, evidence, evidenceDigest)) {
    disposition = holdReceipt(evidence, evidenceDigest, 'judge_output_invalid');
  }
  if (disposition.disposition !== 'approve') {
    await deps.insertOverseerAction({
      runId: record.runId,
      woId: record.woId,
      class: record.errorClass ?? 'tail_node_false_fail',
      action: 'merge_denied',
      result: disposition.reason,
    });
    return { status: 'held', receipt: disposition, execution: null };
  }
  const execution = await execute(evidence, deps.executionDeps);
  return { status: 'executed', receipt: disposition, execution };
}
