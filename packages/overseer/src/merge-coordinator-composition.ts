import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  appendM31ExecutionOutcomeV2,
  appendM31ExecutionReconciliationV2,
  getM31ActionProposalV2,
  reserveM31ExecutionEffectV2,
  type M31ActionProposalV2,
  type M31LiveObservationV2,
} from '@archon/core/db/m31-target-v2';
import { getDatabase } from '@archon/core/db/connection';
import {
  appendOverseerCapabilityEvent,
  getOverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import {
  insertOverseerAction,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from '@archon/core/db/overseer';
import { authorizeOverseerActionV2 } from './action-policy-v2';
import { readOverseerActionPolicyFromEnv } from './action-policy';
import {
  createFailClosedM31CapabilityGateV2,
  prepareM31ActionPermitV2,
  type M31LiveStateReaderV2,
} from './m31-target-v2';
import { createGitHubQualifiedMergeAdapter } from './adapters/github-qualified-merge';
import { createXaiGrokJudge } from './adapters/grok-xai-judge';
import {
  assembleQualifiedMergeEvidence,
  coordinateMergeReady,
  type MergeCoordinatorDeps,
  type MergeEvidenceAssemblyDeps,
} from './merge-coordinator';
import { loadOverseerActionPolicyRegistry, type OverseerDeploymentEffect } from './policy-registry';
import type {
  ExecuteQualifiedMergeDeps,
  FusionEvidence,
  IndependentReviewEvidence,
} from './actions/merge-ready';
import type {
  GitHubClientDeps,
  MergeOperatorIdentity,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types.ts';
import type { MergeReadyCoordinator, OverseerServiceOptions } from './service';

interface GitHubPull {
  readonly number: number;
  readonly state: string;
  readonly title: string;
  readonly html_url: string;
  readonly mergeable: boolean | null;
  readonly updated_at?: string | null;
  readonly head: { readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
}

interface OctokitLike {
  readonly pulls: {
    get(input: { owner: string; repo: string; pull_number: number }): Promise<{ data: GitHubPull }>;
    list(input: {
      owner: string;
      repo: string;
      head: string;
      state: 'open';
      per_page: number;
    }): Promise<{ data: readonly GitHubPull[] }>;
    listFiles(input: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: readonly { filename: string; additions: number; deletions: number }[] }>;
    listReviews(input: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: readonly { state?: string | null }[] }>;
    merge(input: {
      owner: string;
      repo: string;
      pull_number: number;
      sha?: string;
      commit_title?: string;
    }): Promise<{ data: { merged: boolean; sha?: string | null; message?: string } }>;
  };
  readonly checks: {
    listForRef(input: { owner: string; repo: string; ref: string }): Promise<{
      data: {
        total_count: number;
        check_runs: readonly {
          name: string;
          status: string;
          conclusion?: string | null;
          head_sha: string;
        }[];
      };
    }>;
  };
}

type PolicyReadResult = Awaited<ReturnType<MergeEvidenceAssemblyDeps['readPolicy']>>;
type M31ProposalReadResult = Awaited<ReturnType<MergeEvidenceAssemblyDeps['readM31Proposal']>>;

export interface MergeCoordinatorCompositionOptions {
  readonly githubToken: string;
  readonly xaiApiKey: string;
  readonly policyRegistryPath?: string;
  readonly credentialPrincipal?: string;
  readonly operator?: MergeOperatorIdentity;
  readonly octokit?: OctokitLike;
  readonly xaiFetch?: typeof fetch;
  readonly xaiTimeoutMs?: number;
  readonly xaiModel?: string;
}

export interface MergeCoordinatorComposition {
  readonly deps: NonNullable<OverseerServiceOptions['deps']>;
  readonly mergeCoordinator: MergeReadyCoordinator;
  readonly mergeCoordinatorDeps: MergeCoordinatorDeps;
}

const DEFAULT_POLICY_REGISTRY_PATH = '.archon/policies/overseer-action-policy.json';
const DEFAULT_OPERATOR: MergeOperatorIdentity = {
  identity: 'overseer-merge-coordinator',
  provider: 'xai',
  modelFamily: 'grok',
};

function envTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

export function isMergeCoordinatorEnabledFromEnv(): boolean {
  return envTrue(process.env.OVERSEER_MERGE_COORDINATOR_ENABLED);
}

export function createMergeCoordinatorComposition(
  options: MergeCoordinatorCompositionOptions
): MergeCoordinatorComposition {
  if (!options.githubToken.trim()) throw new Error('merge_coordinator_github_token_missing');
  if (!options.xaiApiKey.trim()) throw new Error('merge_coordinator_xai_api_key_missing');

  const octokit = options.octokit ?? createFetchGitHubClient(options.githubToken);
  const operator = options.operator ?? DEFAULT_OPERATOR;
  const credentialPrincipal =
    options.credentialPrincipal ??
    process.env.OVERSEER_MERGE_CREDENTIAL_PRINCIPAL ??
    operator.identity;
  const policyRegistryPath = options.policyRegistryPath ?? DEFAULT_POLICY_REGISTRY_PATH;
  const githubDeps = createGitHubClientDeps(octokit);
  const storeAndActions = {
    listRunsForWatch: listRunsForOverseerWatch,
    listRunEvents: listRunEventsForOverseer,
    insertOverseerAction: async (record: {
      runId: string;
      woId: string;
      class: string;
      action: string;
      result: string;
    }): Promise<void> => {
      await insertOverseerAction(record);
    },
  };
  const mergeAdapter = createGitHubQualifiedMergeAdapter({
    pulls: {
      merge: input => octokit.pulls.merge(input),
    },
  });
  const executionDeps: ExecuteQualifiedMergeDeps = {
    ...storeAndActions,
    preparePermit: proposalId =>
      prepareM31ActionPermitV2(
        { proposal_id: proposalId },
        {
          liveStateReader: createGitHubLiveStateReader(octokit),
          capabilityGate: createFailClosedM31CapabilityGateV2(),
        }
      ),
    authorize: permit =>
      authorizeOverseerActionV2(
        {
          requested_capability: 'merge',
          permit,
          actor: operator.identity,
          correlation_id: permit.execution_id,
        },
        {
          getPolicy: async () => readOverseerActionPolicyFromEnv(),
          getCapabilityState: getOverseerCapabilityState,
          getProposal: getM31ActionProposalV2,
          getCurrentTime: getDatabaseCurrentTime,
          recordDecision: async input => {
            await appendOverseerCapabilityEvent({
              capability: input.decision.capability,
              event_type: input.decision.allowed ? 'gate_allowed' : 'gate_denied',
              reason: input.decision.reason,
              actor: input.actor,
              correlation_id: input.correlation_id,
              proposal_id: input.permit.proposal_id,
              execution_id: input.permit.execution_id,
              policy_digest: policyDigestFromDecision(input.decision),
              verifier_registry_digest: verifierDigestFromDecision(input.decision),
              details: {
                repository: input.permit.repository,
                target_kind: input.permit.target.target_kind,
                action_kind: input.permit.action_kind,
              },
            });
          },
        }
      ),
    reserveEffect: permit =>
      reserveM31ExecutionEffectV2({
        permit,
        adapter_name: 'github-qualified-merge',
        provider_operation: 'pulls.merge',
        reason: 'qualified_merge_reserved',
        evidence: { actor: operator.identity },
      }),
    mergeAdapter,
    recordOutcome: appendM31ExecutionOutcomeV2,
    reconcile: async input => {
      const result = await appendM31ExecutionReconciliationV2(input);
      if (!result.ok) throw new Error(`merge_reconciliation_failed:${result.failure}`);
    },
    insertOverseerAction: storeAndActions.insertOverseerAction,
  };
  const evidenceDeps = createEvidenceAssemblyDeps({
    octokit,
    operator,
    credentialPrincipal,
    policyRegistryPath,
  });
  const mergeCoordinatorDeps: MergeCoordinatorDeps = {
    assembleEvidence: record => assembleQualifiedMergeEvidence(record, evidenceDeps),
    judge: createXaiGrokJudge({
      apiKey: options.xaiApiKey,
      fetch: options.xaiFetch,
      timeoutMs: options.xaiTimeoutMs,
      model: options.xaiModel,
    }).judge,
    executionDeps,
    insertOverseerAction: record => executionDeps.insertOverseerAction(record),
  };

  return {
    deps: { ...storeAndActions, ...githubDeps },
    mergeCoordinator: record => coordinateMergeReady(record, mergeCoordinatorDeps),
    mergeCoordinatorDeps,
  };
}

function createEvidenceAssemblyDeps(input: {
  readonly octokit: OctokitLike;
  readonly operator: MergeOperatorIdentity;
  readonly credentialPrincipal: string;
  readonly policyRegistryPath: string;
}): MergeEvidenceAssemblyDeps {
  return {
    operator: input.operator,
    readPolicy: async (record): Promise<PolicyReadResult> => {
      const text = await readFile(resolve(input.policyRegistryPath), 'utf8');
      const effect = metadataString(record.metadata, [
        'resultingDeploymentEffect',
        'resulting_deployment_effect',
        'deploymentEffect',
      ]);
      return {
        registry: loadOverseerActionPolicyRegistry({ text }),
        credentialPrincipal: input.credentialPrincipal,
        resultingDeploymentEffect: asDeploymentEffect(effect),
      };
    },
    readPullRequest: async record => readPullRequestEvidence(input.octokit, record),
    readIndependentReview: async record => readIndependentReview(record),
    readManifestV2: async record => readManifestV2(record),
    readM31Proposal: async (record): Promise<M31ProposalReadResult> => {
      const proposalId = metadataString(record.metadata, [
        'proposalId',
        'proposal_id',
        'm31ProposalId',
      ]);
      if (!proposalId) {
        return { proposalId: null, present: false, verifierRegistryDigest: '0'.repeat(64) };
      }
      const proposal = await getM31ActionProposalV2(proposalId);
      return {
        proposalId,
        present: proposal !== null,
        verifierRegistryDigest: proposal?.verifier_registry_digest ?? '0'.repeat(64),
      };
    },
    readFusionEvidence: async record => readFusionEvidence(record),
    compareFinalState: async record => compareFinalState(input.octokit, record),
  };
}

function createGitHubClientDeps(octokit: OctokitLike): GitHubClientDeps {
  return {
    async findPullRequest(input): Promise<PullRequestEvidence> {
      if (!input.headBranch) {
        return missingPullRequestEvidence();
      }
      const record = {
        owner: input.owner,
        repo: input.repo,
        headBranch: input.headBranch,
        woId: input.woId ?? '',
        prEvidence: missingPullRequestEvidence(),
      } as WatchedRunRecord;
      try {
        const evidence = await readPullRequestEvidence(octokit, record);
        return evidence.prEvidence;
      } catch {
        return missingPullRequestEvidence();
      }
    },
    async mergePullRequest(input): Promise<{ merged: boolean; message?: string }> {
      const response = await octokit.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        commit_title: input.commitTitle,
      });
      return { merged: response.data.merged, message: response.data.message };
    },
  };
}

function createFetchGitHubClient(token: string): OctokitLike {
  const request = async (
    path: string,
    init: RequestInit = {},
    query?: Record<string, string | number>
  ): Promise<{ data: unknown }> => {
    const url = new URL(`https://api.github.com${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-GitHub-Api-Version', '2022-11-28');
    const response = await fetch(url, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const error = new Error(`github_request_failed:${response.status}`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    return { data: await response.json() };
  };

  return {
    pulls: {
      get: async input =>
        (await request(`/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}`)) as {
          data: GitHubPull;
        },
      list: input =>
        request(
          `/repos/${input.owner}/${input.repo}/pulls`,
          {},
          {
            head: input.head,
            state: input.state,
            per_page: input.per_page,
          }
        ) as Promise<{ data: readonly GitHubPull[] }>,
      listFiles: input =>
        request(`/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/files`) as Promise<{
          data: readonly { filename: string; additions: number; deletions: number }[];
        }>,
      listReviews: input =>
        request(
          `/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/reviews`
        ) as Promise<{ data: readonly { state?: string | null }[] }>,
      merge: input =>
        request(`/repos/${input.owner}/${input.repo}/pulls/${input.pull_number}/merge`, {
          method: 'PUT',
          body: JSON.stringify({
            sha: input.sha,
            commit_title: input.commit_title,
          }),
          headers: { 'Content-Type': 'application/json' },
        }) as Promise<{ data: { merged: boolean; sha?: string | null; message?: string } }>,
    },
    checks: {
      listForRef: input =>
        request(`/repos/${input.owner}/${input.repo}/commits/${input.ref}/check-runs`) as Promise<{
          data: {
            total_count: number;
            check_runs: readonly {
              name: string;
              status: string;
              conclusion?: string | null;
              head_sha: string;
            }[];
          };
        }>,
    },
  };
}

function createGitHubLiveStateReader(octokit: OctokitLike): M31LiveStateReaderV2 {
  return {
    async readBoundState(proposal: M31ActionProposalV2): Promise<M31LiveObservationV2> {
      if (proposal.target.target_kind !== 'pull_request') {
        return {
          known: false,
          target: proposal.target,
          policy_digest: proposal.policy_digest,
          verifier_registry_digest: proposal.verifier_registry_digest,
          observed_at: new Date().toISOString(),
        };
      }
      const target = proposal.target;
      try {
        const [owner, repo] = proposal.repository.split('/');
        if (!owner || !repo) throw new Error('repository_invalid');
        const response = await octokit.pulls.get({
          owner,
          repo,
          pull_number: target.pr_number,
        });
        return {
          known: true,
          target: {
            ...target,
            head_sha: response.data.head.sha,
            base_branch: response.data.base.ref,
            base_sha: response.data.base.sha,
            state: response.data.state,
            updated_at: response.data.updated_at ?? new Date().toISOString(),
          },
          policy_digest: proposal.policy_digest,
          verifier_registry_digest: proposal.verifier_registry_digest,
          observed_at: new Date().toISOString(),
        };
      } catch {
        return {
          known: false,
          target,
          policy_digest: proposal.policy_digest,
          verifier_registry_digest: proposal.verifier_registry_digest,
          observed_at: new Date().toISOString(),
        };
      }
    },
  };
}

async function readPullRequestEvidence(
  octokit: OctokitLike,
  record: WatchedRunRecord
): Promise<{
  readonly owner: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly changedFiles: readonly string[];
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly prEvidence: PullRequestEvidence;
  readonly requiredChecks: readonly {
    readonly name: string;
    readonly conclusion: string;
    readonly head_sha: string;
  }[];
  readonly reviews: readonly { readonly resolved: boolean }[];
}> {
  const found = await resolvePullRequest(octokit, record);
  const [files, checks, reviews] = await Promise.all([
    octokit.pulls.listFiles({ owner: record.owner, repo: record.repo, pull_number: found.number }),
    octokit.checks.listForRef({ owner: record.owner, repo: record.repo, ref: found.head.sha }),
    octokit.pulls.listReviews({
      owner: record.owner,
      repo: record.repo,
      pull_number: found.number,
    }),
  ]);
  const failed = checks.data.check_runs.filter(check =>
    ['failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion ?? '')
  ).length;
  const pending = checks.data.check_runs.filter(check => check.status !== 'completed').length;
  const passed = checks.data.check_runs.filter(check =>
    ['success', 'neutral', 'skipped'].includes(check.conclusion ?? '')
  ).length;
  return {
    owner: record.owner,
    repository: record.repo,
    baseBranch: found.base.ref,
    changedFiles: files.data.map(file => file.filename),
    prNumber: found.number,
    headSha: found.head.sha,
    baseSha: found.base.sha,
    prEvidence: {
      exists: true,
      state: found.state,
      checks: { total: checks.data.total_count, passed, failed, pending },
      mergeable: found.mergeable,
      pr: { owner: record.owner, repo: record.repo, number: found.number },
      prTitle: found.title,
      filesChangedCount: files.data.length,
      diffStat: `+${sum(files.data.map(file => file.additions))} -${sum(files.data.map(file => file.deletions))}`,
      htmlUrl: found.html_url,
    },
    requiredChecks: checks.data.check_runs.map(check => ({
      name: check.name,
      conclusion: check.conclusion ?? check.status,
      head_sha: check.head_sha,
    })),
    reviews: reviews.data.map(review => ({
      resolved: !['CHANGES_REQUESTED', 'COMMENTED'].includes(review.state ?? ''),
    })),
  };
}

async function resolvePullRequest(
  octokit: OctokitLike,
  record: WatchedRunRecord
): Promise<GitHubPull> {
  const number = record.prEvidence.pr?.number;
  if (number !== undefined) {
    return (
      await octokit.pulls.get({ owner: record.owner, repo: record.repo, pull_number: number })
    ).data;
  }
  if (!record.headBranch) throw new Error('merge_coordinator_pr_number_missing');
  const pulls = await octokit.pulls.list({
    owner: record.owner,
    repo: record.repo,
    head: `${record.owner}:${record.headBranch}`,
    state: 'open',
    per_page: 2,
  });
  const pull = pulls.data[0];
  if (!pull || pulls.data.length !== 1) throw new Error('merge_coordinator_pr_unresolved');
  return pull;
}

async function readManifestV2(
  record: WatchedRunRecord
): Promise<{ readonly valid: boolean } | null> {
  const manifest = metadataRecord(record.metadata, [
    'manifestV2',
    'manifest_v2',
    'overseerParentManifest',
  ]);
  if (!manifest) return null;
  if (typeof manifest.valid === 'boolean') return { valid: manifest.valid };
  return { valid: manifest.status === 'READY_FOR_SANDBOX_PROOF_REQUEST' };
}

async function readIndependentReview(
  record: WatchedRunRecord
): Promise<IndependentReviewEvidence | null> {
  const review = metadataRecord(record.metadata, ['independentReview', 'independent_review']);
  if (!review) return null;
  const reviewedHead = stringValue(review.reviewed_head_sha) ?? stringValue(review.candidate_sha);
  const reviewer = metadataRecord(review, ['reviewer']);
  const builder = metadataRecord(review, ['builder']);
  if (!reviewedHead || !reviewer || !builder) return null;
  return {
    present: review.present !== false,
    reviewed_head_sha: reviewedHead,
    reviewer_identity: stringValue(reviewer.identity) ?? stringValue(reviewer.model) ?? '',
    builder_identity: stringValue(builder.identity) ?? stringValue(builder.model) ?? '',
    reviewer_provider: stringValue(reviewer.provider) ?? '',
    builder_provider: stringValue(builder.provider) ?? '',
    reviewer_model_family: stringValue(reviewer.model_family) ?? stringValue(reviewer.model) ?? '',
    builder_model_family: stringValue(builder.model_family) ?? stringValue(builder.model) ?? '',
  };
}

async function readFusionEvidence(record: WatchedRunRecord): Promise<FusionEvidence | null> {
  const fusion = metadataRecord(record.metadata, ['fusion', 'fusionEvidence', 'fusion_evidence']);
  if (!fusion) return null;
  const receiptDigest = stringValue(fusion.receipt_digest);
  const evidenceDigest = stringValue(fusion.evidence_digest);
  if (!receiptDigest || !evidenceDigest) return null;
  return {
    present: fusion.present !== false,
    components: arrayOfStrings(fusion.components),
    raw_dissent_recorded: fusion.raw_dissent_recorded === true,
    cost_recorded: fusion.cost_recorded === true,
    verifier_correlated: fusion.verifier_correlated === true,
    hidden_model_substitution: fusion.hidden_model_substitution === true,
    receipt_digest: receiptDigest,
    evidence_digest: evidenceDigest,
  };
}

async function compareFinalState(octokit: OctokitLike, record: WatchedRunRecord): Promise<boolean> {
  const proposalId = metadataString(record.metadata, [
    'proposalId',
    'proposal_id',
    'm31ProposalId',
  ]);
  if (!proposalId) return false;
  const proposal = await getM31ActionProposalV2(proposalId);
  if (proposal?.target.target_kind !== 'pull_request') return false;
  const target = proposal.target;
  const [owner, repo] = proposal.repository.split('/');
  if (!owner || !repo) return false;
  const pull = await octokit.pulls.get({ owner, repo, pull_number: target.pr_number });
  return (
    pull.data.head.sha === target.head_sha &&
    pull.data.base.sha === target.base_sha &&
    pull.data.base.ref === target.base_branch &&
    pull.data.state === target.state
  );
}

async function getDatabaseCurrentTime(): Promise<string> {
  const db = getDatabase();
  const sql =
    db.dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const result = await db.query<{ now: string }>(sql);
  const now = result.rows[0]?.now;
  if (!now) throw new Error('merge_coordinator_database_clock_unavailable');
  return now;
}

function policyDigestFromDecision(decision: {
  readonly allowed: boolean;
  readonly policy_digest?: string;
}): string {
  return decision.allowed && decision.policy_digest ? decision.policy_digest : '0'.repeat(64);
}

function verifierDigestFromDecision(decision: {
  readonly allowed: boolean;
  readonly verifier_registry_digest?: string;
}): string {
  return decision.allowed && decision.verifier_registry_digest
    ? decision.verifier_registry_digest
    : '0'.repeat(64);
}

function asDeploymentEffect(value: string | undefined): OverseerDeploymentEffect {
  if (value === 'none' || value === 'staging' || value === 'production' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  const value = metadataValue(metadata, keys);
  return stringValue(value);
}

function metadataRecord(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> | null {
  const value = metadataValue(metadata, keys);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function metadataValue(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[]
): unknown {
  if (!metadata) return undefined;
  for (const key of keys) {
    if (metadata[key] !== undefined) return metadata[key];
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function missingPullRequestEvidence(): PullRequestEvidence {
  return {
    exists: false,
    state: 'missing',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    mergeable: null,
  };
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
