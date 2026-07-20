import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendM31ExecutionOutcomeV2,
  appendM31ExecutionReconciliationV2,
  getM31ActionProposalV2,
  reserveM31ExecutionEffectV2,
  type M31PullRequestTargetV2,
  type M31ActionProposalV2,
} from '@archon/core/db/m31-target-v2';
import { getDatabase } from '@archon/core/db/connection';
import {
  appendOverseerCapabilityEvent,
  getOverseerCapabilityState,
} from '@archon/core/db/overseer-capabilities';
import { insertOverseerAction } from '@archon/core/db/overseer';
import { authorizeOverseerActionV2 } from './action-policy-v2';
import {
  createFailClosedM31CapabilityGateV2,
  prepareM31ActionPermitV2,
  type M31LiveStateReaderV2,
} from './m31-target-v2';
import {
  assembleQualifiedMergeEvidence,
  coordinateMergeReady,
  type MergeCoordinatorDeps,
  type MergeEvidenceAssemblyDeps,
} from './merge-coordinator';
import { readOverseerActionPolicyFromEnv } from './action-policy';
import { createGitHubQualifiedMergeAdapter } from './adapters/github-qualified-merge';
import { loadOverseerActionPolicyRegistry } from './policy-registry';
import { createXaiGrokMergeJudge } from './overseer-grok-judge';
import type {
  ExecuteQualifiedMergeDeps,
  FusionEvidence,
  IndependentReviewEvidence,
  RequiredCheckEvidence,
} from './actions/merge-ready';
import type {
  GitHubClientDeps,
  OverseerActionsDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  OverseerWorkflowEvent,
  PullRequestEvidence,
  WatchedRunRecord,
} from './types';
import type { MergeReadyCoordinator } from './service';

export interface MergeCoordinatorCompositionOptions {
  readonly token?: string;
  readonly policyRegistryPath?: string;
  readonly credentialPrincipal?: string;
  readonly operatorIdentity?: string;
  readonly operatorProvider?: string;
  readonly operatorModelFamily?: string;
  readonly octokit?: unknown;
  readonly judge?: MergeCoordinatorDeps['judge'];
  readonly readPolicy?: MergeEvidenceAssemblyDeps['readPolicy'];
  readonly readIndependentReview?: MergeEvidenceAssemblyDeps['readIndependentReview'];
  readonly readManifestV2?: MergeEvidenceAssemblyDeps['readManifestV2'];
  readonly readM31Proposal?: MergeEvidenceAssemblyDeps['readM31Proposal'];
  readonly readFusionEvidence?: MergeEvidenceAssemblyDeps['readFusionEvidence'];
  readonly compareFinalState?: MergeEvidenceAssemblyDeps['compareFinalState'];
  readonly liveStateReader?: M31LiveStateReaderV2;
}

export interface MergeCoordinatorRuntimeDeps {
  readonly deps: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps;
  readonly mergeCoordinator: MergeReadyCoordinator;
}

interface OctokitLike {
  readonly pulls: {
    get(input: {
      owner: string;
      repo: string;
      pull_number: number;
    }): Promise<{ data: Record<string, unknown> }>;
    listFiles(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
    }): Promise<{ data: readonly Record<string, unknown>[] }>;
    listReviews(input: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page?: number;
    }): Promise<{ data: readonly Record<string, unknown>[] }>;
    merge(input: {
      owner: string;
      repo: string;
      pull_number: number;
      sha: string;
    }): Promise<{ data: { merged: boolean; sha?: string | null } }>;
  };
  readonly checks: {
    listForRef(input: {
      owner: string;
      repo: string;
      ref: string;
      per_page?: number;
    }): Promise<{ data: { check_runs?: readonly Record<string, unknown>[] } }>;
  };
  readonly repos: {
    compareCommitsWithBasehead(input: { owner: string; repo: string; basehead: string }): Promise<{
      data: { files?: readonly { filename?: string; additions?: number; deletions?: number }[] };
    }>;
  };
  readonly paginate?: <T>(method: unknown, input: Record<string, unknown>) => Promise<T[]>;
}

