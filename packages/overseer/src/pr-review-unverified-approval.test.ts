import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { parseReviewVerdict } from './pr-review-evaluator';
import * as connection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as verdictStore from '@archon/core/db/overseer';
import { createRealSubmitDeps, recordReviewApprovalVerdict } from './pr-review-wiring';
import { runAndSubmitReview, type SubmitDeps } from './pr-review-submit';
import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import {
  runMergeExecutionBridgeOnce,
  type MergeExecutionBridgeStore,
} from './merge-execution-bridge';
import type { GitHubClientDeps } from './types';

const output = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    verdict: 'APPROVE',
    verification: 'verified',
    verification_reason: '',
    findings: [],
    reviewed_head_sha: 'abc',
    ...extra,
  });

describe('unverified approvals', () => {
  test('judge_verification_field_parsed_and_required', () => {
    expect(parseReviewVerdict(output({}))?.verdict).toBe('APPROVE');
    expect(
      parseReviewVerdict(output({ verification: 'unverified', verification_reason: 'no sandbox' }))
        ?.verdict
    ).toBe('APPROVE_UNVERIFIED');
    expect(
      parseReviewVerdict(
        JSON.stringify({ verdict: 'APPROVE', findings: [], reviewed_head_sha: 'abc' })
      )
    ).toBeNull();
  });
  test('sandbox_failure_note_forces_unverified_even_if_judge_says_verified', () => {
    const findings = [
      {
        scope: 'Validation',
        severity: 'note',
        summary:
          'Local inspection and test execution were unavailable because the execution sandbox failed to start',
      },
    ];
    expect(parseReviewVerdict(output({ findings }))?.verdict).toBe('APPROVE_UNVERIFIED');
  });
  test('positive sandbox findings do not invalidate a verified approval', () => {
    for (const summary of [
      'Sandbox isolation tests passed at the exact head',
      'The sandbox started and all required tests passed',
    ]) {
      expect(
        parseReviewVerdict(
          output({ findings: [{ scope: 'Validation', severity: 'note', summary }] })
        )?.verdict
      ).toBe('APPROVE');
    }
  });
});

