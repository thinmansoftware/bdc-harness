/**
 * WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01
 *
 * Unverified-approval handling end-to-end against the REAL dispatch + verdict
 * DAL on a per-test SqliteAdapter (same harness as
 * pr-review-wiring-integration.test.ts). An APPROVE the judge could not verify
 * must never merge: it posts a COMMENT (not an APPROVE), records a non-mergeable
 * verdict, triggers exactly one bounded re-review, and escalates to the Duty
 * Officer if the retry is also unverified.
 *
 * Anchor: PR #1118 (2026-10-14) merged an unverified approval unattended.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { rootLogger } from '@archon/paths';
import type { RealGitHubOctokitLike } from './adapters/github-real-deps.ts';
import type { PrReviewResult } from './pr-review-evaluator.ts';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

import * as realConnection from '@archon/core/db/connection';

mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => db,
}));

afterAll(() => {
  mock.restore();
});

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
const { createRealSubmitDeps, reviewSubjectKey, UNVERIFIED_APPROVAL_RETRY_REASON } =
  await import('./pr-review-wiring.ts');
const { runAndSubmitReview } = await import('./pr-review-submit.ts');

const HEAD = 'a'.repeat(40);
const OWNER = 'thinmansoftware';
const REPO = 'bdc-harness';
const PR = 55;

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

interface ReviewEventCapture {
  event: string;
  body: string;
}

// GitHub returns the review STATE, not the submitted event name.
const GITHUB_REVIEW_STATE: Record<string, string> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  COMMENT: 'COMMENTED',
};

function octokit(captured: ReviewEventCapture[], head = HEAD): RealGitHubOctokitLike {
  return {
    pulls: {
      get: async () => ({ data: { head: { sha: head } } }),
      createReview: async (input: { event: string; body: string }) => {
        captured.push({ event: input.event, body: input.body });
        return {
          data: { id: captured.length, state: GITHUB_REVIEW_STATE[input.event] ?? input.event },
        };
      },
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
  } as unknown as RealGitHubOctokitLike;
}

function result(verdict: PrReviewResult['verdict'], verificationReason?: string): PrReviewResult {
  return {
    verdict,
    findings: [],
    reviewed_head_sha: HEAD,
    reviewer: { provider: 'test-cli', model: 'test-model' },
    acceptance_criteria_available: false,
    ...(verificationReason ? { verification_reason: verificationReason } : {}),
  };
}

function work(messageId: string, head = HEAD) {
  return {
    correlationId: `pr-review:${OWNER}/${REPO}#${PR}@${head}`,
    messageId,
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    headSha: head,
    author: 'contributor',
  };
}

function deps(captured: ReviewEventCapture[], verdict: PrReviewResult['verdict'], reason?: string) {
  return createRealSubmitDeps('thinman-overseer[bot]', {
    octokit: octokit(captured),
    patOctokit: null,
    evaluate: async () => result(verdict, reason),
  });
}

async function verdictRows(): Promise<
  { verdict: string | null; proposed_action: string | null }[]
> {
  const rows = await db.query<{ verdict: string | null; proposed_action: string | null }>(
    'SELECT verdict, proposed_action FROM overseer_verdicts WHERE head_sha = $1',
    [HEAD]
  );
  return rows.rows;
}

async function dispatchRows(prefix: string): Promise<
  {
    recipient: string;
    sender: string;
    body: string;
    subject_key: string | null;
    correlation_id: string;
  }[]
> {
  const rows = await db.query<{
    recipient: string;
    sender: string;
    body: string;
    subject_key: string | null;
    correlation_id: string;
  }>(
    `SELECT recipient, sender, body, subject_key, correlation_id FROM agent_dispatch_messages WHERE idempotency_key LIKE $1`,
    [`${prefix}%`]
  );
  return rows.rows;
}

async function reviewWorkItems(): Promise<{ repeat_reason: string | null }[]> {
  const rows = await db.query<{ repeat_reason: string | null }>(
    `SELECT repeat_reason FROM agent_dispatch_messages
      WHERE recipient = 'overseer-reviewer' AND subject_key = $1 AND repeat_reason = $2`,
    [reviewSubjectKey(OWNER, REPO, PR), UNVERIFIED_APPROVAL_RETRY_REASON]
  );
  return rows.rows;
}

describe('unverified approval end-to-end (WO node-failure-repair)', () => {
  test('confirmed-hold logging redacts the verification reason', async () => {
    const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
      symbol => String(symbol) === 'Symbol(pino.stream)'
    )!;
    const stream = (rootLogger as unknown as Record<symbol, { write(chunk: string): unknown }>)[
      streamSymbol
    ];
    const write = stream.write;
    const captured: string[] = [];
    stream.write = chunk => {
      captured.push(chunk);
      return true;
    };
    try {
      const { handleUnverifiedApprovalOutcome } = await import('./pr-review-wiring');
      await handleUnverifiedApprovalOutcome({
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha: HEAD,
        verificationReason: 'sandbox unavailable token="synthetic-private-log"',
      });
    } finally {
      stream.write = write;
    }
    expect(captured.join('')).toContain('overseer.review.approved_unverified');
    expect(captured.join('')).toContain('[redacted]');
    expect(captured.join('')).not.toContain('synthetic-private-log');
  });

  test.each(['processing', 'merged'])(
    'a failed hold on %s custody persists two bounded notices without rewriting history',
    async state => {
      await runAndSubmitReview(work('verified-before-custody'), deps([], 'APPROVE'));
      await db.query(
        `UPDATE overseer_verdicts SET actioned_at = '2026-01-01',
        mutation_sent = 0, action_reason = $1`,
        [state]
      );
      const before = await db.query('SELECT * FROM overseer_verdicts');
      const { handleUnverifiedApprovalOutcome } = await import('./pr-review-wiring');
      const input = {
        owner: OWNER,
        repo: REPO,
        prNumber: PR,
        headSha: HEAD,
        verificationReason: 'sandbox unavailable token=synthetic-private',
      };
      await handleUnverifiedApprovalOutcome(input);
      await handleUnverifiedApprovalOutcome(input);
      expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
      const notices = await dispatchRows('overseer-review-unverified-hold-failed:');
      expect(notices.map(row => row.recipient).sort()).toEqual(['duty-officer', 'xo']);
      for (const notice of notices) {
        expect(notice.body).toContain(
          state === 'processing' ? 'merge_in_flight' : 'already_resolved'
        );
        expect(notice.body).toContain('Hold was not confirmed');
        expect(notice.body).not.toContain('synthetic-private');
        expect(notice.body).not.toContain('merge was prevented');
      }
      const priorities = await db.query<{ priority: string }>(
        "SELECT priority FROM agent_dispatch_messages WHERE idempotency_key LIKE 'overseer-review-unverified-hold-failed:%'"
      );
      expect(priorities.rows.map(row => row.priority)).toEqual(['blocker', 'blocker']);
    }
  );

  test.each(['status', 'pr', 'mutation', 'reason', 'merge'])(
    'an apparent held verdict with invalid %s does not confirm the hold',
    async field => {
      await runAndSubmitReview(work('held-before-invalid'), deps([], 'APPROVE_UNVERIFIED'));
      const edits: Record<string, string> = {
        status: "status = 'claimed'",
        pr: "pr_url = 'https://github.com/other/repo/pull/1'",
        mutation: 'mutation_sent = 0',
        reason: "action_reason = 'other'",
        merge: "merge_sha = 'old'",
      };
      await db.query(`UPDATE overseer_verdicts SET ${edits[field]}`);
      const before = await db.query('SELECT * FROM overseer_verdicts');
      const { recordUnverifiedApprovalVerdict } = await import('./pr-review-wiring');
      await expect(
        recordUnverifiedApprovalVerdict({
          owner: OWNER,
          repo: REPO,
          prNumber: PR,
          headSha: HEAD,
        })
      ).rejects.toThrow('unverified_approval_hold_not_confirmed');
      expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
    }
  );

  test('failed-hold notices precede retry lookup and attempt recipients independently', async () => {
    const dispatch = await import('@archon/core/db/dispatch');
    const originalCreate = dispatch.createAuthenticatedMessage;
    const attempts: string[] = [];
    const create = spyOn(dispatch, 'createAuthenticatedMessage').mockImplementation(
      async (sender, data) => {
        attempts.push(data.recipient);
        if (data.recipient === 'duty-officer') throw new Error('fixture notice unavailable');
        return originalCreate(sender, data);
      }
    );
    const lookup = spyOn(dispatch, 'listMessages').mockImplementation(async () => {
      throw new Error('fixture retry lookup unavailable');
    });
    try {
      const { handleUnverifiedApprovalOutcome } = await import('./pr-review-wiring');
      await handleUnverifiedApprovalOutcome(
        { owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD },
        {
          recordVerdict: async () => {
            throw new Error('private provider detail');
          },
        }
      );
      expect(attempts).toEqual(['duty-officer', 'xo']);
      const notices = await dispatchRows('overseer-review-unverified-hold-failed:');
      expect(notices.map(row => row.recipient)).toEqual(['xo']);
      expect(notices[0]?.body).toContain('record_failed');
      expect(notices[0]?.body).not.toContain('private provider detail');
    } finally {
      lookup.mockRestore();
      create.mockRestore();
    }
  });

  test('confirmed holds and the disabled recording switch do not emit failed-hold notices', async () => {
    const { handleUnverifiedApprovalOutcome } = await import('./pr-review-wiring');
    const input = { owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD };
    await handleUnverifiedApprovalOutcome(input);
    await handleUnverifiedApprovalOutcome(input, {
      env: { OVERSEER_REVIEW_RECORDS_VERDICT: 'false' },
      recordVerdict: async () => {
        throw new Error('must not execute');
      },
    });
    expect(await dispatchRows('overseer-review-unverified-hold-failed:')).toHaveLength(0);
  });

  test('unverified observation holds a fresh verified claim before its finalization', async () => {
    const { recordReviewApprovalVerdict, recordUnverifiedApprovalVerdict } =
      await import('./pr-review-wiring');
    const { claimOverseerVerdict, finalizeOverseerVerdict } =
      await import('@archon/core/db/overseer');
    const input = { owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD };
    await expect(
      recordReviewApprovalVerdict(input, {
        claimVerdict: claimOverseerVerdict,
        finalizeVerdict: async value => {
          await recordUnverifiedApprovalVerdict(input);
          return finalizeOverseerVerdict(value);
        },
      })
    ).rejects.toThrow('overseer_verdict_finalize_claim_lost');
    expect(await verdictRows()).toEqual([
      { verdict: 'approved_unverified', proposed_action: 'none' },
    ]);
  });

  test.each(['semantic', 'health'] as const)(
    'judge-first %s finalization cannot overwrite a fresh hold or act afterward',
    async kind => {
      const { handleRecordJudgeFirst } = await import('./judge-first-pipeline');
      const { recordUnverifiedApprovalVerdict } = await import('./pr-review-wiring');
      const { claimOverseerVerdict, finalizeOverseerVerdict } =
        await import('@archon/core/db/overseer');
      let actions = 0;
      const unavailable = async (): Promise<never> => {
        throw new Error('unexpected downstream action');
      };
      await expect(
        handleRecordJudgeFirst(
          {
            runId: `pr-discovery:${OWNER}/${REPO}#${PR}`,
            woId: 'WO-TEST-01',
            owner: OWNER,
            repo: REPO,
            status: 'completed',
            action: 'merge_ready',
            reason: 'test evidence',
            prEvidence: {
              exists: true,
              state: 'open',
              headSha: HEAD,
              checks: { total: 0, passed: 0, failed: 0, pending: 0 },
              mergeable: true,
            },
          },
          {
            listRunsForWatch: async () => [],
            listRunEvents: async () => [],
            insertOverseerAction: async () => {
              actions++;
            },
            findPullRequest: unavailable,
            mergePullRequest: unavailable,
          },
          {
            dryRun: false,
            actor: 'test',
            maxRetries: 0,
            verdictStore: {
              claimVerdict: claimOverseerVerdict,
              finalizeVerdict: finalizeOverseerVerdict,
            },
            judge: async () => {
              await recordUnverifiedApprovalVerdict({
                owner: OWNER,
                repo: REPO,
                prNumber: PR,
                headSha: HEAD,
              });
              return kind === 'semantic'
                ? {
                    kind: 'verdict',
                    verdict: 'merge_candidate',
                    confidence: 0.9,
                    proposedAction: 'flag_merge_ready',
                    proposedTier: 0,
                    reason: 'fixture',
                    model: 'test',
                    modelRung: 0,
                  }
                : { kind: 'judge_unavailable', reason: 'fixture', model: 'test', modelRung: 0 };
            },
            escalate: unavailable,
          }
        )
      ).rejects.toThrow('overseer_verdict_finalize_claim_lost');
      expect(actions).toBe(0);
      expect(await verdictRows()).toEqual([
        { verdict: 'approved_unverified', proposed_action: 'none' },
      ]);
    }
  );

  test.each([
    'wrong-run',
    'wrong-head',
    'wrong-pr',
    'noncanonical-pr',
    'semantic',
    'action',
    'model',
    'digest',
    'evidence',
    'actioned',
    'mutation',
    'reason',
    'merge',
  ])('claimed-slot hold preserves ineligible %s evidence', async kind => {
    const { claimOverseerVerdict, transitionReviewApprovalVerification } =
      await import('@archon/core/db/overseer');
    const runId = `pr-discovery:${OWNER}/${REPO}#${PR}`;
    await claimOverseerVerdict({ runId, woId: runId, headSha: HEAD });
    const edits: Record<string, string> = {
      'wrong-pr': "pr_url = 'https://github.com/other/repo/pull/9'",
      semantic: "verdict = 'merge_candidate'",
      action: "proposed_action = 'flag_merge_ready'",
      model: "model = 'other-owner'",
      digest: "evidence_digest = 'other-owner'",
      evidence: "evidence = 'other-owner'",
      actioned: "actioned_at = '2026-01-01'",
      mutation: 'mutation_sent = 0',
      reason: "action_reason = 'processing'",
      merge: "merge_sha = 'old'",
    };
    if (edits[kind]) await db.query(`UPDATE overseer_verdicts SET ${edits[kind]}`);
    const before = await db.query('SELECT * FROM overseer_verdicts');
    expect(
      await transitionReviewApprovalVerification({
        runId: kind === 'wrong-run' ? 'pr-discovery:other/repo#55' : runId,
        headSha: kind === 'wrong-head' ? 'other' : HEAD,
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/${kind === 'noncanonical-pr' ? 56 : PR}`,
        verified: false,
      })
    ).toBe(false);
    expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
  });

  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-unverified-approval-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  test.each(['verdict', 'health', 'actioned', 'mutation', 'reason', 'merge'])(
    'shared finalizer refuses lost %s state without rewriting it',
    async kind => {
      const { claimOverseerVerdict, finalizeOverseerVerdict } =
        await import('@archon/core/db/overseer');
      const runId = `pr-discovery:${OWNER}/${REPO}#${PR}`;
      const claim = await claimOverseerVerdict({ runId, woId: runId, headSha: HEAD });
      const edit: Record<string, string> = {
        verdict: "status = 'verdict'",
        health: "status = 'judge_unavailable'",
        actioned: "actioned_at = '2026-01-01'",
        mutation: 'mutation_sent = 0',
        reason: "action_reason = 'processing'",
        merge: "merge_sha = 'old'",
      };
      await db.query(`UPDATE overseer_verdicts SET ${edit[kind]}`);
      const before = await db.query('SELECT * FROM overseer_verdicts');
      await expect(
        finalizeOverseerVerdict({
          verdictId: claim.verdictId!,
          status: 'verdict',
          verdict: 'merge_candidate',
          proposedAction: 'flag_merge_ready',
        })
      ).rejects.toThrow('overseer_verdict_finalize_claim_lost');
      expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
    }
  );

  test('verified observation cannot promote a neutral claim it did not win', async () => {
    const { claimOverseerVerdict } = await import('@archon/core/db/overseer');
    const { recordReviewApprovalVerdict } = await import('./pr-review-wiring');
    const runId = `pr-discovery:${OWNER}/${REPO}#${PR}`;
    await claimOverseerVerdict({ runId, woId: runId, headSha: HEAD });
    const before = await db.query('SELECT * FROM overseer_verdicts');
    await recordReviewApprovalVerdict({ owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD });
    expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
  });
  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('18 unverified approval posts a COMMENT (not APPROVE) and records a non-mergeable verdict', async () => {
    const captured: ReviewEventCapture[] = [];
    const outcome = await runAndSubmitReview(
      work('msg-18'),
      deps(captured, 'APPROVE_UNVERIFIED', 'sandbox failed to start')
    );
    expect(outcome.disposition).toBe('approved_unverified');
    // No APPROVE event; exactly one COMMENT beginning 'UNVERIFIED approval'.
    expect(captured.some(c => c.event === 'APPROVE')).toBe(false);
    const comments = captured.filter(c => c.event === 'COMMENT');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.startsWith('UNVERIFIED approval')).toBe(true);
    // Verdict table: one approved_unverified / none, zero flag_merge_ready.
    const rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('approved_unverified');
    expect(rows[0]!.proposed_action).toBe('none');
    expect(rows.filter(r => r.proposed_action === 'flag_merge_ready')).toHaveLength(0);
  });

  test('20 a verified approval keeps disposition approved and records flag_merge_ready', async () => {
    const captured: ReviewEventCapture[] = [];
    const outcome = await runAndSubmitReview(work('msg-20'), deps(captured, 'APPROVE'));
    expect(outcome.disposition).toBe('approved');
    expect(captured.some(c => c.event === 'APPROVE')).toBe(true);
    const rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_action).toBe('flag_merge_ready');
  });

  test('21 first unverified approval triggers exactly one re-review; repeat does not add another', async () => {
    await runAndSubmitReview(work('msg-21a'), deps([], 'APPROVE_UNVERIFIED', 'sandbox failed'));
    expect(await reviewWorkItems()).toHaveLength(1);
    // Second unverified approval on the same head -> still exactly one re-review.
    await runAndSubmitReview(
      work('msg-21b'),
      deps([], 'APPROVE_UNVERIFIED', 'sandbox failed again')
    );
    expect(await reviewWorkItems()).toHaveLength(1);
    // A retry that comes back verified proceeds to disposition 'approved'.
    const captured: ReviewEventCapture[] = [];
    const outcome = await runAndSubmitReview(work('msg-21c'), deps(captured, 'APPROVE'));
    expect(outcome.disposition).toBe('approved');
    const rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('merge_candidate');
    expect(rows[0]?.proposed_action).toBe('flag_merge_ready');
    const { listUnactionedFlagMergeReadyVerdicts, claimVerdictForMergeExecution } =
      await import('@archon/core/db/overseer');
    const ready = await listUnactionedFlagMergeReadyVerdicts();
    expect(ready).toHaveLength(1);
    expect(await claimVerdictForMergeExecution(ready[0]!.id)).toBe(true);
  });

  test('22 a repeated unverified approval writes exactly one duty-officer message', async () => {
    const prefix = `overseer-review-unverified:${OWNER}/${REPO}#${PR}:${HEAD}`;
    // First unverified approval: enqueues the retry, no escalation yet.
    await runAndSubmitReview(work('msg-22a'), deps([], 'APPROVE_UNVERIFIED', 'sandbox failed'));
    expect(await dispatchRows(prefix)).toHaveLength(0);
    // Retry (same head) also unverified -> exactly one duty-officer escalation.
    await runAndSubmitReview(
      work('msg-22b'),
      deps([], 'APPROVE_UNVERIFIED', 'still could not verify')
    );
    const rows = await dispatchRows(prefix);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('duty-officer');
    expect(rows[0]!.sender).toBe('overseer');
    expect(rows[0]!.subject_key).toBe(`gh:${OWNER}/${REPO}#${PR}`);
    expect(rows[0]!.correlation_id).toBe(HEAD);
    expect(rows[0]!.body).toContain(String(PR));
    expect(rows[0]!.body).toContain(HEAD);
    // BOTH reasons appear: the first (persisted on the retry row) and the latest.
    expect(rows[0]!.body).toContain('sandbox failed');
    expect(rows[0]!.body).toContain('still could not verify');
    expect(rows[0]!.body).toContain('first reason:');
    expect(rows[0]!.body).toContain('latest reason:');
    // A third unverified pass creates no second row.
    await runAndSubmitReview(work('msg-22c'), deps([], 'APPROVE_UNVERIFIED', 'again'));
    expect(await dispatchRows(prefix)).toHaveLength(1);
  });

  test('23 an unverified approval neutralizes an already-recorded flag_merge_ready verdict', async () => {
    // A verified approval records a merge-ready verdict for this head...
    await runAndSubmitReview(work('msg-23a'), deps([], 'APPROVE'));
    let rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.proposed_action).toBe('flag_merge_ready');

    // ...then a LATER review of the SAME head comes back unverified. The
    // (run_id, head_sha) slot is already taken, so the held verdict cannot be
    // inserted alongside -- the existing merge-ready row must be downgraded in
    // place so the merge bridge can no longer act on it.
    await runAndSubmitReview(work('msg-23b'), deps([], 'APPROVE_UNVERIFIED', 'sandbox failed'));
    rows = await verdictRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('approved_unverified');
    expect(rows[0]!.proposed_action).toBe('none');
    expect(rows.filter(r => r.proposed_action === 'flag_merge_ready')).toHaveLength(0);
  });

  test('23b a merge-claimed row is NOT rewritten, and the hold is reported as lost', async () => {
    // A verified approval records the merge-ready verdict...
    await runAndSubmitReview(work('msg-23b1'), deps([], 'APPROVE'));
    let rows = await db.query<{ id: string; action_reason: string | null }>(
      'SELECT id, action_reason FROM overseer_verdicts WHERE head_sha = $1',
      [HEAD]
    );
    expect(rows.rows).toHaveLength(1);
    const verdictId = rows.rows[0]!.id;

    // ...and the merge bridge CLAIMS it (actioned_at set, action_reason
    // 'processing') before the later review comes back unverified. The bridge now
    // holds that row in memory, so rewriting the database row here cannot stop the
    // in-flight merge and would corrupt the bridge's state machine, whose
    // recordOutcome UPDATE is predicated on action_reason = 'processing'.
    const { claimVerdictForMergeExecution } = await import('@archon/core/db/overseer');
    expect(await claimVerdictForMergeExecution(verdictId)).toBe(true);

    await runAndSubmitReview(work('msg-23b2'), deps([], 'APPROVE_UNVERIFIED', 'sandbox failed'));

    // The claimed row is left intact for the bridge to resolve -- NOT downgraded
    // underneath it, and NOT silently treated as if the hold had been applied.
    rows = await db.query<{ id: string; action_reason: string | null }>(
      'SELECT id, action_reason FROM overseer_verdicts WHERE head_sha = $1',
      [HEAD]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.action_reason).toBe('processing');

    // The unverified outcome still escalates: the bounded re-review is enqueued.
    expect(await reviewWorkItems()).toHaveLength(1);
  });

  test.each([
    'wrong-run',
    'wrong-head',
    'wrong-pr',
    'status',
    'verdict',
    'action',
    'actioned',
    'mutation',
    'reason',
    'merge',
  ])('held promotion preserves ineligible %s evidence', async kind => {
    await runAndSubmitReview(work('held'), deps([], 'APPROVE_UNVERIFIED', 'fixture unavailable'));
    const edits: Record<string, string> = {
      status: "status = 'claimed'",
      verdict: "verdict = 'CHANGES_REQUESTED'",
      action: "proposed_action = 'other'",
      actioned: "actioned_at = '2026-01-01'",
      mutation: 'mutation_sent = 0',
      reason: "action_reason = 'processing'",
      merge: "merge_sha = 'merged-fixture'",
    };
    if (edits[kind]) await db.query(`UPDATE overseer_verdicts SET ${edits[kind]}`);
    const before = await db.query('SELECT * FROM overseer_verdicts');
    const { transitionReviewApprovalVerification } = await import('@archon/core/db/overseer');
    expect(
      await transitionReviewApprovalVerification({
        runId:
          kind === 'wrong-run'
            ? 'pr-discovery:other/repo#55'
            : `pr-discovery:${OWNER}/${REPO}#${PR}`,
        headSha: kind === 'wrong-head' ? 'other-head' : HEAD,
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/${kind === 'wrong-pr' ? 56 : PR}`,
        verified: true,
      })
    ).toBe(false);
    expect((await db.query('SELECT * FROM overseer_verdicts')).rows).toEqual(before.rows);
  });

  test('merge claim winning at the conditional downgrade boundary is never overwritten', async () => {
    await runAndSubmitReview(work('before-race'), deps([], 'APPROVE'));
    const {
      claimOverseerVerdict,
      finalizeOverseerVerdict,
      claimVerdictForMergeExecution,
      transitionReviewApprovalVerification,
    } = await import('@archon/core/db/overseer');
    const { recordUnverifiedApprovalVerdict } = await import('./pr-review-wiring');
    const row = (await db.query<{ id: string }>('SELECT id FROM overseer_verdicts')).rows[0]!;
    await expect(
      recordUnverifiedApprovalVerdict(
        { owner: OWNER, repo: REPO, prNumber: PR, headSha: HEAD },
        {
          claimVerdict: claimOverseerVerdict,
          finalizeVerdict: finalizeOverseerVerdict,
          transitionVerification: async input => {
            expect(await claimVerdictForMergeExecution(row.id)).toBe(true);
            return transitionReviewApprovalVerification(input);
          },
        }
      )
    ).rejects.toThrow('unverified_approval_hold_not_confirmed:merge_in_flight');
    const after = (
      await db.query<{ verdict: string; action_reason: string; proposed_action: string }>(
        'SELECT verdict, action_reason, proposed_action FROM overseer_verdicts'
      )
    ).rows[0]!;
    expect(after).toEqual({
      verdict: 'merge_candidate',
      proposed_action: 'flag_merge_ready',
      action_reason: 'processing',
    });
  });

  test('22 the verified path writes no duty-officer unverified escalation', async () => {
    const prefix = `overseer-review-unverified:${OWNER}/${REPO}#${PR}:${HEAD}`;
    await runAndSubmitReview(work('msg-22v'), deps([], 'APPROVE'));
    expect(await dispatchRows(prefix)).toHaveLength(0);
  });
});
