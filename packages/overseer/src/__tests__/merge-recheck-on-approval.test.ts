import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runAndSubmitReview, type SubmitDeps } from '../pr-review-submit';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import {
  claimMergeRecheckOnApproval,
  finishMergeRecheckOnApproval,
  findOverseerRunForPullRequest,
  claimOverseerVerdict,
  finalizeOverseerVerdict,
  getOverseerWatchRunById,
  insertOverseerAction,
} from '@archon/core/db/overseer';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { runWithBoundDatabase } from './isolated-database';
import { runMergeRecheckOnApproval } from '../merge-recheck-on-approval';
import { createApprovalRecheckSubmitDeps } from '../service';
import { assessRun } from '../watch';
import { createMergeManager } from '../merge-manager';
import type { GitHubClientDeps, OverseerRunStoreDeps, GrokDispositionReceipt } from '../types';

const HEAD = 'a'.repeat(40);
const WORK = {
  correlationId: 'approval-test',
  messageId: 'review-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 42,
  headSha: HEAD,
  author: 'contributor',
};
const REVIEW = {
  id: 123,
  state: 'APPROVED',
  commitSha: HEAD,
  url: 'https://github.test/review/123',
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
let previousFlag: string | undefined;
let previousLogin: string | undefined;
beforeEach(() => {
  previousFlag = process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL;
  previousLogin = process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN;
  process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = 'true';
  process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN = 'thinman-overseer[bot]';
});
afterEach(() => {
  if (previousFlag === undefined) delete process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL;
  else process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = previousFlag;
  if (previousLogin === undefined) delete process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN;
  else process.env.MERGE_MANAGER_REVIEW_GATE_LOGIN = previousLogin;
});

function submitDeps(extra: Partial<SubmitDeps> = {}): SubmitDeps {
  return {
    reviewerIdentity: 'thinman-overseer[bot]',
    runReviewer: async () => ({ approved: true, summary: 'Verified.', reviewedHeadSha: HEAD }),
    submitReview: async () => ({ submitted: true, review: REVIEW }),
    currentHeadSha: async () => HEAD,
    recordReceipt: async () => {},
    ...extra,
  };
}

describe('approval submit seam', () => {
  test('a durable exact-head approval triggers a run-derived recheck', async () => {
    const calls: unknown[] = [];
    let receipted = false;
    const deps = submitDeps({
      recordReceipt: async () => {
        receipted = true;
      },
      findRunForPullRequest: async input => {
        expect(receipted).toBe(true);
        expect(input).toEqual({ owner: WORK.owner, repo: WORK.repo, prNumber: 42, headSha: HEAD });
        return { runId: 'run-1', woId: 'WO-TEST' };
      },
      recheckMergeOnApproval: async input => {
        calls.push(input);
      },
    });
    expect((await runAndSubmitReview(WORK, deps)).disposition).toBe('approved');
    await flush();
    expect(calls).toEqual([
      expect.objectContaining({ runId: 'run-1', headSha: HEAD, reviewId: 123 }),
    ]);
  });

  test.each([undefined, 'false', 'TRUE ', ' true'])('flag %s makes no recheck call', async flag => {
    if (flag === undefined) delete process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL;
    else process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = flag;
    let called = 0;
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps({
        findRunForPullRequest: async () => {
          called++;
          return { runId: 'r', woId: 'w' };
        },
        recheckMergeOnApproval: async () => {
          called++;
        },
      })
    );
    await flush();
    expect(outcome.disposition).toBe('approved');
    expect(called).toBe(0);
  });

  test.each([undefined, async () => null])(
    'a missing run binding leaves the approval alone',
    async findRunForPullRequest => {
      let called = 0;
      const outcome = await runAndSubmitReview(
        WORK,
        submitDeps({
          findRunForPullRequest,
          recheckMergeOnApproval: async () => {
            called++;
          },
        })
      );
      await flush();
      expect(outcome.disposition).toBe('approved');
      expect(called).toBe(0);
    }
  );

  test('a recheck failure never fails the submitted approval', async () => {
    const outcome = await runAndSubmitReview(
      WORK,
      submitDeps({
        findRunForPullRequest: async () => ({ runId: 'r', woId: 'w' }),
        recheckMergeOnApproval: async () => {
          throw new Error('recheck unavailable');
        },
      })
    );
    await flush();
    expect(outcome.disposition).toBe('approved');
  });

  test.each([
    { ...REVIEW, state: 'COMMENTED' },
    { ...REVIEW, commitSha: 'b'.repeat(40) },
    { ...REVIEW, id: 0 },
    undefined,
  ])('an unqualified GitHub response makes no recheck call: %j', async review => {
    let called = 0;
    await runAndSubmitReview(
      WORK,
      submitDeps({
        submitReview: async () => ({ submitted: true, review }),
        findRunForPullRequest: async () => {
          called++;
          return null;
        },
      })
    );
    await flush();
    expect(called).toBe(0);
  });

  test('a failed approval receipt does not launch a recheck', async () => {
    let called = 0;
    const result = await runAndSubmitReview(
      WORK,
      submitDeps({
        recordReceipt: async () => {
          throw new Error('receipt failed');
        },
        findRunForPullRequest: async () => {
          called++;
          return null;
        },
      })
    );
    await flush();
    expect(result.disposition).toBe('review_incomplete');
    expect(called).toBe(0);
  });

  test('a pending merge handler does not delay review submission', async () => {
    const gate = Promise.withResolvers<void>();
    let started = false;
    const result = await runAndSubmitReview(
      WORK,
      submitDeps({
        findRunForPullRequest: async () => ({ runId: 'r', woId: 'w' }),
        recheckMergeOnApproval: async () => {
          started = true;
          await gate.promise;
        },
      })
    );
    expect(result.disposition).toBe('approved');
    await flush();
    expect(started).toBe(true);
    gate.resolve();
    await flush();
  });
});

