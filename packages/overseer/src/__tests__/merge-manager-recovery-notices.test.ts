/**
 * WO-HARNESS-MERGE-MANAGER-RECOVERY-01 (bdc-xo#6406): acceptance Tests 1-8.
 *
 * 1. The review-conflict lookup reads only the exact head's rows, so older-head rows cannot fill
 *    the 500-row page and strand an approved PR (shopops PR 1191, 2026-11-20).
 * 2. Bounded exhaustion posts one PR comment and one operator-mailbox message, with no secrets.
 * 3. Guards and persistence fail closed on a retry candidate.
 * 4. Both runtime merge paths post the full merge SHA to the PR and the operator mailbox.
 * 5. Docs-only bdc-harness dev PRs merge under the same gates as code; production bases do not.
 * 6. Older-head rows cannot fill the page; a full page at the head still fails closed.
 * 7. Only the bdc-harness dev docs-only entry of the default policy changes.
 * 8. A lookup that fails once is retried and the PR merges on the next due tick.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as connection from '@archon/core/db/connection';
import * as dispatch from '@archon/core/db/dispatch';
import type {
  CreateAuthenticatedMessageData,
  DispatchSenderContext,
} from '@archon/core/db/dispatch';
import { PR_REVIEW_LOG_RECIPIENT } from '@archon/core/db/dispatch-routing';
import type { OverseerVerdictRow, OverseerWatchRun } from '@archon/core/db/overseer';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { rootLogger } from '@archon/paths';
import type { QualifiedMergeEvidence } from '../actions/merge-ready';
import { loadReviewConflictAtHead } from '../adapters/github-real-deps';
import { COVERED_PRODUCTION_BASES } from '../m09-promotion-gate';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeOptions,
  type MergeExecutionBridgeStore,
  type MergeExecutionRepoConfig,
} from '../merge-execution-bridge';
import { createMergeManager } from '../merge-manager';
import { DEFAULT_MERGE_REPO_POLICY } from '../merge-repo-policy';
import type {
  GitHubClientDeps,
  GrokDispositionReceipt,
  PullRequestEvidence,
  ReviewConflictAtHead,
  WatchedRunRecord,
} from '../types';
import { withIsolatedDatabase } from './isolated-database';

const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const PR_NUMBER = 77;
const HEAD = 'e0232c99b60bdd76eb513b5848eb55b38e3540aa';
const MERGE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
const SUBJECT = `gh:${OWNER}/${REPO}#${PR_NUMBER}`;
const COMMENTER = 'thinman-overseer[bot]';
const FAKE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const T0 = new Date('2026-11-20T15:00:00.000Z');

const oldHead = (i: number): string => i.toString(16).padStart(40, '0');

// ---------------------------------------------------------------- log capture

function captureRootLogLines(): { lines: string[]; restore: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (!streamSymbol) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (line: string) => void }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const write = spyOn(stream, 'write').mockImplementation(line => {
    lines.push(String(line));
  });
  return { lines, restore: () => write.mockRestore() };
}

function logRecords(lines: string[], msg: string): Record<string, unknown>[] {
  return lines
    .filter(line => line.includes(msg))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>)
    .filter(record => record.msg === msg);
}

// ---------------------------------------------------------------- env isolation

const ENV_KEYS = [
  'MERGE_MANAGER_REPO_POLICY',
  'OVERSEER_MERGE_REPO_CONFIG',
  'MERGE_MANAGER_ALLOWED_BASES',
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------- bridge harness

const verdict = (id: string, overrides: Partial<OverseerVerdictRow> = {}): OverseerVerdictRow =>
  ({
    id,
    run_id: `run-${id}`,
    wo_id: `WO-${id.toUpperCase()}`,
    head_sha: HEAD,
    proposed_action: 'flag_merge_ready',
    merge_attempts: 0,
    merge_not_before: null,
    merge_last_transient_reason: null,
    actioned_at: null,
    action_reason: null,
    ...overrides,
  }) as OverseerVerdictRow;

const green = (overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence => ({
  exists: true,
  state: 'open',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  mergeable: true,
  mergeableState: 'clean',
  changedFilePaths: ['packages/overseer/src/x.ts'],
  baseBranch: 'dev',
  headSha: HEAD,
  htmlUrl: PR_URL,
  labels: [],
  draft: false,
  prTitle: 'fix(overseer): recovery',
  pr: { owner: OWNER, repo: REPO, number: PR_NUMBER },
  ...overrides,
});

type MessageCall = { context: DispatchSenderContext; data: CreateAuthenticatedMessageData };

interface HarnessOptions {
  rows: OverseerVerdictRow[];
  evidence: () => PullRequestEvidence;
  reviewConflictAtHead?: MergeExecutionBridgeOptions['reviewConflictAtHead'];
  hasQualifiedReview?: MergeExecutionBridgeOptions['hasQualifiedReview'];
  /** 'default' runs under DEFAULT_MERGE_REPO_POLICY (no repoConfig). */
  repoConfig?: MergeExecutionRepoConfig | 'default';
  retryMaxAttempts?: number;
  createMessage?: (
    context: DispatchSenderContext,
    data: CreateAuthenticatedMessageData
  ) => Promise<unknown>;
  runRepo?: string;
}

