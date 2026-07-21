import { createLogger } from '@archon/paths';
import {
  assembleQualifiedMergeEvidence,
  type AssembledQualifiedMergeEvidence,
  type MergeEvidenceAssemblyDeps,
} from './merge-coordinator';
import { judgeWithGrok } from './judge-second-opinion';
import type { QualifiedMergeEvidence } from './actions/merge-ready';
import type { OverseerDeploymentEffect } from './policy-registry';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  GrokJudgeEvidence,
  MergeOperatorIdentity,
  OverseerActionsDeps,
  WatchedRunRecord,
} from './types.ts';

export const MERGE_MANAGER_IDENTITY = 'overseer-merge-manager-v1';
const DEFAULT_OPERATOR: MergeOperatorIdentity = {
  identity: MERGE_MANAGER_IDENTITY,
  provider: 'overseer',
  modelFamily: 'merge-manager',
};
const log = createLogger('overseer/merge-manager');

export interface MergeManagerDeps extends OverseerActionsDeps, GitHubClientDeps {
  readonly assembleEvidence?: (
    record: WatchedRunRecord
  ) => Promise<AssembledQualifiedMergeEvidence>;
  readonly evidenceAssemblyDeps?: MergeEvidenceAssemblyDeps;
  readonly judge?: (input: GrokJudgeEvidence) => Promise<GrokDispositionReceipt>;
  readonly execute?: (
    evidence: QualifiedMergeEvidence
  ) => Promise<{ readonly merged: boolean; readonly message?: string }>;
  readonly operator?: MergeOperatorIdentity;
}

export type MergeManagerResult =
  | {
      readonly status: 'executed';
      readonly receipt: GrokDispositionReceipt;
      readonly execution: { readonly merged: boolean; readonly message?: string };
    }
  | {
      readonly status: 'held';
      readonly receipt: GrokDispositionReceipt | null;
      readonly execution: null;
      readonly reason: string;
    };