const INPUT = { ...WORK, runId: 'run-1', woId: 'WO-TEST', reviewId: 123 };
async function seed(db: SqliteAdapter): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('c', 'test', 'c')`
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
    (id, conversation_id, workflow_name, user_message, status, metadata, working_path)
    VALUES ('run-1', 'c', 'test', 'WO-TEST', 'completed', $1, '/test/worktree')`,
    [
      JSON.stringify({
        target_repo: 'thinmansoftware/bdc-harness',
        head_branch: 'archon/task-builder',
        base_branch: 'dev',
        base_sha: 'b'.repeat(40),
        changed_files: 'src/code.ts',
      }),
    ]
  );
  await verdictFor(HEAD);
}
async function verdictFor(headSha: string): Promise<void> {
  const claim = await claimOverseerVerdict({ runId: 'run-1', woId: 'WO-TEST', headSha });
  if (!claim.verdictId) throw new Error('missing verdict claim');
  await finalizeOverseerVerdict({
    verdictId: claim.verdictId,
    status: 'verdict',
    verdict: 'merge_candidate',
    proposedAction: 'flag_merge_ready',
    prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/42',
  });
}

async function withDb(work: (db: SqliteAdapter) => Promise<void>): Promise<void> {
  const db = new SqliteAdapter(':memory:');
  try {
    await runWithBoundDatabase(db, async () => {
      await seed(db);
      await work(db);
    });
  } finally {
    await db.close();
  }
}

