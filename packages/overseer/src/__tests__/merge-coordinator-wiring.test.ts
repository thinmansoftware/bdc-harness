import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createAppAuth } from '@octokit/auth-app';
import { createMergeManager } from '../merge-manager.ts';
import { watchOnce, type WatchHeartbeatLogger } from '../watch.ts';
import { handleRecord, type MergeReadyCoordinator } from '../service.ts';
import {
  createRealMergePullRequest,
  createRealOctokitClient,
  resolveRealOctokitAuthOptions,
  type RealGitHubOctokitLike,
} from '../adapters/github-real-deps.ts';
import type { QualifiedMergeEvidence } from '../actions/merge-ready.ts';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  OverseerActionsDeps,
  OverseerRunRecord,
  OverseerRunStoreDeps,
  PullRequestEvidence,
  WatchedRunRecord,
} from '../types.ts';

/**
 * Structured heartbeat records: the injected logger captures BOTH the object
 * argument (evaluated/total/eligible counts) and the message, so tests can
 * assert the observability content, not just that a line was emitted.
 */
interface CapturedHeartbeat {
  obj: Record<string, unknown>;
  msg: string;
}

function captureHeartbeats(): { logger: WatchHeartbeatLogger; entries: CapturedHeartbeat[] } {
  const entries: CapturedHeartbeat[] = [];
  const logger: WatchHeartbeatLogger = {
    info: (obj, msg) => {
      entries.push({ obj, msg });
    },
  };
  return { logger, entries };
}

function heartbeatFor(entries: CapturedHeartbeat[]): CapturedHeartbeat | undefined {
  return entries.find(entry => entry.msg.includes('merge-coordinator.heartbeat'));
}

/**
 * Drive the REAL service dispatch gate (`handleRecord`) over a batch of records,
 * with the v1 classifier path forced: OVERSEER_JUDGE_FIRST and
 * OVERSEER_EMERGENCY_STOP are neutralized (and restored) so the merge-vs-skip
 * branch under test runs deterministically regardless of ambient env. Using the
 * real handleRecord -- not an inline copy of its `action === 'merge_ready'` gate --
 * means drift in service.ts's dispatch condition is caught here.
 */
