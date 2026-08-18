import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { createMergeManager } from '../merge-manager.ts';
import { watchOnce, type WatchHeartbeatLogger } from '../watch.ts';
import {
  createRealMergePullRequest,
  resolveRealOctokitAuthOptions,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

// WO-HARNESS-MERGE-MANAGER-WIRING-LAND-01 -- the three mandated coordinator scenarios:
//   1. a green + mergeable + merge_candidate record executes exactly one merge, routed
//      through the App identity, and records the decision;
//   2. red-checks / conflicting / no-verdict records are skipped loudly and never merged;
//   3. an empty watch cycle still emits a merge-coordinator heartbeat line.
// All network-free: fake GitHubClientDeps and an injected logger seam (no mock.module()).

const RUN_HEAD_SHA = 'a'.repeat(40);

// A cryptographically valid RSA key so resolveGitHubAppAuth's createPrivateKey parse
// succeeds -- a "-----BEGIN"-shaped placeholder would be rejected at construction time.
const FAKE_PEM = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

const APP_ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of APP_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of APP_ENV_KEYS) {
    const prior = savedEnv.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
});

const mergeCandidateRecord: WatchedRunRecord = {
  runId: 'run-coordinator-wiring-1',
  woId: 'WO-COORDINATOR-WIRING-01',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  status: 'failed',
  action: 'merge_ready',
  reason: 'green PR',
  errorClass: 'tail_node_false_fail',
  workingPath: '/archon/worktrees/run-coordinator-wiring-1',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
    prTitle: 'Ready to merge',
    filesChangedCount: 1,
    diffStat: '+1 -0',
    headSha: RUN_HEAD_SHA,
  },
};

/** Stand-in for git: the run's worktree tip matches the PR head (provenance verifies). */
const readWorktreeHeadSha = async (): Promise<string | null> => RUN_HEAD_SHA;

function mergeCandidateEvidence(): QualifiedMergeEvidence {
  return {
    record: mergeCandidateRecord,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: mergeCandidateRecord.owner ?? 'thinmansoftware',
    repository: mergeCandidateRecord.repo ?? 'bdc-harness',
    base_branch: 'dev',
    // Non-production so the John-hold gate does not short-circuit the execute path.
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/index.ts'],
    pr_number: 42,
    head_sha: RUN_HEAD_SHA,
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: RUN_HEAD_SHA }],
    reviews: [{ resolved: true }],
    independent_review: null,
    operator: {
      identity: 'overseer-merge-manager-v1',
      provider: 'overseer',
      model_family: 'merge-manager',
    },
    manifest: null,
    proposal_id: null,
    proposal_present: false,
    fusion: null,
    expected_verifier_registry_digest: '',
    final_state_consistent: true,
  };
}

function approveReceipt(
  input: Parameters<NonNullable<Parameters<typeof createMergeManager>[0]['judge']>>[0]
): GrokDispositionReceipt {
  return {
    schemaVersion: 'overseer-grok-merge-disposition-v1',
    disposition: 'approve',
    reason: 'judge_approve',
    woId: input.woId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    evidenceDigest: input.evidenceDigest,
    operator: input.operator,
  };
}