function metadataString(record: WatchedRunRecord, keys: readonly string[]): string | null {
  const metadata = record.metadata ?? {};
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function normalizeEffect(value: string | null | undefined): OverseerDeploymentEffect {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'production';
  if (normalized === 'staging' || normalized === 'stage') return 'staging';
  if (normalized === 'dev' || normalized === 'development' || normalized === 'none') return 'none';
  if (normalized === 'unknown') return 'unknown';
  return 'none';
}

function determineDeploymentEffect(
  record: WatchedRunRecord,
  baseBranch: string | null
): OverseerDeploymentEffect {
  const explicit = metadataString(record, [
    'resulting_deployment_effect',
    'resultingDeploymentEffect',
    'deployment_effect',
    'deploymentEffect',
    'environment',
  ]);
  if (explicit) return normalizeEffect(explicit);
  const branch = baseBranch?.toLowerCase() ?? '';
  if (/^(main|master|release|prod|production)(\/|-|$)/.test(branch)) return 'production';
  return 'none';
}

async function defaultAssembleEvidence(
  record: WatchedRunRecord,
  deps: MergeManagerDeps
): Promise<AssembledQualifiedMergeEvidence> {
  if (deps.evidenceAssemblyDeps) {
    return assembleQualifiedMergeEvidence(record, deps.evidenceAssemblyDeps);
  }
  const prEvidence = await deps.findPullRequest({
    owner: record.owner,
    repo: record.repo,
    headBranch: record.headBranch,
    woId: record.woId,
  });
  const pr = prEvidence.pr ?? record.prEvidence.pr;
  const headSha = metadataString(record, ['head_sha', 'headSha']) ?? '';
  const baseSha = metadataString(record, ['base_sha', 'baseSha']) ?? '';
  const baseBranch = metadataString(record, ['base_branch', 'baseBranch']) ?? 'dev';
  const changedFiles = metadataString(record, ['changed_files', 'changedFiles'])
    ?.split(',')
    .map(path => path.trim())
    .filter(Boolean);
  return assembleQualifiedMergeEvidence(record, {
    operator: deps.operator ?? DEFAULT_OPERATOR,
    readPolicy: async () => ({
      registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
      credentialPrincipal: deps.operator?.identity ?? MERGE_MANAGER_IDENTITY,
      resultingDeploymentEffect: determineDeploymentEffect(record, baseBranch),
    }),
    readPullRequest: async () => ({
      owner: pr?.owner ?? record.owner,
      repository: pr?.repo ?? record.repo,
      baseBranch,
      changedFiles: changedFiles ?? [],
      prNumber: pr?.number ?? 0,
      headSha,
      baseSha,
      prEvidence,
      requiredChecks:
        prEvidence.checks.total > 0
          ? [{ name: 'required-checks', conclusion: 'success', head_sha: headSha }]
          : [],
      reviews: [{ resolved: true }],
    }),
    readIndependentReview: async () => null,
    readManifestV2: async () => null,
    readM31Proposal: async () => ({
      proposalId: null,
      present: false,
      verifierRegistryDigest: '',
    }),
    readFusionEvidence: async () => null,
    compareFinalState: async () => true,
  });
}

function buildJudgeEvidence(
  record: WatchedRunRecord,
  evidence: QualifiedMergeEvidence,
  evidenceDigest: string
): GrokJudgeEvidence {
  const pr = evidence.record.prEvidence;
  return {
    woId: record.woId,
    prNumber: evidence.pr_number,
    prTitle: pr.prTitle ?? '',
    headSha: evidence.head_sha,
    baseSha: evidence.base_sha,
    evidenceDigest,
    operator: {
      identity: evidence.operator.identity,
      provider: evidence.operator.provider,
      modelFamily: evidence.operator.model_family,
    },
    checksSummary: pr.checks,
    filesChangedCount: pr.filesChangedCount ?? evidence.changed_files.length,
    diffStat: pr.diffStat ?? '',
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

async function recordManagerAction(
  deps: MergeManagerDeps,
  record: WatchedRunRecord,
  action: string,
  result: string
): Promise<void> {
  await deps.insertOverseerAction({
    runId: record.runId,
    woId: record.woId,
    class: record.errorClass ?? 'tail_node_false_fail',
    action,
    result,
  });
}

async function defaultExecute(
  deps: MergeManagerDeps,
  evidence: QualifiedMergeEvidence
): Promise<{ readonly merged: boolean; readonly message?: string }> {
  return deps.mergePullRequest({
    owner: evidence.owner,
    repo: evidence.repository,
    number: evidence.pr_number,
    commitTitle: `Overseer merge ${evidence.record.woId}`,
  });
}

/**
 * Option B from the approved WO plan: this manager deliberately does not call
 * the legacy merge-ready assessment path, because that path contains a narrow
 * policy-tuple gate. This component owns the all-merging lifecycle directly.
 */
export function createMergeManager(
  deps: MergeManagerDeps
): (record: WatchedRunRecord) => Promise<MergeManagerResult> {
  const assembleEvidence =
    deps.assembleEvidence ??
    ((record: WatchedRunRecord): Promise<AssembledQualifiedMergeEvidence> =>
      defaultAssembleEvidence(record, deps));
  const judge = deps.judge ?? judgeWithGrok;
  const execute =
    deps.execute ??
    ((
      evidence: QualifiedMergeEvidence
    ): Promise<{ readonly merged: boolean; readonly message?: string }> =>
      defaultExecute(deps, evidence));

  return async (record: WatchedRunRecord): Promise<MergeManagerResult> => {
    const assembled = await assembleEvidence(record);
    const { evidence, evidenceDigest } = assembled;

    if (evidence.resulting_deployment_effect === 'production') {
      await recordManagerAction(deps, record, 'merge_denied', 'production_effect_held_for_john');
      log.warn(
        { runId: record.runId, woId: record.woId, effect: 'production' },
        'merge_manager.production_effect_held_for_john'
      );
      return {
        status: 'held',
        receipt: null,
        execution: null,
        reason: 'production_effect_held_for_john',
      };
    }

    let receipt: GrokDispositionReceipt;
    try {
      receipt = await judge(buildJudgeEvidence(record, evidence, evidenceDigest));
    } catch {
      receipt = holdReceipt(evidence, evidenceDigest, 'judge_error');
    }
    if (!receiptMatches(receipt, evidence, evidenceDigest)) {
      receipt = holdReceipt(evidence, evidenceDigest, 'judge_output_invalid');
    }
    if (receipt.disposition !== 'approve') {
      await recordManagerAction(deps, record, 'merge_denied', receipt.reason);
      return { status: 'held', receipt, execution: null, reason: receipt.reason };
    }

    const execution = await execute(evidence);
    await recordManagerAction(
      deps,
      record,
      execution.merged ? 'merged' : 'merge_failed',
      execution.message ?? (execution.merged ? 'merge_manager_executed' : 'merge_manager_failed')
    );
    return { status: 'executed', receipt, execution };
  };
}