function bridgeHarness(input: HarnessOptions) {
  let clock = T0;
  const processing = new Set<string>();
  const events: { kind: 'outcome' | 'release' | 'defer'; verdictId: string; reason: string }[] = [];
  const outcomes: {
    verdictId: string;
    mutationSent: boolean;
    reason: string;
    mergeSha?: string;
  }[] = [];
  const deferrals: { verdictId: string; reason: string; notBefore: string }[] = [];
  const releases: { verdictId: string; reason: string }[] = [];
  const claims: string[] = [];
  const slotReleases: string[] = [];
  const comments: { body: string }[] = [];
  const messages: MessageCall[] = [];
  const counters = { merges: 0, approvals: 0, finds: 0 };
  const store: MergeExecutionBridgeStore = {
    listUnactionedVerdicts: async () =>
      input.rows.filter(
        row =>
          !row.actioned_at && (!row.merge_not_before || row.merge_not_before <= clock.toISOString())
      ),
    claimVerdict: async id => {
      const row = input.rows.find(item => item.id === id);
      if (!row || row.actioned_at) return false;
      row.actioned_at = clock.toISOString();
      row.action_reason = 'processing';
      processing.add(id);
      claims.push(id);
      return true;
    },
    releaseVerdictClaim: async (id, reason) => {
      const row = input.rows.find(item => item.id === id);
      releases.push({ verdictId: id, reason });
      events.push({ kind: 'release', verdictId: id, reason });
      processing.delete(id);
      if (row) {
        row.actioned_at = null;
        row.action_reason = null;
      }
      return true;
    },
    deferVerdictClaim: async (id, reason, notBefore) => {
      const row = input.rows.find(item => item.id === id);
      if (!row || !processing.has(id)) return false;
      deferrals.push({ verdictId: id, reason, notBefore });
      events.push({ kind: 'defer', verdictId: id, reason });
      processing.delete(id);
      row.actioned_at = null;
      row.action_reason = null;
      row.merge_attempts += 1;
      row.merge_not_before = notBefore;
      row.merge_last_transient_reason = reason;
      return true;
    },
    getRunById: async id =>
      ({
        id,
        woId: 'WO-TEST',
        owner: OWNER,
        repo: input.runRepo ?? REPO,
        status: 'completed',
        headBranch: 'feature',
        metadata: {},
      }) as OverseerWatchRun,
    getEarliestMergeSlotReservation: async () =>
      new Date(T0.getTime() - 50 * 60 * 1000).toISOString(),
    reserveMergeSlot: async () => true,
    releaseMergeSlot: async id => {
      slotReleases.push(id);
    },
    recordOutcome: async rec => {
      outcomes.push(rec);
      events.push({ kind: 'outcome', verdictId: rec.verdictId, reason: rec.reason });
      processing.delete(rec.verdictId);
      const row = input.rows.find(item => item.id === rec.verdictId);
      if (row) {
        row.actioned_at = clock.toISOString();
        row.action_reason = rec.reason;
      }
    },
  };
  const github: GitHubClientDeps = {
    findPullRequest: async () => {
      counters.finds += 1;
      return input.evidence();
    },
    mergePullRequest: async () => {
      counters.merges += 1;
      return { merged: true, mergeSha: MERGE_SHA };
    },
    approvePullRequest: async () => {
      counters.approvals += 1;
      return { approved: true };
    },
    commentAuthorLogin: COMMENTER,
    listPullRequestComments: async () =>
      comments.map(comment => ({ body: comment.body, authorLogin: COMMENTER })),
    commentOnPullRequest: async rec => {
      comments.push({ body: rec.body });
      return { commented: true };
    },
  } as GitHubClientDeps;
  const createMessage =
    input.createMessage ??
    (async (context: DispatchSenderContext, data: CreateAuthenticatedMessageData) => {
      messages.push({ context, data });
      return { id: `msg-${messages.length}` };
    });
  const options: MergeExecutionBridgeOptions = {
    readRunEvents: async () => [],
    store,
    github,
    hasQualifiedReview: input.hasQualifiedReview ?? (async () => true),
    reviewConflictAtHead: input.reviewConflictAtHead ?? (async () => null),
    createMessage,
    now: () => clock,
    retryBaseMinutes: 10,
    retryMaxDelayMinutes: 240,
    retryMaxAttempts: input.retryMaxAttempts ?? 8,
    readPolicy: () => ({
      service_enabled: true,
      emergency_stop: false,
      legacy_dry_run: false,
      capability_flags: {
        escalation: false,
        repair: false,
        branch: false,
        lifecycle: false,
        merge: true,
      },
    }),
    ...(input.repoConfig === 'default'
      ? {}
      : { repoConfig: input.repoConfig ?? { [`${OWNER}/${REPO}`]: { baseBranch: 'dev' } } }),
  };
  return {
    options,
    store,
    github,
    events,
    outcomes,
    deferrals,
    releases,
    claims,
    slotReleases,
    comments,
    messages,
    counters,
    setClock: (value: Date) => {
      clock = value;
    },
  };
}

// ---------------------------------------------------------------- real-DB row writers