async function dispatchThroughService(
  records: WatchedRunRecord[],
  deps: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps,
  mergeCoordinator: MergeReadyCoordinator | undefined
): Promise<void> {
  const priorJudgeFirst = process.env.OVERSEER_JUDGE_FIRST;
  const priorStop = process.env.OVERSEER_EMERGENCY_STOP;
  delete process.env.OVERSEER_JUDGE_FIRST;
  delete process.env.OVERSEER_EMERGENCY_STOP;
  try {
    for (const record of records) {
      await handleRecord(record, deps, false, 'merge-coordinator-wiring-test', mergeCoordinator);
    }
  } finally {
    if (priorJudgeFirst === undefined) delete process.env.OVERSEER_JUDGE_FIRST;
    else process.env.OVERSEER_JUDGE_FIRST = priorJudgeFirst;
    if (priorStop === undefined) delete process.env.OVERSEER_EMERGENCY_STOP;
    else process.env.OVERSEER_EMERGENCY_STOP = priorStop;
  }
}

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

    // Guard 1: the auth-strategy SELECTOR picks the App path from these env vars.
    const authOptions = resolveRealOctokitAuthOptions();
    expect('authStrategy' in authOptions).toBe(true);
    if ('authStrategy' in authOptions) {
      expect(authOptions.authStrategy).toBe(createAppAuth);
    }

    // Guard 2 (the bridge): build the merge actor through the SAME production
    // composition server/index.ts uses -- createRealOctokitClient(), which is
    // `new Octokit(resolveRealOctokitAuthOptions())` -- and PROVE that exact client
    // authenticates as the GitHub App by minting an app JWT locally (no network:
    // createAppAuth signs the JWT from the RSA key in-process). A PAT-authed client
    // returns `{ type: 'token' }` here, so a silent PAT downgrade of the merge actor
    // fails this assertion. The octokit proven App-authed below is the one whose
    // pulls.merge executes the merge -- identity and merge-actor are now the same
    // object in code, not bridged by comment narrative.
    const octokit = createRealOctokitClient();
    const appAuth = (await (
      octokit as unknown as {
        auth: (opts: { type: 'app' }) => Promise<{ type: string }>;
      }
    ).auth({ type: 'app' })) as { type: string };
    expect(appAuth.type).toBe('app');

    // Replace only the network leaves; the App identity established above still owns
    // the pulls.merge call issued through createRealMergePullRequest(octokit).
    const pullsGet = mock(async () => ({
      data: {
        number: 42,
        title: 'Ready to merge',
        state: 'open',
        head: { sha: RUN_HEAD_SHA },
      },
    }));
    const pullsMerge = mock(async () => ({ data: { merged: true, sha: RUN_HEAD_SHA } }));
    octokit.pulls.get = pullsGet as unknown as RealGitHubOctokitLike['pulls']['get'];
    octokit.pulls.merge = pullsMerge as unknown as RealGitHubOctokitLike['pulls']['merge'];

    const insertOverseerAction = mock(async () => undefined);
    const judge = mock(async input => approveReceipt(input));

    const manager = createMergeManager({
      mode: 'execute',
      mutationsEnabled: true,
      allowedBases: ['dev', 'staging'],
      reviewGateLogin: 'thinman-review-gate[bot]',
      listPullRequestReviews: async () => [
        { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: RUN_HEAD_SHA },
      ],
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
    const insertOverseerAction = mock(async () => undefined);
    const deps: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps = {
      listRunsForWatch: async () => runs,
      listRunEvents: async () => [],
      findPullRequest: async input => {
        const evidence = input.headBranch ? evidenceByBranch[input.headBranch] : undefined;
        if (!evidence)
          throw new Error(`unexpected findPullRequest for ${String(input.headBranch)}`);
        return evidence;
      },
      mergePullRequest,
      insertOverseerAction,
    };

    const { logger, entries } = captureHeartbeats();
    const records = await watchOnce(deps, { logger });
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

    // Heartbeat counts reflect ACTUAL work, not a hardcoded shape: three terminal
    // runs evaluated, three total, zero eligible (none merge-ready). Asserting the
    // logged OBJECT (not just the message) kills a mutation that always logs zeros.
    const heartbeat = heartbeatFor(entries);
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.obj).toEqual({ evaluated: 3, total: 3, eligible: 0 });

    // Zero merge calls -- driven through the REAL service dispatch gate
    // (handleRecord), not an inline copy of its `action === 'merge_ready'` check.
    // If that gate ever drifted to dispatch non-merge_ready records to the
    // coordinator, this fails. All three records are success/ignore, so the
    // coordinator must never fire and no merge action is recorded.
    const coordinator = mock(async () => undefined);
    await dispatchThroughService(records, deps, coordinator);
    expect(coordinator).not.toHaveBeenCalled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    // No merge/merge_denied action written for any of the safely-skipped
    // records. Skipped records DO write terminal watch_closed dispositions
    // (window drain, 5th canary defect 2026-08-25) -- assert those are the
    // ONLY writes.
    for (const call of insertOverseerAction.mock.calls as unknown as [{ action: string }][]) {
      expect(call[0].action).toBe('watch_closed');
    }
  });

  test('Test 3: an empty watch cycle still emits a merge-coordinator heartbeat with zeroed counts', async () => {
    const { logger, entries } = captureHeartbeats();

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
    const heartbeat = heartbeatFor(entries);
    expect(heartbeat).toBeDefined();
    // Assert the logged OBJECT, not just the message: an empty cycle reports all
    // zeros. (A hardcoded-zeros mutation is caught by Test 4's non-zero counts.)
    expect(heartbeat?.obj).toEqual({ evaluated: 0, total: 0, eligible: 0 });
  });

  test('Test 4: heartbeat counts a merge-ready run as eligible and the real gate dispatches it', async () => {
    // Mixed batch: one merge-ready terminal run, one non-eligible terminal run, and
    // one still-running (non-terminal) run. The three counts are deliberately
    // distinct -- evaluated=2, total=3, eligible=1 -- so a mutation that hardcodes
    // ANY single count is caught (no two fields share a value with the empty cycle).
    const runs: OverseerRunRecord[] = [
      {
        id: 'run-green',
        woId: 'WO-GREEN-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'archon/green',
      },
      {
        id: 'run-skip',
        woId: 'WO-SKIP-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'completed',
        headBranch: 'archon/skip',
      },
      {
        // Non-terminal: counted in `total` but never evaluated (watchOnce filters it
        // out before assessRun), so total(3) > evaluated(2) is a real distinction.
        id: 'run-active',
        woId: 'WO-ACTIVE-01',
        owner: 'thinmansoftware',
        repo: 'bdc-harness',
        status: 'running',
        headBranch: 'archon/active',
      },
    ];

    const evidenceByBranch: Record<string, PullRequestEvidence> = {
      // Green + open + mergeable -> merge-ready -> eligible.
      'archon/green': {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 77 },
        headSha: RUN_HEAD_SHA,
      },
      // Failed check -> not green -> not eligible.
      'archon/skip': {
        exists: true,
        state: 'open',
        checks: { total: 2, passed: 1, failed: 1, pending: 0 },
        mergeable: true,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 78 },
        headSha: RUN_HEAD_SHA,
      },
    };

    const mergePullRequest = mock(async () => ({ merged: false }));
    const insertOverseerAction = mock(async () => undefined);
    const deps: OverseerRunStoreDeps & OverseerActionsDeps & GitHubClientDeps = {
      listRunsForWatch: async () => runs,
      listRunEvents: async () => [],
      findPullRequest: async input => {
        const evidence = input.headBranch ? evidenceByBranch[input.headBranch] : undefined;
        if (!evidence)
          throw new Error(`unexpected findPullRequest for ${String(input.headBranch)}`);
        return evidence;
      },
      mergePullRequest,
      insertOverseerAction,
    };

    const { logger, entries } = captureHeartbeats();
    const records = await watchOnce(deps, { logger });

    // Only the two terminal runs are assessed.
    expect(records).toHaveLength(2);
    const eligibleRecords = records.filter(record => record.action === 'merge_ready');
    expect(eligibleRecords).toHaveLength(1);
    expect(eligibleRecords[0]?.runId).toBe('run-green');

    // The observability content is correct, not a fixed shape.
    const heartbeat = heartbeatFor(entries);
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.obj).toEqual({ evaluated: 2, total: 3, eligible: 1 });

    // Positive control for the dispatch gate: the REAL handleRecord routes the one
    // merge-ready record to the coordinator exactly once (and the skipped one never).
    const coordinator = mock(async () => undefined);
    await dispatchThroughService(records, deps, coordinator);
    expect(coordinator).toHaveBeenCalledTimes(1);
    expect(coordinator).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-green', action: 'merge_ready' })
    );
  });
});