describe('unverified approval persistence and execution', () => {
  let db: SqliteAdapter;
  const head = 'a'.repeat(40);
  const prUrl = 'https://github.com/thinmansoftware/bdc-harness/pull/55';
  const work = {
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 55,
    headSha: head,
    author: 'builder',
    messageId: 'review-1',
    correlationId: 'correlation-1',
  };
  const receipt = {
    ...work,
    disposition: 'approved_unverified' as const,
    reason: 'sandbox unavailable',
  };

  beforeEach(() => {
    db = new SqliteAdapter(':memory:');
    spyOn(connection, 'getDatabase').mockReturnValue(db);
  });
  afterEach(async () => {
    mock.restore();
    await db.close();
  });

  async function reviewRequest(label: string): Promise<typeof work> {
    const message = await createAuthenticatedMessage(
      { kind: 'system', sender: 'overseer' },
      {
        task_type: 'run_review',
        recipient: 'overseer-reviewer',
        subject_key: 'gh:thinmansoftware/bdc-harness#55',
        repeat_reason: 'test_review_order',
        correlation_id: head,
        idempotency_key: `test-review-request:${label}`,
        body: JSON.stringify({ ...work, headCiGreen: true }),
      }
    );
    return { ...work, messageId: message.id };
  }

  const realSubmit = (): SubmitDeps =>
    createRealSubmitDeps('thinman-overseer[bot]', {
      octokit: {} as never,
      patOctokit: null,
    });

  async function bridge(): Promise<{ merges: number; reasons: string[] }> {
    const observed = { merges: 0, reasons: [] as string[] };
    const store: MergeExecutionBridgeStore = {
      listUnactionedVerdicts: verdictStore.listUnactionedFlagMergeReadyVerdicts,
      claimVerdict: verdictStore.claimVerdictForMergeExecution,
      releaseVerdictClaim: async (id, reason) => {
        observed.reasons.push(reason);
        return verdictStore.releaseVerdictClaimForMergeExecution(id, reason);
      },
      getRunById: async () => null,
      hasUnverifiedApprovalForHead: verdictStore.hasUnverifiedApprovalForHead,
      reserveMergeSlot: async () => true,
      releaseMergeSlot: async () => {},
      recordOutcome: verdictStore.recordVerdictMergeOutcome,
    };
    const github = {
      findPullRequest: async () => ({
        exists: true,
        state: 'open',
        headSha: head,
        htmlUrl: prUrl,
        baseBranch: 'dev',
        mergeable: true,
        mergeableState: 'clean',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        changedFilePaths: ['packages/overseer/src/code.ts'],
        pr: { owner: work.owner, repo: work.repo, number: 55 },
      }),
      approvePullRequest: async () => ({ approved: true }),
      mergePullRequest: async () => {
        observed.merges += 1;
        return { merged: true, mergeSha: 'merged' };
      },
    } as unknown as GitHubClientDeps;
    await runMergeExecutionBridgeOnce({
      store,
      github,
      repoConfig: { 'thinmansoftware/bdc-harness': { baseBranch: 'dev' } },
      readPolicy: () => ({
        service_enabled: true,
        emergency_stop: false,
        legacy_dry_run: false,
        capability_flags: {
          merge: true,
          repair: false,
          branch: false,
          lifecycle: false,
          escalation: false,
        },
      }),
    });
    return observed;
  }

  test('unverified_approval_posts_no_approve_and_records_nonmergeable_verdict', async () => {
    const submitted: string[] = [];
    const deps = realSubmit();
    deps.currentHeadSha = async () => head;
    deps.runReviewer = async () => ({
      approved: false,
      approvedUnverified: true,
      summary: 'sandbox unavailable',
      reviewedHeadSha: head,
    });
    deps.submitReview = async input => {
      submitted.push(input.event);
      return { submitted: true };
    };
    const result = await runAndSubmitReview(work, deps);
    expect(result.disposition).toBe('approved_unverified');
    expect(submitted).toEqual(['COMMENT']);
    const rows = await db.query<{ verdict: string; proposed_action: string }>(
      'SELECT verdict, proposed_action FROM overseer_verdicts'
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ verdict: 'approved_unverified', proposed_action: 'none' }),
      expect.objectContaining({ verdict: 'approved_unverified', proposed_action: 'none' }),
    ]);
  });

  test('merge_bridge_skips_unverified_and_logs_reason', async () => {
    await recordReviewApprovalVerdict({ ...work, disposition: 'approved_unverified' });
    const runId = 'pr-discovery:thinmansoftware/bdc-harness#55:older-run';
    await verdictStore.ensureDiscoveryRunRow(runId);
    await db.query(
      `INSERT INTO overseer_verdicts (id,run_id,wo_id,head_sha,status,verdict,proposed_action,pr_url)
      VALUES ('old-ready',$1,'WO-3239',$2,'verdict','merge_candidate','flag_merge_ready',$3)`,
      [runId, head, prUrl]
    );
    const result = await bridge();
    expect(result.merges).toBe(0);
    expect(result.reasons).toEqual(['approval_unverified']);
    expect(
      await verdictStore.hasUnverifiedApprovalForHead({
        run_id: runId,
        head_sha: 'b'.repeat(40),
        pr_url: prUrl,
      } as verdictStore.OverseerVerdictRow)
    ).toBe(false);
  });

  for (const failure of ['throws', 'rejects']) {
    test(`unverified evidence precedes a comment that ${failure} and still blocks merging`, async () => {
      const deps = realSubmit();
      deps.currentHeadSha = async () => head;
      deps.runReviewer = async () => ({
        approved: false,
        approvedUnverified: true,
        summary: 'sandbox unavailable',
        reviewedHeadSha: head,
      });
      const runId = `pr-discovery:thinmansoftware/bdc-harness#55:${failure}`;
      await verdictStore.ensureDiscoveryRunRow(runId);
      await db.query(
        `INSERT INTO overseer_verdicts
        (id,run_id,wo_id,head_sha,status,verdict,proposed_action,pr_url)
        VALUES ('old-ready',$1,'WO-3239',$2,'verdict','merge_candidate','flag_merge_ready',$3)`,
        [runId, head, prUrl]
      );
      const candidate = (await verdictStore.listUnactionedFlagMergeReadyVerdicts())[0];
      expect(candidate).toBeDefined();
      let persistedBeforeComment = false;
      deps.submitReview = async () => {
        persistedBeforeComment = await verdictStore.hasUnverifiedApprovalForHead(candidate);
        if (failure === 'throws') throw new Error('synthetic comment failure');
        return { submitted: false, message: 'synthetic rejected comment' };
      };
      const result = await runAndSubmitReview(work, deps);
      expect(result.disposition).toBe('submission_failed');
      expect(persistedBeforeComment).toBe(true);
      expect(await verdictStore.hasUnverifiedApprovalForHead(candidate)).toBe(true);
      const execution = await bridge();
      expect(execution.merges).toBe(0);
      expect(execution.reasons).toContain('approval_unverified');
    });
  }

  test('unverified persistence failure prevents GitHub submission', async () => {
    const deps = realSubmit();
    deps.currentHeadSha = async () => head;
    deps.runReviewer = async () => ({
      approved: false,
      approvedUnverified: true,
      summary: 'sandbox unavailable',
      reviewedHeadSha: head,
    });
    deps.recordUnverifiedApproval = async () => {
      throw new Error('synthetic storage failure');
    };
    let submissions = 0;
    deps.submitReview = async () => {
      submissions += 1;
      return { submitted: true };
    };
    const result = await runAndSubmitReview(work, deps);
    expect(result.reason).toBe('unverified_approval_persistence_failed');
    expect(submissions).toBe(0);
  });

  test('verified_approval_still_merges_as_before', async () => {
    const negative = await reviewRequest('initial-unverified');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    const retry = await reviewRequest('verified-retry');
    await recordReviewApprovalVerdict({ ...retry, disposition: 'approved' });
    const result = await bridge();
    expect(result.merges).toBe(1);
    const rows = await db.query<{ mutation_sent: number }>(
      "SELECT mutation_sent FROM overseer_verdicts WHERE proposed_action='flag_merge_ready'"
    );
    expect(rows.rows[0].mutation_sent).toBe(1);
  });
  test('old verified approval redelivery cannot clear a newer unverified review', async () => {
    const older = await reviewRequest('old-verified');
    await recordReviewApprovalVerdict({ ...older, disposition: 'approved' });
    const negative = await reviewRequest('new-unverified');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    await recordReviewApprovalVerdict({ ...older, disposition: 'approved' });
    expect((await bridge()).merges).toBe(0);
    const holds = await db.query<{ id: string }>(
      "SELECT id FROM overseer_verdicts WHERE verdict='approved_unverified'"
    );
    expect(holds.rowCount).toBeGreaterThan(0);
  });

  test('verified redelivery finishes an interrupted evidence-resolution transition', async () => {
    const negative = await reviewRequest('negative-before-interruption');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    const retry = await reviewRequest('verified-before-interruption');
    let failed = false;
    try {
      await recordReviewApprovalVerdict(
        { ...retry, disposition: 'approved' },
        {
          persistUnverifiedEvidence: verdictStore.recordUnverifiedApprovalEvidence,
          resolveUnverifiedEvidence: verdictStore.resolveUnverifiedApprovalEvidence,
          finalizeVerdict: verdictStore.finalizeOverseerVerdict,
          reviseVerdict: verdictStore.reviseOverseerReviewVerdict,
          claimVerdict: async () => {
            throw new Error('synthetic interruption after resolution');
          },
        }
      );
    } catch (error) {
      failed = true;
      expect((error as Error).message).toBe('synthetic interruption after resolution');
    }
    expect(failed).toBe(true);
    const evidence = await db.query<{ verdict: string }>(
      "SELECT verdict FROM overseer_verdicts WHERE run_id LIKE '%:unverified:%'"
    );
    expect(evidence.rows[0].verdict).toBe('approval_verified');
    await recordReviewApprovalVerdict({ ...retry, disposition: 'approved' });
    expect((await bridge()).merges).toBe(1);
  });

  test('same or missing review identity cannot resolve an unverified observation', async () => {
    const negative = await reviewRequest('negative-identity');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    for (const messageId of [negative.messageId, 'missing-review-request']) {
      await recordReviewApprovalVerdict({ ...work, messageId, disposition: 'approved' });
      expect((await bridge()).merges).toBe(0);
    }
  });

  test.each([
    'negative-task',
    'verified-recipient',
    'negative-null-seq',
    'verified-null-seq',
    'equal-order',
    'malformed-payload',
    'foreign-owner',
    'foreign-repo',
    'foreign-pr',
    'foreign-head',
    'malformed-evidence',
    'foreign-evidence-id',
    'foreign-evidence-head',
    'foreign-evidence-url',
  ])('invalid %s cannot clear negative evidence', async fault => {
    const negative = await reviewRequest('negative');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    const retry = await reviewRequest('retry');
    const evidenceRun = `pr-discovery:thinmansoftware/bdc-harness#55:unverified:${negative.messageId}`;
    if (fault === 'negative-task') {
      await db.query("UPDATE agent_dispatch_messages SET task_type='agent_message' WHERE id=$1", [
        negative.messageId,
      ]);
    } else if (fault === 'verified-recipient') {
      await db.query("UPDATE agent_dispatch_messages SET recipient='operator' WHERE id=$1", [
        retry.messageId,
      ]);
    } else if (fault.endsWith('null-seq')) {
      await db.query('UPDATE agent_dispatch_messages SET seq=NULL WHERE id=$1', [
        fault === 'negative-null-seq' ? negative.messageId : retry.messageId,
      ]);
    } else if (fault === 'equal-order') {
      await db.query(
        'UPDATE agent_dispatch_messages SET seq=(SELECT seq FROM agent_dispatch_messages WHERE id=$1) WHERE id=$2',
        [negative.messageId, retry.messageId]
      );
    } else if (fault === 'malformed-evidence' || fault.startsWith('foreign-evidence')) {
      const evidence = {
        disposition: 'approved_unverified',
        reviewId: negative.messageId,
        headSha: head,
        prUrl,
        ...(fault === 'foreign-evidence-id' ? { reviewId: retry.messageId } : {}),
        ...(fault === 'foreign-evidence-head' ? { headSha: 'b'.repeat(40) } : {}),
        ...(fault === 'foreign-evidence-url' ? { prUrl: prUrl + '0' } : {}),
      };
      await db.query('UPDATE overseer_verdicts SET evidence=$1 WHERE run_id=$2', [
        fault === 'malformed-evidence' ? '{}' : JSON.stringify(evidence),
        evidenceRun,
      ]);
    } else {
      const body = {
        ...work,
        ...(fault === 'foreign-owner' ? { owner: 'foreign' } : {}),
        ...(fault === 'foreign-repo' ? { repo: 'foreign' } : {}),
        ...(fault === 'foreign-pr' ? { prNumber: 56 } : {}),
        ...(fault === 'foreign-head' ? { headSha: 'b'.repeat(40) } : {}),
      };
      await db.query('UPDATE agent_dispatch_messages SET body=$1 WHERE id=$2', [
        fault === 'malformed-payload' ? '{}' : JSON.stringify(body),
        retry.messageId,
      ]);
    }
    await recordReviewApprovalVerdict({ ...retry, disposition: 'approved' });
    expect((await bridge()).merges).toBe(0);
    const rows = await db.query<{ verdict: string }>(
      'SELECT verdict FROM overseer_verdicts WHERE run_id=$1',
      [evidenceRun]
    );
    expect(rows.rows[0].verdict).toBe('approved_unverified');
  });

  test('legacy negative without ordered evidence cannot become merge ready', async () => {
    await recordReviewApprovalVerdict({ ...work, disposition: 'approved_unverified' });
    await db.query("DELETE FROM overseer_verdicts WHERE run_id LIKE '%:unverified:%'");
    const retry = await reviewRequest('retry-after-legacy');
    await recordReviewApprovalVerdict({ ...retry, disposition: 'approved' });
    expect((await bridge()).merges).toBe(0);
  });

  test('a newer negative arriving during resolution is never swept', async () => {
    const negative = await reviewRequest('before-retry');
    await recordReviewApprovalVerdict({ ...negative, disposition: 'approved_unverified' });
    const retry = await reviewRequest('verified-retry');
    const query = db.query.bind(db);
    let injected = false;
    spyOn(db, 'query').mockImplementation(async <T>(sql: string, params?: unknown[]) => {
      const result = await query<T>(sql, params);
      if (!injected && sql.includes('SELECT id,run_id,evidence FROM overseer_verdicts')) {
        injected = true;
        const later = await reviewRequest('arrived-during-resolution');
        await recordReviewApprovalVerdict({ ...later, disposition: 'approved_unverified' });
      }
      return result;
    });
    await recordReviewApprovalVerdict({ ...retry, disposition: 'approved' });
    expect(injected).toBe(true);
    expect((await bridge()).merges).toBe(0);
    const negatives = await db.query<{ verdict: string }>(
      "SELECT verdict FROM overseer_verdicts WHERE run_id LIKE '%:unverified:%'"
    );
    expect(negatives.rows.map(row => row.verdict).sort()).toEqual([
      'approval_verified',
      'approved_unverified',
    ]);
  });
  test('unverified evidence survives a processing merge claim and a verified retry resolves it', async () => {
    await recordReviewApprovalVerdict({ ...work, disposition: 'approved' });
    const candidate = await db.query<{ id: string }>(
      "SELECT id FROM overseer_verdicts WHERE proposed_action='flag_merge_ready'"
    );
    expect(await verdictStore.claimVerdictForMergeExecution(candidate.rows[0].id)).toBe(true);
    const negative = await reviewRequest('processing-negative');
    await recordReviewApprovalVerdict({
      ...negative,
      disposition: 'approved_unverified',
    });
    const claimed = await db.query<{ action_reason: string }>(
      'SELECT action_reason FROM overseer_verdicts WHERE id=$1',
      [candidate.rows[0].id]
    );
    expect(claimed.rows[0].action_reason).toBe('processing');
    const original = {
      run_id: `pr-discovery:thinmansoftware/bdc-harness#55`,
      head_sha: head,
      pr_url: prUrl,
    } as verdictStore.OverseerVerdictRow;
    expect(await verdictStore.hasUnverifiedApprovalForHead(original)).toBe(true);
    await verdictStore.releaseVerdictClaimForMergeExecution(candidate.rows[0].id, 'test_release');
    expect((await bridge()).merges).toBe(0);
    const retry = await reviewRequest('processing-verified-retry');
    await recordReviewApprovalVerdict({
      ...retry,
      disposition: 'approved',
    });
    expect(await verdictStore.hasUnverifiedApprovalForHead(original)).toBe(false);
    await recordReviewApprovalVerdict({
      ...negative,
      disposition: 'approved_unverified',
    });
    expect(await verdictStore.hasUnverifiedApprovalForHead(original)).toBe(false);
    expect((await bridge()).merges).toBe(1);
  });

  test('first_unverified_triggers_exactly_one_re_review', async () => {
    const deps = realSubmit();
    await deps.recordReceipt(receipt);
    await deps.recordReceipt(receipt);
    const rows = await db.query<{ repeat_reason: string; recipient: string }>(
      "SELECT repeat_reason, recipient FROM agent_dispatch_messages WHERE task_type='run_review'"
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        repeat_reason: 'unverified_approval_retry',
        recipient: 'overseer-reviewer',
      }),
    ]);
  });

  test('repeated_unverified_writes_duty_officer_message', async () => {
    const deps = realSubmit();
    await deps.recordReceipt(receipt);
    await deps.recordReceipt({ ...receipt, messageId: 'review-retry' });
    await deps.recordReceipt({ ...receipt, messageId: 'review-retry' });
    const rows = await db.query<{ body: string }>(
      "SELECT body FROM agent_dispatch_messages WHERE recipient='duty-officer'"
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].body).toContain(head);
    expect(rows.rows[0].body).toContain('#55');
  });
});