async function insertRequest(headSha: string, status: 'done' | 'queued' = 'done'): Promise<string> {
  const nonce = Math.random().toString(36).slice(2);
  const row = await dispatch.createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      correlation_id: `pr-review:${OWNER}/${REPO}#${PR_NUMBER}@${headSha}`,
      idempotency_key: `req:${nonce}`,
      repeat_reason: `review_request:${nonce}`,
      task_type: 'run_review',
      recipient: 'overseer-reviewer',
      subject_key: SUBJECT,
      body: JSON.stringify({ owner: OWNER, repo: REPO, prNumber: PR_NUMBER, headSha }),
    }
  );
  if (!row) throw new Error('request insert returned null');
  if (status === 'done') {
    await connection
      .getDatabase()
      .query("UPDATE agent_dispatch_messages SET status = 'done' WHERE id = $1", [row.id]);
  }
  return row.id;
}

async function insertReceipt(
  headSha: string,
  disposition: 'approved' | 'changes_requested',
  correlationId = `pr-review:${OWNER}/${REPO}#${PR_NUMBER}@${headSha}`
): Promise<void> {
  const nonce = Math.random().toString(36).slice(2);
  const row = await dispatch.createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      correlation_id: correlationId,
      idempotency_key: `pr-review-submit-receipt:${nonce}:${disposition}`,
      repeat_reason: `review_verdict_receipt:${nonce}:${disposition}`,
      task_type: 'run_report',
      recipient: PR_REVIEW_LOG_RECIPIENT,
      subject_key: SUBJECT,
      body: JSON.stringify({
        kind: 'pr_review_submit_receipt',
        disposition,
        owner: OWNER,
        repo: REPO,
        prNumber: PR_NUMBER,
        headSha,
        messageId: `msg-${nonce}`,
      }),
    }
  );
  if (!row) throw new Error('receipt insert returned null');
}

function bodyHead(row: { body: string }): string | null {
  try {
    const parsed = JSON.parse(row.body) as { headSha?: unknown };
    return typeof parsed.headSha === 'string' ? parsed.headSha : null;
  } catch {
    return null;
  }
}

const realLookup =
  (rowsSeen?: { body: string }[]) =>
  (input: { owner: string; repo: string; number: number; headSha: string }) =>
    loadReviewConflictAtHead(
      input,
      async filters => {
        const rows = await dispatch.listMessages(filters);
        rowsSeen?.push(...rows);
        return rows;
      },
      dispatch.listMessagesByCorrelationPrefixWithoutSubjectKey
    );

// ---------------------------------------------------------------- merge manager fixture