type PullRequestReadResult = Awaited<ReturnType<MergeEvidenceAssemblyDeps['readPullRequest']>>;

const EMPTY_REGISTRY = '{"schema_version":"overseer-action-policy-v1","entries":[]}';
const DEFAULT_POLICY_REGISTRY_PATH = join(
  process.cwd(),
  '.archon',
  'policies',
  'overseer-action-policy.json'
);

export async function createRealMergeCoordinatorDeps(
  options: MergeCoordinatorCompositionOptions = {}
): Promise<MergeCoordinatorDeps> {
  const client = await resolveOctokit(options);
  const operator = {
    identity: options.operatorIdentity ?? 'grok-overseer',
    provider: options.operatorProvider ?? 'xai',
    modelFamily: options.operatorModelFamily ?? 'grok',
  };
  const evidenceDeps: MergeEvidenceAssemblyDeps = {
    operator,
    readPolicy:
      options.readPolicy ??
      ((record: WatchedRunRecord): ReturnType<MergeEvidenceAssemblyDeps['readPolicy']> =>
        readPolicyFromDisk(record, {
          path: options.policyRegistryPath,
          credentialPrincipal: options.credentialPrincipal,
        })),
    readPullRequest: record => readPullRequestFromGitHub(record, client),
    readIndependentReview: options.readIndependentReview ?? readIndependentReviewFromMetadata,
    readManifestV2: options.readManifestV2 ?? readManifestV2FromMetadata,
    readM31Proposal: options.readM31Proposal ?? readM31ProposalFromMetadata,
    readFusionEvidence: options.readFusionEvidence ?? readFusionEvidenceFromMetadata,
    compareFinalState:
      options.compareFinalState ??
      ((record: WatchedRunRecord): Promise<boolean> => compareFinalStateFromGitHub(record, client)),
  };
  const liveStateReader = options.liveStateReader ?? createGitHubPullRequestLiveStateReader(client);
  const executionDeps: ExecuteQualifiedMergeDeps = {
    insertOverseerAction: insertAction,
    preparePermit: proposalId =>
      prepareM31ActionPermitV2(
        { proposal_id: proposalId },
        { liveStateReader, capabilityGate: createFailClosedM31CapabilityGateV2() }
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
          getCurrentTime: readDatabaseCurrentTime,
          recordDecision: async input => {
            const proposal = await getM31ActionProposalV2(input.permit.proposal_id);
            await appendOverseerCapabilityEvent({
              capability: input.decision.capability,
              event_type: input.decision.allowed ? 'gate_allowed' : 'gate_denied',
              reason: input.decision.reason,
              actor: input.actor,
              correlation_id: input.correlation_id,
              proposal_id: proposal?.proposal_id ?? null,
              execution_id: input.permit.execution_id,
              policy_digest: proposal?.policy_digest ?? '0'.repeat(64),
              verifier_registry_digest: proposal?.verifier_registry_digest ?? '0'.repeat(64),
              details: { action_kind: input.permit.action_kind },
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
        evidence: { proposal_id: permit.proposal_id },
      }),
    mergeAdapter: createGitHubQualifiedMergeAdapter(client),
    recordOutcome: appendM31ExecutionOutcomeV2,
    reconcile: async input => {
      await appendM31ExecutionReconciliationV2(input);
    },
  };
  return {
    assembleEvidence: record => assembleQualifiedMergeEvidence(record, evidenceDeps),
    judge: options.judge ?? createXaiGrokMergeJudge(),
    executionDeps,
    insertOverseerAction: insertAction,
  };
}

export async function createMergeCoordinatorRuntimeDeps(
  options: MergeCoordinatorCompositionOptions = {}
): Promise<MergeCoordinatorRuntimeDeps> {
  const coordinatorDeps = await createRealMergeCoordinatorDeps(options);
  return {
    deps: {
      listRunsForWatch: async (): Promise<OverseerRunRecord[]> => {
        const { listRunsForOverseerWatch } = await import('@archon/core/db/overseer');
        return listRunsForOverseerWatch();
      },
      listRunEvents: async (runId: string): Promise<OverseerWorkflowEvent[]> => {
        const { listRunEventsForOverseer } = await import('@archon/core/db/overseer');
        return listRunEventsForOverseer(runId);
      },
      findPullRequest: async (input): Promise<PullRequestEvidence> => {
        const client = await resolveOctokit(options);
        const pr = await findPullRequestEvidence(client, input);
        return pr.prEvidence;
      },
      mergePullRequest: async () => ({
        merged: false,
        message: 'qualified_merge_adapter_required',
      }),
      insertOverseerAction: insertAction,
    },
    mergeCoordinator: record => coordinateMergeReady(record, coordinatorDeps),
  };
}

async function resolveOctokit(options: MergeCoordinatorCompositionOptions): Promise<OctokitLike> {
  if (options.octokit) return options.octokit as OctokitLike;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error('overseer_merge_coordinator_github_token_missing');
  const octokitModule = await import('@octokit/rest');
  return new octokitModule.Octokit({ auth: token }) as unknown as OctokitLike;
}

async function readPolicyFromDisk(
  _record: WatchedRunRecord,
  options: { readonly path?: string; readonly credentialPrincipal?: string }
): ReturnType<MergeEvidenceAssemblyDeps['readPolicy']> {
  let text = EMPTY_REGISTRY;
  try {
    text = await readFile(options.path ?? DEFAULT_POLICY_REGISTRY_PATH, 'utf8');
  } catch {
    text = EMPTY_REGISTRY;
  }
  return {
    registry: loadOverseerActionPolicyRegistry({ text }),
    credentialPrincipal:
      options.credentialPrincipal ??
      process.env.OVERSEER_MERGE_CREDENTIAL_PRINCIPAL ??
      'overseer-fake-merge-principal',
    resultingDeploymentEffect: 'none',
  };
}

async function insertAction(record: Parameters<typeof insertOverseerAction>[0]): Promise<void> {
  await insertOverseerAction(record);
}

async function readPullRequestFromGitHub(
  record: WatchedRunRecord,
  client: OctokitLike
): Promise<PullRequestReadResult> {
  const current = await findPullRequestEvidence(client, {
    owner: record.owner,
    repo: record.repo,
    headBranch: record.headBranch,
    woId: record.woId,
    prNumber: record.prEvidence.pr?.number,
  });
  if (!current.prEvidence.pr) throw new Error('pull_request_evidence_missing');
  return current;
}

async function findPullRequestEvidence(
  client: OctokitLike,
  input: { owner: string; repo: string; headBranch?: string; woId?: string; prNumber?: number }
): Promise<PullRequestReadResult> {
  const number = input.prNumber ?? prNumberFromBranchOrWo(input.headBranch, input.woId);
  if (!number) {
    return {
      owner: input.owner,
      repository: input.repo,
      baseBranch: '',
      changedFiles: [],
      prNumber: 0,
      headSha: '',
      baseSha: '',
      prEvidence: { exists: false, state: 'unknown', checks: zeroChecks(), mergeable: null },
      requiredChecks: [],
      reviews: [],
    };
  }
  const pr = await client.pulls.get({ owner: input.owner, repo: input.repo, pull_number: number });
  const files = await listPullRequestFiles(client, input.owner, input.repo, number);
  const liveReviews = await listPullRequestReviews(client, input.owner, input.repo, number);
  const head = object(pr.data.head);
  const base = object(pr.data.base);
  const headSha = stringValue(head?.sha);
  const baseSha = stringValue(base?.sha);
  const checks = headSha
    ? await client.checks.listForRef({
        owner: input.owner,
        repo: input.repo,
        ref: headSha,
        per_page: 100,
      })
    : { data: { check_runs: [] } };
  const requiredChecks = (checks.data.check_runs ?? []).map(check => ({
    name: stringValue(check.name) ?? 'unknown',
    conclusion: stringValue(check.conclusion) ?? stringValue(check.status) ?? 'unknown',
    head_sha: stringValue(check.head_sha) ?? headSha ?? '',
  }));
  const reviews = liveReviews.map(review => ({
    resolved: stringValue(review.state)?.toUpperCase() === 'APPROVED',
  }));
  const additions = files.reduce((sum, file) => sum + numberValue(file.additions), 0);
  const deletions = files.reduce((sum, file) => sum + numberValue(file.deletions), 0);
  const prEvidence: PullRequestEvidence = {
    exists: true,
    state: stringValue(pr.data.state) ?? 'unknown',
    checks: summarizeChecks(requiredChecks),
    mergeable: booleanOrNull(pr.data.mergeable),
    pr: { owner: input.owner, repo: input.repo, number },
    prTitle: stringValue(pr.data.title) ?? '',
    filesChangedCount: files.length,
    diffStat: `+${additions} -${deletions}`,
    htmlUrl: stringValue(pr.data.html_url),
  };
  return {
    owner: input.owner,
    repository: input.repo,
    baseBranch: stringValue(base?.ref) ?? '',
    changedFiles: files.map(file => stringValue(file.filename) ?? '').filter(Boolean),
    prNumber: number,
    headSha: headSha ?? '',
    baseSha: baseSha ?? '',
    prEvidence,
    requiredChecks,
    reviews,
  };
}

async function listPullRequestFiles(
  client: OctokitLike,
  owner: string,
  repo: string,
  pull_number: number
): Promise<readonly Record<string, unknown>[]> {
  if (client.paginate) {
    return client.paginate(client.pulls.listFiles.bind(client.pulls), {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });
  }
  return (await client.pulls.listFiles({ owner, repo, pull_number, per_page: 100 })).data;
}

async function listPullRequestReviews(
  client: OctokitLike,
  owner: string,
  repo: string,
  pull_number: number
): Promise<readonly Record<string, unknown>[]> {
  if (client.paginate) {
    return client.paginate(client.pulls.listReviews.bind(client.pulls), {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });
  }
  return (await client.pulls.listReviews({ owner, repo, pull_number, per_page: 100 })).data;
}

async function readM31ProposalFromMetadata(
  record: WatchedRunRecord
): ReturnType<MergeEvidenceAssemblyDeps['readM31Proposal']> {
  const proposalId =
    stringFromMetadata(record, 'm31_proposal_id') ?? stringFromMetadata(record, 'proposal_id');
  if (!proposalId) return { proposalId: null, present: false, verifierRegistryDigest: '' };
  const proposal = await getM31ActionProposalV2(proposalId);
  return {
    proposalId,
    present: proposal !== null,
    verifierRegistryDigest: proposal?.verifier_registry_digest ?? '',
  };
}

function readIndependentReviewFromMetadata(
  record: WatchedRunRecord
): Promise<IndependentReviewEvidence | null> {
  return Promise.resolve(
    recordFromMetadata(record, 'independent_review') as IndependentReviewEvidence | null
  );
}

function readManifestV2FromMetadata(
  record: WatchedRunRecord
): Promise<{ readonly valid: boolean } | null> {
  const manifest = recordFromMetadata(record, 'manifest_v2');
  return Promise.resolve(typeof manifest?.valid === 'boolean' ? { valid: manifest.valid } : null);
}

function readFusionEvidenceFromMetadata(record: WatchedRunRecord): Promise<FusionEvidence | null> {
  return Promise.resolve(recordFromMetadata(record, 'fusion') as FusionEvidence | null);
}

async function compareFinalStateFromGitHub(
  record: WatchedRunRecord,
  client: OctokitLike
): Promise<boolean> {
  const proposalId =
    stringFromMetadata(record, 'm31_proposal_id') ?? stringFromMetadata(record, 'proposal_id');
  if (!proposalId) return false;
  const proposal = await getM31ActionProposalV2(proposalId);
  if (proposal?.target.target_kind !== 'pull_request') return false;
  const live = await readPullRequestTarget(client, proposal);
  return JSON.stringify(live) === JSON.stringify(proposal.target);
}

function createGitHubPullRequestLiveStateReader(client: OctokitLike): M31LiveStateReaderV2 {
  return {
    async readBoundState(
      proposal: M31ActionProposalV2
    ): ReturnType<M31LiveStateReaderV2['readBoundState']> {
      if (proposal.target.target_kind !== 'pull_request') {
        return {
          known: false,
          target: proposal.target,
          policy_digest: proposal.policy_digest,
          verifier_registry_digest: proposal.verifier_registry_digest,
          observed_at: new Date().toISOString(),
        };
      }
      return {
        known: true,
        target: await readPullRequestTarget(client, proposal),
        policy_digest: proposal.policy_digest,
        verifier_registry_digest: proposal.verifier_registry_digest,
        observed_at: new Date().toISOString(),
      };
    },
  };
}

async function readPullRequestTarget(
  client: OctokitLike,
  proposal: M31ActionProposalV2
): Promise<M31PullRequestTargetV2> {
  const [owner, repo] = proposal.repository.split('/');
  const response = await client.pulls.get({
    owner,
    repo,
    pull_number: proposal.target.target_kind === 'pull_request' ? proposal.target.pr_number : 0,
  });
  const head = object(response.data.head);
  const base = object(response.data.base);
  return {
    target_kind: 'pull_request' as const,
    repository: proposal.repository,
    pr_number: proposal.target.target_kind === 'pull_request' ? proposal.target.pr_number : 0,
    provider_node_id: stringValue(response.data.node_id) ?? '',
    head_sha: stringValue(head?.sha) ?? '',
    base_branch: stringValue(base?.ref) ?? '',
    base_sha: stringValue(base?.sha) ?? '',
    state: stringValue(response.data.state) ?? '',
    updated_at: stringValue(response.data.updated_at) ?? '',
  };
}

async function readDatabaseCurrentTime(): Promise<string> {
  const db = getDatabase();
  const sql =
    db.dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
      : 'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now';
  const result = await db.query<{ now: string }>(sql);
  const now = result.rows[0]?.now;
  if (!now) throw new Error('overseer_merge_coordinator_database_clock_unavailable');
  return now;
}

function prNumberFromBranchOrWo(branch?: string, woId?: string): number | null {
  const fromBranch = branch?.match(/(?:^|[-_/])pr[-_]?(\d+)(?:$|[-_/])/i)?.[1];
  const fromWo = woId?.match(/#(\d+)/)?.[1];
  const parsed = Number(fromBranch ?? fromWo);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function summarizeChecks(checks: readonly RequiredCheckEvidence[]): PullRequestEvidence['checks'] {
  const failed = checks.filter(
    check => !['success', 'passed', 'neutral_ok'].includes(check.conclusion)
  ).length;
  const pending = checks.filter(check =>
    ['queued', 'in_progress', 'pending'].includes(check.conclusion)
  ).length;
  return {
    total: checks.length,
    passed: checks.length - failed - pending,
    failed,
    pending,
    conclusion:
      failed > 0 ? 'failure' : pending > 0 ? 'pending' : checks.length > 0 ? 'success' : undefined,
  };
}

function zeroChecks(): PullRequestEvidence['checks'] {
  return { total: 0, passed: 0, failed: 0, pending: 0 };
}

function recordFromMetadata(record: WatchedRunRecord, key: string): Record<string, unknown> | null {
  const value = record.metadata?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFromMetadata(record: WatchedRunRecord, key: string): string | null {
  const value = record.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