describe('merge coordinator wiring (WO-HARNESS-MERGE-MANAGER-WIRING-LAND-01)', () => {
  test('Test 1: merge_candidate verdict executes exactly one merge via the App identity', async () => {
    // App auth is complete -> the runtime octokit authenticates as the Thinman Overseer
    // App, so any merge it issues is attributable to the App identity, not John's PAT.
    process.env.GITHUB_APP_ID = '4574893';
    process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PEM;

    const authOptions = resolveRealOctokitAuthOptions();
    expect('authStrategy' in authOptions).toBe(true);
    if ('authStrategy' in authOptions) {
      expect(authOptions.authStrategy).toBe(createAppAuth);
    }

    // The executed merge routes through the REAL mergePullRequest deps -- the same
    // composition server/index.ts builds from the App-authed octokit -- not a stub.
    const pullsGet = mock(async () => ({
      data: {
        number: 42,
        title: 'Ready to merge',
        state: 'open',
        head: { sha: RUN_HEAD_SHA },
      },
    }));
    const pullsMerge = mock(async () => ({ data: { merged: true, sha: RUN_HEAD_SHA } }));
    const octokit = {
      pulls: { get: pullsGet, merge: pullsMerge },
    } as unknown as RealGitHubOctokitLike;

    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));

    const manager = createMergeManager({
      mode: 'execute',
      assembleEvidence: async () => ({
        evidence: mergeCandidateEvidence(),
        evidenceDigest: 'c'.repeat(64),
      }),
      judge,
      insertOverseerAction,
      findPullRequest: async () => mergeCandidateRecord.prEvidence,
      mergePullRequest: createRealMergePullRequest(octokit),
      readWorktreeHeadSha,
    });

    const result = await manager(mergeCandidateRecord);

    expect(result.status).toBe('executed');
    expect(judge).toHaveBeenCalledTimes(1);
    // Exactly one merge call issued for the candidate PR.
    expect(pullsMerge).toHaveBeenCalledTimes(1);
    const mergeInput = pullsMerge.mock.calls[0]?.[0] as { pull_number: number } | undefined;
    expect(mergeInput?.pull_number).toBe(42);
    // Decision log line recorded.
    expect(insertOverseerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'merged', runId: mergeCandidateRecord.runId })
    );
  });

  test('Test 2: red / conflicting / no-verdict PRs are skipped loudly and never merged', async () => {
    const runs: OverseerRunRecord[] = [
      {
        id: 'run-red',
        woId: 'WO-RED-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'archon/red',
      },
      {
        id: 'run-conflict',
        woId: 'WO-CONFLICT-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'archon/conflict',
      },
      {
        id: 'run-noverdict',
        woId: 'WO-NOVERDICT-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'archon/noverdict',
      },
    ];

    const evidenceByBranch: Record<string, PullRequestEvidence> = {
      // Red checks: open + mergeable but a failed check -> not green -> not merge-ready.
      'archon/red': {
        exists: true,
        state: 'open',
        checks: { total: 2, passed: 1, failed: 1, pending: 0 },
        mergeable: true,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 11 },
        headSha: RUN_HEAD_SHA,
      },
      // Conflicting: green checks but not mergeable -> not merge-ready.
      'archon/conflict': {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: false,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 12 },
        headSha: RUN_HEAD_SHA,
      },
      // No verdict: no PR was ever opened -> nothing for the coordinator to act on.
      'archon/noverdict': {
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      },
    };

    const mergePullRequest = mock(async () => ({ merged: false }));
    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      listRunsForWatch: async () => runs,
      listRunEvents: async () => [],
      findPullRequest: async input => {
        const evidence = input.headBranch ? evidenceByBranch[input.headBranch] : undefined;
        if (!evidence)
          throw new Error(`unexpected findPullRequest for ${String(input.headBranch)}`);
        return evidence;
      },
      mergePullRequest,
    };

    const records = await watchOnce(deps);
    expect(records).toHaveLength(3);

    // The safety gate: none of the three unsafe PRs is classified merge_ready.
    expect(records.every(record => record.action !== 'merge_ready')).toBe(true);

    // Three distinct skip reasons, each naming its own cause.
    const reasons = records.map(record => record.reason);
    expect(new Set(reasons).size).toBe(3);
    const reasonFor = (runId: string): string =>
      records.find(record => record.runId === runId)?.reason ?? '';
    expect(reasonFor('run-red')).toContain('not merge-ready');
    expect(reasonFor('run-red')).toContain('mergeable=true');
    expect(reasonFor('run-conflict')).toContain('mergeable=false');
    expect(reasonFor('run-noverdict')).toContain('no PR');

    // Zero merge calls: mirror service.ts's dispatch guard (handleRecord only invokes the
    // coordinator when record.action === 'merge_ready') and confirm it never fires.
    const coordinator = mock(async () => undefined);
    for (const record of records) {
      if (record.action === 'merge_ready') await coordinator(record);
    }
    expect(coordinator).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  test('Test 3: an empty watch cycle still emits a merge-coordinator heartbeat line', async () => {
    const heartbeats: string[] = [];
    const logger: WatchHeartbeatLogger = {
      info: (_obj, msg) => {
        heartbeats.push(msg);
      },
    };

    const deps: OverseerRunStoreDeps & GitHubClientDeps = {
      listRunsForWatch: async () => [],
      listRunEvents: async () => [],
      findPullRequest: async () => {
        throw new Error('findPullRequest must not be called on an empty cycle');
      },
      mergePullRequest: async () => ({ merged: false }),
    };

    const records = await watchOnce(deps, { logger });

    expect(records).toHaveLength(0);
    expect(heartbeats.some(msg => msg.includes('merge-coordinator.heartbeat'))).toBe(true);
  });
});