const RUN_RECORD: WatchedRunRecord = {
  runId: 'run-merge-manager-recovery',
  woId: 'WO-MERGE-MANAGER-RECOVERY-FIXTURE',
  owner: OWNER,
  repo: REPO,
  status: 'completed',
  action: 'merge_ready',
  reason: 'green PR',
  workingPath: '/archon/worktrees/run-merge-manager-recovery',
  prEvidence: {
    exists: true,
    state: 'open',
    checks: { total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: true,
    pr: { owner: OWNER, repo: REPO, number: 42 },
    prTitle: 'Ready to merge',
    filesChangedCount: 1,
    diffStat: '+1 -0',
    headSha: HEAD,
  },
};

function managerEvidence(): QualifiedMergeEvidence {
  return {
    record: RUN_RECORD,
    registry: { schema_version: 'overseer-action-policy-v1', entries: [] },
    owner: OWNER,
    repository: REPO,
    base_branch: 'dev',
    resulting_deployment_effect: 'none',
    credential_principal: 'overseer-merge-manager-v1',
    action_kind: 'MERGE',
    changed_files: ['src/index.ts'],
    pr_number: 42,
    head_sha: HEAD,
    base_sha: 'b'.repeat(40),
    required_checks: [{ name: 'ci', conclusion: 'success', head_sha: HEAD }],
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
  } as QualifiedMergeEvidence;
}

function managerHarness(createMessage?: HarnessOptions['createMessage']) {
  const comments: { body: string }[] = [];
  const messages: MessageCall[] = [];
  let mergeResult: { merged: boolean; message?: string; sha?: string } = {
    merged: true,
    message: 'merge_manager_executed',
    sha: MERGE_SHA,
  };
  const execute = mock(async () => mergeResult);
  const mergePullRequest = mock(async () => ({ merged: false }));
  const manager = createMergeManager({
    readRunEvents: async () => [],
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['dev'],
    reviewGateLogin: 'thinman-review-gate[bot]',
    listPullRequestReviews: async () => [
      { login: 'thinman-review-gate[bot]', state: 'APPROVED', commitId: HEAD },
    ],
    assembleEvidence: async () => ({ evidence: managerEvidence(), evidenceDigest: 'c'.repeat(64) }),
    judge: async (input): Promise<GrokDispositionReceipt> => ({
      schemaVersion: 'overseer-grok-merge-disposition-v1',
      disposition: 'approve',
      reason: 'judge_approve',
      woId: input.woId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      evidenceDigest: input.evidenceDigest,
      operator: input.operator,
    }),
    execute,
    insertOverseerAction: mock(async () => undefined),
    findPullRequest: async () => RUN_RECORD.prEvidence,
    mergePullRequest,
    readWorktreeHeadSha: async () => HEAD,
    commentAuthorLogin: COMMENTER,
    listPullRequestComments: async () =>
      comments.map(comment => ({ body: comment.body, authorLogin: COMMENTER })),
    commentOnPullRequest: async rec => {
      comments.push({ body: rec.body });
      return { commented: true };
    },
    createMessage:
      createMessage ??
      (async (context, data) => {
        messages.push({ context, data });
        return { id: `msg-${messages.length}` };
      }),
  });
  return {
    manager,
    comments,
    messages,
    execute,
    mergePullRequest,
    setMergeResult: (value: typeof mergeResult) => {
      mergeResult = value;
    },
  };
}

// ---------------------------------------------------------------- tests

describe('WO-HARNESS-MERGE-MANAGER-RECOVERY-01', () => {
  test(
    'Test 1: Head-scoped lookup lets an approved PR merge on the next eligible tick',
    () =>
      withIsolatedDatabase(async () => {
        for (let i = 1; i <= 600; i += 1) await insertRequest(oldHead(i));
        await insertRequest(HEAD);
        await insertReceipt(HEAD, 'approved');
        const rowsSeen: { body: string }[] = [];
        const h = bridgeHarness({
          rows: [verdict('t1')],
          evidence: () => green(),
          reviewConflictAtHead: realLookup(rowsSeen),
        });

        await runMergeExecutionBridgeOnce(h.options);

        expect(h.counters.merges).toBe(1);
        expect(h.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
        expect(h.deferrals).toEqual([]);
        // The lookup read only the exact head's rows.
        expect(rowsSeen.length).toBeGreaterThan(0);
        expect(rowsSeen.every(row => bodyHead(row) === HEAD)).toBe(true);
      }),
    120_000
  );

  test('Test 2: Bounded exhaustion and two-channel escalation', async () => {
    const captured = captureRootLogLines();
    try {
      const failingRead = async (): Promise<never> => {
        throw new Error(`connect ECONNREFUSED 10.0.0.5:5432 token=${FAKE_TOKEN}`);
      };
      const h = bridgeHarness({
        rows: [verdict('t2')],
        evidence: () => green(),
        retryMaxAttempts: 3,
        reviewConflictAtHead: input => loadReviewConflictAtHead(input, failingRead, failingRead),
      });

      // Drive due ticks through exhaustion: attempts 0 -> 1 -> 2, then the cap (3) is reached.
      await runMergeExecutionBridgeOnce(h.options);
      h.setClock(new Date(T0.getTime() + 11 * 60 * 1000));
      await runMergeExecutionBridgeOnce(h.options);
      h.setClock(new Date(T0.getTime() + 40 * 60 * 1000));
      await runMergeExecutionBridgeOnce(h.options);

      expect(h.deferrals.map(d => d.reason)).toEqual([
        'review_conflict_at_head:lookup_failed',
        'review_conflict_at_head:lookup_failed',
      ]);
      expect(h.outcomes.map(o => o.reason)).toEqual([
        'transient_exhausted:review_conflict_at_head:lookup_failed',
      ]);
      expect(h.counters.merges).toBe(0);

      const exhaustedComments = h.comments.filter(c =>
        c.body.includes('<!-- merge-manager-exhausted -->')
      );
      expect(exhaustedComments).toHaveLength(1);
      expect(exhaustedComments[0]!.body).toContain(HEAD);
      expect(exhaustedComments[0]!.body).toContain('review_conflict_at_head:lookup_failed');
      expect(exhaustedComments[0]!.body).toContain('after 3 attempts');

      expect(h.messages).toHaveLength(1);
      const message = h.messages[0]!;
      expect(message.context).toEqual({ kind: 'system', sender: 'overseer' });
      expect(message.data.recipient).toBe('operator');
      expect(message.data.task_type).toBe('agent_message');
      expect(message.data.idempotency_key).toBe(
        `overseer:merge-exhausted:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD}`
      );
      expect(message.data.body).toContain(PR_URL);
      expect(message.data.body).toContain(HEAD);
      expect(message.data.body).toContain('after 3 attempts');
      expect(message.data.body).toContain('review_conflict_at_head:lookup_failed');
      expect(message.data.body).toContain('Next action:');
      expect(assessDispatchMessageBody('agent_message', message.data.body).allowed).toBe(true);

      // The lookup logged the sanitized cause, with no secret.
      const causes = logRecords(
        captured.lines,
        'overseer.github_real_deps.review_conflict_lookup_failed'
      );
      expect(causes.length).toBeGreaterThan(0);
      expect(causes[0]).toEqual(
        expect.objectContaining({
          cause: 'threw',
          errorName: 'Error',
          owner: OWNER,
          repo: REPO,
          prNumber: PR_NUMBER,
          headSha: HEAD,
        })
      );
      expect(String(causes[0]!.errorMessage)).toContain('ECONNREFUSED');
      const everything = [
        ...captured.lines,
        ...h.comments.map(c => c.body),
        ...h.messages.map(m => m.data.body),
        ...h.outcomes.map(o => o.reason),
      ].join('\n');
      expect(everything).not.toContain(FAKE_TOKEN);

      // Replaying the terminal tick sends nothing more and attempts nothing more.
      h.setClock(new Date(T0.getTime() + 600 * 60 * 1000));
      await runMergeExecutionBridgeOnce(h.options);
      expect(h.claims).toHaveLength(3);
      expect(h.messages).toHaveLength(1);
      expect(
        h.comments.filter(c => c.body.includes('<!-- merge-manager-exhausted -->'))
      ).toHaveLength(1);
      expect(h.counters.merges).toBe(0);
    } finally {
      captured.restore();
    }

    // A run-less verdict that exhausts before its pull request was read still names its PR.
    const runless = bridgeHarness({
      rows: [
        verdict('t2-runless', {
          run_id: `pr-discovery:${OWNER}/${REPO}#${PR_NUMBER}`,
          wo_id: `gh:${OWNER}/${REPO}#${PR_NUMBER}`,
          merge_attempts: 2,
        }),
      ],
      evidence: () => {
        throw new Error('pull request read failed');
      },
      retryMaxAttempts: 3,
    });
    await runMergeExecutionBridgeOnce(runless.options);
    expect(runless.outcomes.map(o => o.reason)).toEqual([
      'transient_exhausted:pr_context_fetch_failed',
    ]);
    expect(
      runless.comments.filter(c => c.body.includes('<!-- merge-manager-exhausted -->'))
    ).toHaveLength(1);
    expect(runless.messages).toHaveLength(1);
    expect(runless.messages[0]!.data.idempotency_key).toBe(
      `overseer:merge-exhausted:${OWNER}/${REPO}#${PR_NUMBER}@${HEAD}`
    );
    expect(runless.messages[0]!.data.body).toContain(PR_URL);
  });

  test('Test 3: Fail closed on guard and persistence failures', async () => {
    const retry = (id: string): OverseerVerdictRow =>
      verdict(id, {
        merge_attempts: 2,
        merge_last_transient_reason: 'review_conflict_at_head:lookup_failed',
      });

    // Head moved: terminal, no merge.
    const moved = bridgeHarness({
      rows: [retry('moved')],
      evidence: () => green({ headSha: 'f'.repeat(40) }),
    });
    await runMergeExecutionBridgeOnce(moved.options);
    expect(moved.counters.merges).toBe(0);
    expect(moved.outcomes.map(o => o.reason)).toEqual(['verdict_stale_head']);

    // Approval no longer qualifies at the exact head: no merge.
    const stale = bridgeHarness({
      rows: [retry('stale')],
      evidence: () => green(),
      hasQualifiedReview: async () => false,
    });
    await runMergeExecutionBridgeOnce(stale.options);
    expect(stale.counters.merges).toBe(0);
    expect(stale.outcomes.map(o => o.reason)).toEqual(['review_execution_unqualified']);

    // Checks now fail: deferred, no merge.
    const red = bridgeHarness({
      rows: [retry('red')],
      evidence: () => green({ checks: { total: 2, passed: 1, failed: 1, pending: 0 } }),
    });
    await runMergeExecutionBridgeOnce(red.options);
    expect(red.counters.merges).toBe(0);
    expect(red.deferrals.map(d => d.reason)).toEqual(['required_checks_not_success']);

    // A hold is added: released without consuming an attempt; lifting it merges.
    let held = true;
    const holdRows = [retry('hold')];
    const hold = bridgeHarness({
      rows: holdRows,
      evidence: () => green({ labels: held ? ['merge-hold'] : [] }),
    });
    await runMergeExecutionBridgeOnce(hold.options);
    expect(hold.counters.merges).toBe(0);
    expect(hold.outcomes).toEqual([]);
    expect(hold.deferrals).toEqual([]);
    expect(holdRows[0]!.merge_attempts).toBe(2);
    expect(holdRows[0]!.actioned_at).toBeNull();
    held = false;
    await runMergeExecutionBridgeOnce(hold.options);
    expect(hold.counters.merges).toBe(1);

    // A base with production effect: never merged.
    const prod = bridgeHarness({
      rows: [retry('prod')],
      evidence: () => green({ baseBranch: 'main' }),
      repoConfig: 'default',
    });
    await runMergeExecutionBridgeOnce(prod.options);
    expect(prod.counters.merges).toBe(0);
    expect(prod.counters.approvals).toBe(0);
    expect(['integration_base_mismatch', 'spec_only', 'base_not_allowlisted']).toContain(
      prod.outcomes[0]?.reason
    );

    // A failed deferral is visible and releases the claim recoverably.
    const captured = captureRootLogLines();
    try {
      const deferRows = [retry('defer')];
      const defer = bridgeHarness({
        rows: deferRows,
        evidence: () => green(),
        reviewConflictAtHead: async () => 'lookup_failed',
      });
      defer.store.deferVerdictClaim = async () => false;
      await runMergeExecutionBridgeOnce(defer.options);
      expect(defer.counters.merges).toBe(0);
      expect(defer.outcomes).toEqual([]);
      expect(defer.releases.map(r => r.reason)).toEqual([
        'merge_defer_failed:review_conflict_at_head:lookup_failed',
      ]);
      expect(deferRows[0]!.actioned_at).toBeNull();
      expect(logRecords(captured.lines, 'merge-coordinator.claim_released').length).toBe(1);
    } finally {
      captured.restore();
    }

    // A real changes-requested conflict at the exact head stays blocked.
    const conflict = bridgeHarness({
      rows: [retry('conflict')],
      evidence: () => green(),
      reviewConflictAtHead: async () => 'changes_requested',
    });
    await runMergeExecutionBridgeOnce(conflict.options);
    await runMergeExecutionBridgeOnce(conflict.options);
    expect(conflict.counters.merges).toBe(0);
    expect(conflict.outcomes.map(o => o.reason)).toEqual([
      'review_conflict_at_head:changes_requested',
    ]);
    expect(conflict.deferrals).toEqual([]);
  });

  test('Test 4: Merge notice on both runtime merge paths', async () => {
    // Bridge path.
    const bridge = bridgeHarness({ rows: [verdict('t4')], evidence: () => green() });
    await runMergeExecutionBridgeOnce(bridge.options);
    expect(bridge.counters.merges).toBe(1);
    const receipts = bridge.comments.filter(c => c.body.includes('<!-- merge-manager-receipt -->'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toContain(`Merge commit ${MERGE_SHA}.`);
    expect(bridge.messages).toHaveLength(1);
    expect(bridge.messages[0]!.context).toEqual({ kind: 'system', sender: 'overseer' });
    expect(bridge.messages[0]!.data.recipient).toBe('operator');
    expect(bridge.messages[0]!.data.idempotency_key).toBe(
      `overseer:merge-receipt:${OWNER}/${REPO}#${PR_NUMBER}@${MERGE_SHA}`
    );
    expect(bridge.messages[0]!.data.body).toContain(MERGE_SHA);
    expect(bridge.messages[0]!.data.body).toContain(PR_URL);
    expect(assessDispatchMessageBody('agent_message', bridge.messages[0]!.data.body).allowed).toBe(
      true
    );
    await runMergeExecutionBridgeOnce(bridge.options);
    expect(bridge.messages).toHaveLength(1);
    expect(
      bridge.comments.filter(c => c.body.includes('<!-- merge-manager-receipt -->'))
    ).toHaveLength(1);
    expect(bridge.counters.merges).toBe(1);

    // Bridge path, mailbox send fails: logged, PR receipt still posted.
    const captured = captureRootLogLines();
    try {
      const failing = bridgeHarness({
        rows: [verdict('t4-fail')],
        evidence: () => green(),
        createMessage: async () => {
          throw new Error('dispatch insert failed');
        },
      });
      await runMergeExecutionBridgeOnce(failing.options);
      expect(failing.counters.merges).toBe(1);
      expect(failing.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
      const failedReceipts = failing.comments.filter(c =>
        c.body.includes('<!-- merge-manager-receipt -->')
      );
      expect(failedReceipts).toHaveLength(1);
      expect(failedReceipts[0]!.body).toContain(MERGE_SHA);
      const noticeFailures = logRecords(captured.lines, 'merge-coordinator.merge_notice_failed');
      expect(noticeFailures.some(r => r.channel === 'operator_mailbox')).toBe(true);
    } finally {
      captured.restore();
    }

    // Runtime merge manager path.
    const m = managerHarness();
    const result = await m.manager(RUN_RECORD);
    expect(result.status).toBe('executed');
    expect(m.mergePullRequest).not.toHaveBeenCalled();
    const managerReceipts = m.comments.filter(c =>
      c.body.includes('<!-- merge-manager-receipt -->')
    );
    expect(managerReceipts).toHaveLength(1);
    expect(managerReceipts[0]!.body).toContain(MERGE_SHA);
    expect(m.messages).toHaveLength(1);
    expect(m.messages[0]!.context).toEqual({ kind: 'system', sender: 'overseer' });
    expect(m.messages[0]!.data.recipient).toBe('operator');
    expect(m.messages[0]!.data.idempotency_key).toBe(
      `overseer:merge-receipt:${OWNER}/${REPO}#42@${MERGE_SHA}`
    );
    expect(m.messages[0]!.data.body).toContain(MERGE_SHA);
    expect(assessDispatchMessageBody('agent_message', m.messages[0]!.data.body).allowed).toBe(true);
    // Replay: the PR is already merged, so the second execution does not merge and sends nothing.
    m.setMergeResult({ merged: false, message: 'Pull Request is not mergeable' });
    await m.manager(RUN_RECORD);
    expect(m.messages).toHaveLength(1);
    expect(m.comments.filter(c => c.body.includes('<!-- merge-manager-receipt -->'))).toHaveLength(
      1
    );
    expect(m.mergePullRequest).not.toHaveBeenCalled();

    // Replay of a confirmed merge against the real dispatch store: the second notice carries the
    // same idempotency key, so the operator mailbox holds one message and the PR one receipt.
    await withIsolatedDatabase(async () => {
      const real = managerHarness(dispatch.createAuthenticatedMessage);
      expect((await real.manager(RUN_RECORD)).status).toBe('executed');
      expect((await real.manager(RUN_RECORD)).status).toBe('executed');
      const rows = await connection.getDatabase().query<{
        id: string;
        body: string;
      }>('SELECT id, body FROM agent_dispatch_messages WHERE idempotency_key = $1', [`overseer:merge-receipt:${OWNER}/${REPO}#42@${MERGE_SHA}`]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.body).toContain(MERGE_SHA);
      expect(
        real.comments.filter(c => c.body.includes('<!-- merge-manager-receipt -->'))
      ).toHaveLength(1);
    });

    // Runtime merge manager path, mailbox send fails: logged, PR receipt still posted.
    const capturedManager = captureRootLogLines();
    try {
      const mf = managerHarness(async () => {
        throw new Error('dispatch insert failed');
      });
      expect((await mf.manager(RUN_RECORD)).status).toBe('executed');
      expect(mf.comments.filter(c => c.body.includes(MERGE_SHA))).toHaveLength(1);
      const failures = logRecords(capturedManager.lines, 'merge-coordinator.merge_notice_failed');
      expect(failures.some(r => r.channel === 'operator_mailbox')).toBe(true);
    } finally {
      capturedManager.restore();
    }
  });

  test('Test 5: Approved docs-only path for bdc-harness dev, with hold and production exclusions', async () => {
    const docs = ['docs/operations/merge-manager.md'];
    const code = ['packages/overseer/src/x.ts'];
    const runCase = async (
      paths: string[],
      overrides: Partial<PullRequestEvidence>,
      conflict: ReviewConflictAtHead | null = null,
      qualified = true
    ) => {
      const h = bridgeHarness({
        rows: [verdict(`t5-${paths === docs ? 'docs' : 'code'}`)],
        evidence: () => green({ changedFilePaths: paths, ...overrides }),
        repoConfig: 'default',
        reviewConflictAtHead: async () => conflict,
        hasQualifiedReview: async () => qualified,
      });
      await runMergeExecutionBridgeOnce(h.options);
      return h;
    };

    // The eligible docs-only dev PR merges exactly once, with no policy-skip comment.
    const eligible = await runCase(docs, {});
    expect(eligible.counters.merges).toBe(1);
    expect(eligible.outcomes.map(o => o.reason)).toEqual(['merge_executed']);
    expect(eligible.comments.some(c => c.body.includes('<!-- merge-policy-skip:v1 -->'))).toBe(
      false
    );

    // Each gate gives a docs-only PR the same skip or release reason it gives a code PR.
    const variants: [string, Partial<PullRequestEvidence>, ReviewConflictAtHead | null, boolean][] =
      [
        ['held', { labels: ['merge-hold'] }, null, true],
        ['stale-approval', {}, null, false],
        ['failing-check', { checks: { total: 2, passed: 1, failed: 1, pending: 0 } }, null, true],
        ['no-checks', { checks: { total: 0, passed: 0, failed: 0, pending: 0 } }, null, true],
        ['conflict', {}, 'changes_requested', true],
      ];
    for (const [name, overrides, conflict, qualified] of variants) {
      const docsRun = await runCase(docs, overrides, conflict, qualified);
      const codeRun = await runCase(code, overrides, conflict, qualified);
      expect({ name, merges: docsRun.counters.merges }).toEqual({ name, merges: 0 });
      expect({ name, merges: codeRun.counters.merges }).toEqual({ name, merges: 0 });
      expect({ name, events: docsRun.events.map(e => `${e.kind}:${e.reason}`) }).toEqual({
        name,
        events: codeRun.events.map(e => `${e.kind}:${e.reason}`),
      });
      expect(docsRun.events.length).toBeGreaterThan(0);
    }

    // A docs-only PR to bdc-harness main: skipped, no approve or merge call.
    const harnessMain = await runCase(docs, { baseBranch: 'main' });
    expect(harnessMain.counters.merges).toBe(0);
    expect(harnessMain.counters.approvals).toBe(0);
    expect(['spec_only', 'integration_base_mismatch']).toContain(harnessMain.outcomes[0]?.reason);

    // A docs-only PR to a production base of another repo: skipped, no approve or merge call.
    const shopops = bridgeHarness({
      rows: [verdict('t5-shopops')],
      runRepo: 'shopops',
      evidence: () =>
        green({
          changedFilePaths: docs,
          baseBranch: 'master',
          htmlUrl: `https://github.com/${OWNER}/shopops/pull/7`,
          pr: { owner: OWNER, repo: 'shopops', number: 7 },
        }),
      repoConfig: 'default',
    });
    await runMergeExecutionBridgeOnce(shopops.options);
    expect(shopops.counters.merges).toBe(0);
    expect(shopops.counters.approvals).toBe(0);
    expect(['spec_only', 'integration_base_mismatch']).toContain(shopops.outcomes[0]?.reason);
  });

  test('Test 6: Older-head rows cannot fill the conflict page; a full page at the head still fails closed', async () => {
    const input = { owner: OWNER, repo: REPO, number: PR_NUMBER, headSha: HEAD };

    await withIsolatedDatabase(async () => {
      for (let i = 1; i <= 600; i += 1) await insertRequest(oldHead(i));
      await insertReceipt(HEAD, 'approved');
      expect(await realLookup()(input)).toBeNull();
      // A head row whose correlation id lacks the pr-review prefix is still read.
      await insertReceipt(HEAD, 'changes_requested', 'pr-review-receipt:delivery-6406');
      expect(await realLookup()(input)).toBe('changes_requested');
    });

    const captured = captureRootLogLines();
    try {
      await withIsolatedDatabase(async () => {
        for (let i = 0; i < 500; i += 1) await insertRequest(HEAD);
        expect(await realLookup()(input)).toBe('lookup_failed');
      });
      const causes = logRecords(
        captured.lines,
        'overseer.github_real_deps.review_conflict_lookup_failed'
      );
      expect(causes).toHaveLength(1);
      expect(causes[0]).toEqual(
        expect.objectContaining({
          cause: 'truncated',
          read: 'requests',
          rowCount: 500,
          owner: OWNER,
          repo: REPO,
          prNumber: PR_NUMBER,
          headSha: HEAD,
        })
      );
    } finally {
      captured.restore();
    }
  }, 180_000);

  test('Test 7: Policy snapshot is the recovery baseline plus harness dev docs-only and desk staging', () => {
    // Every entry as it was at bdc-harness dev 0a3c2e30, except:
    // - bdc-harness dev docsOnly (WO-HARNESS-MERGE-MANAGER-RECOVERY-01)
    // - receiving-shipping-desk staging (bdc-xo#5853; staging does not install a Workroom build)
    expect(JSON.parse(JSON.stringify(DEFAULT_MERGE_REPO_POLICY))).toEqual({
      'thinmansoftware/bdc-harness': {
        dev: { unattended: true, docsOnly: 'merge' },
        staging: { unattended: true, docsOnly: 'skip' },
        main: { unattended: false, docsOnly: 'skip' },
      },
      'thinmansoftware/shopops': {
        staging: { unattended: true, docsOnly: 'skip' },
        master: { unattended: false, docsOnly: 'skip' },
      },
      'thinmansoftware/lspro-react': {
        dev: { unattended: true, docsOnly: 'skip' },
        staging: { unattended: true, docsOnly: 'skip' },
        main: { unattended: false, docsOnly: 'skip' },
        'release/ce': { unattended: false, docsOnly: 'skip' },
      },
      'thinmansoftware/shopops-storefront': {
        staging: { unattended: true, docsOnly: 'skip' },
        master: { unattended: false, docsOnly: 'skip' },
      },
      'thinmansoftware/receiving-shipping-desk': {
        staging: { unattended: true, docsOnly: 'merge' },
      },
      'thinmansoftware/bdc-xo': {
        main: { unattended: true, docsOnly: 'merge' },
      },
      'thinmansoftware/bdc-shopify-app': {
        main: { unattended: false, docsOnly: 'skip' },
      },
      'thinmansoftware/comicstoreos-provisioner': {
        main: { unattended: true, docsOnly: 'skip' },
      },
    });
    // production_bases_match_merge_policy (m09-promotion-gate.test.ts) still holds.
    for (const [repo, bases] of Object.entries(DEFAULT_MERGE_REPO_POLICY))
      for (const [base, rule] of Object.entries(bases))
        if (!rule.unattended) expect(COVERED_PRODUCTION_BASES[repo]?.includes(base)).toBe(true);
    for (const [repo, bases] of Object.entries(COVERED_PRODUCTION_BASES))
      for (const base of bases)
        expect(DEFAULT_MERGE_REPO_POLICY[repo]?.[base]?.unattended).toBe(false);
  });

  test('Test 8: A lookup that fails once is retried and the PR merges on the next due tick', async () => {
    const run = async (holdOnRetry: boolean) => {
      const rows = [verdict(holdOnRetry ? 't8-hold' : 't8')];
      let lookups: string[] = [];
      let qualifiedReads = 0;
      let tick = 1;
      const h = bridgeHarness({
        rows,
        evidence: () => green({ labels: holdOnRetry && tick === 3 ? ['merge-hold'] : [] }),
        hasQualifiedReview: async () => {
          qualifiedReads += 1;
          return true;
        },
        reviewConflictAtHead: async input => {
          lookups = [...lookups, input.headSha];
          return lookups.length === 1 ? 'lookup_failed' : null;
        },
        retryMaxAttempts: 8,
      });

      // Tick 1 at T0.
      await runMergeExecutionBridgeOnce(h.options);
      expect(h.counters.merges).toBe(0);
      expect(h.slotReleases).toEqual([rows[0]!.id]);
      expect(h.deferrals).toEqual([
        {
          verdictId: rows[0]!.id,
          reason: 'review_conflict_at_head:lookup_failed',
          notBefore: new Date(T0.getTime() + 10 * 60 * 1000).toISOString(),
        },
      ]);
      expect(rows[0]!.merge_attempts).toBe(1);
      expect(h.outcomes).toEqual([]);

      // Tick 2 at T0 + 5 minutes: not due.
      tick = 2;
      h.setClock(new Date(T0.getTime() + 5 * 60 * 1000));
      await runMergeExecutionBridgeOnce(h.options);
      expect(h.claims).toHaveLength(1);
      expect(lookups).toHaveLength(1);

      // Tick 3 past merge_not_before.
      tick = 3;
      h.setClock(new Date(T0.getTime() + 11 * 60 * 1000));
      await runMergeExecutionBridgeOnce(h.options);
      expect(h.claims).toHaveLength(2);
      expect(h.counters.finds).toBe(2);
      expect(qualifiedReads).toBe(2);
      return { h, rows, lookups };
    };

    const { h, lookups } = await run(false);
    expect(lookups).toEqual([HEAD, HEAD]);
    expect(h.counters.merges).toBe(1);
    expect(h.outcomes.map(o => o.reason)).toEqual(['merge_executed']);

    // The hold checks read the fresh PR state on the retry: a hold added since tick 1 stops the merge.
    const held = await run(true);
    expect(held.h.counters.merges).toBe(0);
    expect(held.lookups).toHaveLength(1);
    expect(held.rows[0]!.merge_attempts).toBe(1);
    expect(held.h.outcomes).toEqual([]);
  });
});