function githubFixture() {
  const state = { head: HEAD, approved: false, merges: [] as string[] };
  const github: OverseerRunStoreDeps & GitHubClientDeps = {
    listRunsForWatch: async () => [],
    listRunEvents: async () => [
      {
        id: 'push',
        workflow_run_id: 'run-1',
        event_type: 'node_completed',
        step_name: 'commit-and-push',
        data: { type: 'bash', node_output: 'unique_branch=real-branch\n' },
      },
    ],
    findPullRequest: async input => {
      expect(input.headBranch).toBe('real-branch');
      return {
        exists: true,
        state: 'open',
        headSha: state.head,
        baseBranch: 'dev',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        pr: { owner: WORK.owner, repo: WORK.repo, number: 42 },
      };
    },
    mergePullRequest: async input => {
      expect(input.expectedHeadSha).toBe(state.head);
      state.merges.push(input.expectedHeadSha ?? '');
      return { merged: true, sha: 'merge-sha' };
    },
    listPullRequestReviews: async () =>
      state.approved
        ? [{ login: 'thinman-overseer[bot]', state: 'APPROVED', commitId: state.head }]
        : [],
  };
  const manager = createMergeManager({
    ...github,
    insertOverseerAction,
    mode: 'execute',
    mutationsEnabled: true,
    allowedBases: ['dev'],
    reviewGateLogin: 'thinman-overseer[bot]',
    readWorktreeHeadSha: async () => state.head,
    judge: async input =>
      ({
        schemaVersion: 'overseer-grok-merge-disposition-v1',
        disposition: 'approve',
        reason: 'judge_approve',
        woId: input.woId,
        prNumber: input.prNumber,
        headSha: input.headSha,
        baseSha: input.baseSha,
        evidenceDigest: input.evidenceDigest,
        operator: input.operator,
      }) as GrokDispositionReceipt,
  });
  return { state, github, manager };
}

describe('atomic approval recheck and existing manager', () => {
  test('flag off creates no claim even when the service callback is invoked', async () =>
    withDb(async db => {
      process.env.OVERSEER_MERGE_RECHECK_ON_APPROVAL = 'TRUE ';
      const { github, manager } = githubFixture();
      await createApprovalRecheckSubmitDeps(github, manager).recheckMergeOnApproval?.(INPUT);
      const rows = await db.query(
        "SELECT * FROM overseer_actions WHERE action = 'merge_recheck_on_approval'"
      );
      expect(rows.rows).toHaveLength(0);
    }));

  test('a legacy action row with the key also prevents a new claim', async () =>
    withDb(async () => {
      const key = `thinmansoftware/bdc-harness#42@${HEAD}:review:123`;
      await insertOverseerAction({
        runId: 'run-1',
        woId: 'WO-TEST',
        class: 'none',
        action: 'merge_recheck_on_approval',
        result: `merged:key=${key}`,
      });
      expect(
        await claimMergeRecheckOnApproval({ runId: 'run-1', woId: 'WO-TEST', key })
      ).toBeNull();
    }));
  test('a pre-approval denial re-evaluates once after approval, and replay/restart stays idempotent', async () =>
    withDb(async db => {
      const { state, github, manager } = githubFixture();
      const run = await getOverseerWatchRunById('run-1');
      if (!run) throw new Error('missing run');
      expect(await manager(await assessRun(run, github))).toMatchObject({
        status: 'held',
        reason: 'review_gate_approval_missing_for_head',
      });
      state.approved = true;
      let evaluations = 0;
      const binding = () =>
        createApprovalRecheckSubmitDeps(github, async record => {
          evaluations++;
          return manager(record);
        });
      const seam = binding();
      const completed = Promise.withResolvers<void>();
      const outcome = await runAndSubmitReview(
        WORK,
        submitDeps({
          ...seam,
          recheckMergeOnApproval: async input => {
            try {
              await seam.recheckMergeOnApproval?.(input);
            } finally {
              completed.resolve();
            }
          },
        })
      );
      expect(outcome.disposition).toBe('approved');
      await completed.promise;
      await binding().recheckMergeOnApproval?.(INPUT);
      expect(evaluations).toBe(1);
      expect(state.merges).toEqual([HEAD]);
      const rows = await db.query<{ result: string }>(
        "SELECT result FROM overseer_actions WHERE action = 'merge_recheck_on_approval'"
      );
      expect(rows.rows).toEqual([
        { result: `merged:key=thinmansoftware/bdc-harness#42@${HEAD}:review:123` },
      ]);
    }));

  test('stale approval cannot merge a new head; that head needs its own key and approval', async () =>
    withDb(async db => {
      const { state, github, manager } = githubFixture();
      const seam = createApprovalRecheckSubmitDeps(github, manager);
      state.head = 'd'.repeat(40);
      await seam.recheckMergeOnApproval?.(INPUT);
      expect(state.merges).toHaveLength(0);
      await verdictFor(state.head);
      const next = { ...INPUT, headSha: state.head, reviewId: 124 };
      await seam.recheckMergeOnApproval?.(next);
      expect(state.merges).toHaveLength(0);
      state.approved = true;
      await seam.recheckMergeOnApproval?.({ ...next, reviewId: 125 });
      expect(state.merges).toEqual([state.head]);
      const rows = await db.query<{ result: string }>(
        "SELECT result FROM overseer_actions WHERE action = 'merge_recheck_on_approval' ORDER BY created_at, id"
      );
      expect(rows.rows.map(r => r.result)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('denied:head_moved:key='),
          expect.stringContaining('held:review_gate_approval_missing_for_head:key='),
          expect.stringContaining(
            `merged:key=thinmansoftware/bdc-harness#42@${state.head}:review:125`
          ),
        ])
      );
    }));

  test('no real verdict/run binding is invented for runless or unrelated PRs', async () =>
    withDb(async () => {
      expect(await findOverseerRunForPullRequest(WORK)).toEqual({
        runId: 'run-1',
        woId: 'WO-TEST',
      });
      expect(await findOverseerRunForPullRequest({ ...WORK, prNumber: 99 })).toBeNull();
      expect(await findOverseerRunForPullRequest({ ...WORK, headSha: 'b'.repeat(40) })).toBeNull();
      expect(await findOverseerRunForPullRequest({ ...WORK, repo: 'bdc-xo' })).toBeNull();
    }));

  test('handler failure records no merged outcome and permanently fences replay', async () =>
    withDb(async db => {
      const { github } = githubFixture();
      let calls = 0;
      const seam = createApprovalRecheckSubmitDeps(github, async () => {
        calls++;
        throw new Error('manager failed');
      });
      await seam.recheckMergeOnApproval?.(INPUT);
      await seam.recheckMergeOnApproval?.(INPUT);
      expect(calls).toBe(1);
      const rows = await db.query<{ result: string }>(
        "SELECT result FROM overseer_actions WHERE action = 'merge_recheck_on_approval'"
      );
      expect(rows.rows).toEqual([
        { result: `held:recheck_failed:key=thinmansoftware/bdc-harness#42@${HEAD}:review:123` },
      ]);
    }));

  test('concurrent approvals across two database connections take exactly one atomic claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-recheck-'));
    const path = join(dir, 'test.db');
    const first = new SqliteAdapter(path);
    let second: SqliteAdapter | undefined;
    try {
      await runWithBoundDatabase(first, () => seed(first));
      second = new SqliteAdapter(path);
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let calls = 0;
      const { github, manager } = githubFixture();
      const deps = {
        claim: claimMergeRecheckOnApproval,
        finish: finishMergeRecheckOnApproval,
        getRun: getOverseerWatchRunById,
        assessRun: (run: NonNullable<Awaited<ReturnType<typeof getOverseerWatchRunById>>>) =>
          assessRun(run, github),
        mergeManager: async (record: Parameters<typeof manager>[0]) => {
          calls++;
          started.resolve();
          await gate.promise;
          return manager(record);
        },
      };
      const winner = runWithBoundDatabase(first, () => runMergeRecheckOnApproval(INPUT, deps));
      await started.promise;
      await runWithBoundDatabase(second, () =>
        Promise.all(Array.from({ length: 12 }, () => runMergeRecheckOnApproval(INPUT, deps)))
      );
      expect(calls).toBe(1);
      gate.resolve();
      await winner;
      await runWithBoundDatabase(second, () => runMergeRecheckOnApproval(INPUT, deps));
      expect(calls).toBe(1);
      const rows = await first.query(
        "SELECT * FROM overseer_actions WHERE action = 'merge_recheck_on_approval'"
      );
      expect(rows.rows).toHaveLength(1);
    } finally {
      await second?.close();
      await first.close();
      removeTempDirWithRetry(dir);
    }
  });
});
