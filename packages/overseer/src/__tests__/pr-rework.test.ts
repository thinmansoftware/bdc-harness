import { describe, expect, test } from 'bun:test';
import {
  assessAndEnqueueRework,
  escalateRework,
  parseReworkBody,
  reworkCommentMarker,
  reworkPullRequestUrl,
  reworkSubjectKey,
  resolveReworkEnabled,
  resolveReworkMaxAttempts,
  resolveReworkRepos,
  type ReworkDeps,
  type ReworkPullRequest,
} from '../pr-rework';
import type { DispatchMessage } from '../../../core/src/db/dispatch';
import type { OriginatingPullRequestRun } from '../../../core/src/db/workflow-events';
import type { ReviewWorkItem, SubmitOutcome } from '../pr-review-submit';

// Behavior source of truth for this suite: WO-HARNESS-OVERSEER-REWORK-LOOP-01
// Section 7 (16-scenario coverage table). This file exercises the 8
// decision-gate scenarios that live entirely inside assessAndEnqueueRework /
// escalateRework (scenarios 1-7, 9, 14 in the WO's numbering); the worker
// clock, dispatch idempotency and lane-gate scenarios live in their own
// suites (rework-worker-clock.test.ts, dispatch.postgres.test.ts,
// rework-gate.test.ts) per the manifest's file split.

const BASE_WORK: ReviewWorkItem = {
  correlationId: 'corr-1',
  messageId: 'msg-1',
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 936,
  headSha: 'sha-current',
  author: 'thinman-cauldron',
};

const CHANGES_REQUESTED_OUTCOME: SubmitOutcome = {
  disposition: 'changes_requested',
  summary: '[major] pr-rework.ts: missing test coverage for the rework gate.',
};

const OPEN_PR: ReworkPullRequest = {
  state: 'open',
  draft: false,
  baseRef: 'dev',
  headSha: 'sha-current',
  headRef: 'feat/wo-harness-overseer-rework-loop-01-thread-abc123',
  headRepoFullName: 'thinmansoftware/bdc-harness',
  labels: [],
};

const ORIGINATING_RUN: OriginatingPullRequestRun = {
  runId: 'run-1',
  workflowName: 'bdc-feature-development-codex',
  userMessage: 'WO_ID=WO-HARNESS-OVERSEER-REWORK-LOOP-01 --project bdc-harness',
  workingPath: '/tmp/worktree',
};

function makeDeps(overrides: Partial<ReworkDeps> = {}): {
  deps: ReworkDeps;
  enqueued: unknown[];
  escalations: unknown[];
  comments: Array<{ body: string }>;
} {
  const enqueued: unknown[] = [];
  const escalations: unknown[] = [];
  const comments: Array<{ body: string }> = [];
  const deps: ReworkDeps = {
    env: { OVERSEER_REWORK_ENABLED: undefined },
    async getPullRequest() {
      return OPEN_PR;
    },
    async findOriginatingRun() {
      return ORIGINATING_RUN;
    },
    async listMessages() {
      return [] as DispatchMessage[];
    },
    async createAuthenticatedMessage(context, data) {
      if (data.task_type === 'run_rework') enqueued.push(data);
      else escalations.push(data);
      return {
        id: 'created-1',
        correlation_id: data.correlation_id,
        idempotency_key: data.idempotency_key,
        task_type: data.task_type,
        sender: 'overseer',
        sender_principal_id: null,
        recipient: data.recipient,
        body: data.body,
        status: 'queued',
        result_body: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        completed_at: null,
        not_before: null,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
        recipient_alias: null,
        motion_id: null,
        motion_revision_sha: null,
      } as unknown as DispatchMessage;
    },
    async listComments() {
      return comments;
    },
    async createComment(input) {
      comments.push({ body: input.body });
    },
    ...overrides,
  };
  return { deps, enqueued, escalations, comments };
}

describe('resolveReworkEnabled / resolveReworkRepos / resolveReworkMaxAttempts', () => {
  test('enabled by default, disabled only on the literal string false', () => {
    expect(resolveReworkEnabled({})).toBe(true);
    expect(resolveReworkEnabled({ OVERSEER_REWORK_ENABLED: 'FALSE' })).toBe(false);
    expect(resolveReworkEnabled({ OVERSEER_REWORK_ENABLED: 'true' })).toBe(true);
  });

  test('defaults the repo allowlist to bdc-harness and accepts a CSV override', () => {
    expect(resolveReworkRepos({}).has('thinmansoftware/bdc-harness')).toBe(true);
    const custom = resolveReworkRepos({ OVERSEER_REWORK_REPOS: 'a/b, C/D ,, a/b' });
    expect(custom).toEqual(new Set(['a/b', 'c/d']));
  });

  test('caps the configured max attempts at the re-review budget ceiling', () => {
    expect(resolveReworkMaxAttempts({})).toBe(2);
    expect(resolveReworkMaxAttempts({ OVERSEER_REWORK_MAX_ATTEMPTS: '10' })).toBe(3);
    expect(resolveReworkMaxAttempts({ OVERSEER_REWORK_MAX_ATTEMPTS: '1' })).toBe(1);
    expect(resolveReworkMaxAttempts({ OVERSEER_REWORK_MAX_ATTEMPTS: '0' })).toBe(2);
    expect(resolveReworkMaxAttempts({ OVERSEER_REWORK_MAX_ATTEMPTS: 'nonsense' })).toBe(2);
  });
});

describe('reworkSubjectKey / reworkPullRequestUrl / reworkCommentMarker / parseReworkBody', () => {
  test('subject key and PR URL are stable and boundary-safe', () => {
    expect(reworkSubjectKey('thinmansoftware', 'bdc-harness', 91)).toBe(
      'gh:thinmansoftware/bdc-harness#91'
    );
    expect(reworkPullRequestUrl('thinmansoftware', 'bdc-harness', 91)).toBe(
      'https://github.com/thinmansoftware/bdc-harness/pull/91'
    );
  });

  test('comment marker encodes reason and head sha for idempotent detection', () => {
    expect(reworkCommentMarker('rework_cap_exhausted', 'abc123')).toBe(
      '<!-- overseer-rework:rework_cap_exhausted:abc123 -->'
    );
  });

  test('parseReworkBody accepts a well-formed body and rejects malformed ones', () => {
    const body = {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 936,
      headSha: 'sha1',
      branch: 'feat/x',
      baseRef: 'dev',
      woId: 'WO-1',
      project: 'bdc-harness',
      originatingRunId: 'run-1',
      reviewMessageId: 'msg-1',
    };
    expect(parseReworkBody(JSON.stringify(body))).toEqual(body);
    expect(parseReworkBody('not json')).toBeNull();
    expect(parseReworkBody(JSON.stringify({ ...body, prNumber: '936' }))).toBeNull();
    expect(parseReworkBody(JSON.stringify({ ...body, woId: undefined }))).toBeNull();
  });
});

describe('assessAndEnqueueRework', () => {
  test('Scenario 5: a non-changes_requested outcome is ignored with no side effects', async () => {
    const { deps, enqueued, escalations } = makeDeps();
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: { disposition: 'approved' } },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'not_changes_requested' });
    expect(enqueued).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('a changes_requested outcome with an empty summary is treated as not_changes_requested', async () => {
    const { deps } = makeDeps();
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: { disposition: 'changes_requested', summary: '   ' } },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'not_changes_requested' });
  });

  test('Scenario 9 / check-caused verdict is skipped, never enqueued (M-09 adjacent: reuses verdictAuthorizesRecheck unchanged)', async () => {
    const { deps, enqueued } = makeDeps();
    const result = await assessAndEnqueueRework(
      {
        work: BASE_WORK,
        outcome: {
          disposition: 'changes_requested',
          summary: '[major] checks/test (windows-latest) failed',
        },
      },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'check_caused_verdict' });
    expect(enqueued).toHaveLength(0);
  });

  test('Scenario 7: kill switch (OVERSEER_REWORK_ENABLED=false) skips before any lookup', async () => {
    const { deps, enqueued } = makeDeps({ env: { OVERSEER_REWORK_ENABLED: 'false' } });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'repo_not_enabled' });
    expect(enqueued).toHaveLength(0);
  });

  test('Scenario 7: a repo outside OVERSEER_REWORK_REPOS is skipped', async () => {
    const { deps } = makeDeps({ env: { OVERSEER_REWORK_REPOS: 'someorg/other-repo' } });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'repo_not_enabled' });
  });

  test('Scenario 2: a fork PR (head repo differs from base repo) is skipped, never escalated', async () => {
    const { deps, enqueued, escalations } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, headRepoFullName: 'someone-else/bdc-harness' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'pr_not_eligible:fork' });
    expect(enqueued).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('a closed PR is skipped', async () => {
    const { deps } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, state: 'closed' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'pr_not_eligible:not_open' });
  });

  test('a draft PR is skipped', async () => {
    const { deps } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, draft: true };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'pr_not_eligible:draft' });
  });

  test('Scenario 7: the no-auto-rework opt-out label is honored', async () => {
    const { deps } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, labels: ['P0', 'no-auto-rework'] };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'pr_not_eligible:opt_out' });
  });

  test('Scenario 11: the head moved after the review verdict (superseded head) is skipped', async () => {
    const { deps } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, headSha: 'sha-newer-than-review' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'pr_not_eligible:head_moved' });
  });

  test('Scenario 3: a production base (M-09) never enqueues or escalates, even if everything else matches', async () => {
    const { deps, enqueued, escalations } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, baseRef: 'main' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'production_or_unlisted_base' });
    expect(enqueued).toHaveLength(0);
    expect(escalations).toHaveLength(0);
  });

  test('an unlisted base on a listed repo is treated the same as production (no policy entry)', async () => {
    const { deps } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, baseRef: 'some-unlisted-branch' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'production_or_unlisted_base' });
  });

  test('a non-Cauldron-provenanced PR (no originating run found) is skipped, never escalated', async () => {
    const { deps, escalations } = makeDeps({
      async findOriginatingRun() {
        return null;
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'skipped', reason: 'not_cauldron_built' });
    expect(escalations).toHaveLength(0);
  });

  test('Scenario 14: an unparseable originating run (no WO_ID/--project match) escalates', async () => {
    const { deps, escalations } = makeDeps({
      async findOriginatingRun() {
        return { ...ORIGINATING_RUN, userMessage: 'some free-form message with no WO marker' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'escalated', reason: 'originating_run_unparseable' });
    expect(escalations).toHaveLength(1);
  });

  test('Scenario 6: an unsupported head-branch pattern escalates instead of enqueuing', async () => {
    const { deps, enqueued, escalations } = makeDeps({
      async getPullRequest() {
        return { ...OPEN_PR, headRef: 'archon/task-something-not-matching' };
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'escalated', reason: 'branch_pattern_unsupported' });
    expect(enqueued).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('Scenario 1: same-branch enqueue -- a fresh eligible PR enqueues exactly one run_rework message', async () => {
    const { deps, enqueued } = makeDeps();
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'enqueued', reason: 'changes_requested' });
    expect(enqueued).toHaveLength(1);
    const message = enqueued[0] as {
      task_type: string;
      recipient: string;
      subject_key: string;
      idempotency_key: string;
      body: string;
    };
    expect(message.task_type).toBe('run_rework');
    expect(message.recipient).toBe('overseer-rework');
    expect(message.subject_key).toBe('gh:thinmansoftware/bdc-harness#936');
    expect(message.idempotency_key).toBe(
      'overseer-rework:thinmansoftware/bdc-harness#936@sha-current'
    );
    const parsed = parseReworkBody(message.body);
    expect(parsed).not.toBeNull();
    expect(parsed?.woId).toBe('WO-HARNESS-OVERSEER-REWORK-LOOP-01');
    expect(parsed?.project).toBe('bdc-harness');
    expect(parsed?.originatingRunId).toBe('run-1');
    expect(parsed?.reviewMessageId).toBe('msg-1');
  });

  test('Scenario 4: cap-exhausted after resolveReworkMaxAttempts prior run_rework attempts escalates exactly once', async () => {
    const priorAttempts: DispatchMessage[] = [
      {
        id: 'prior-1',
        correlation_id: 'c1',
        idempotency_key: 'k1',
        task_type: 'run_rework',
        sender: 'overseer',
        sender_principal_id: null,
        recipient: 'overseer-rework',
        body: '{}',
        status: 'done',
        result_body: null,
        created_at: '2026-09-24T00:00:00.000Z',
        claimed_at: null,
        completed_at: null,
        not_before: null,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
        recipient_alias: null,
        motion_id: null,
        motion_revision_sha: null,
      } as unknown as DispatchMessage,
      {
        id: 'prior-2',
        correlation_id: 'c2',
        idempotency_key: 'k2',
        task_type: 'run_rework',
        sender: 'overseer',
        sender_principal_id: null,
        recipient: 'overseer-rework',
        body: '{}',
        status: 'done',
        result_body: null,
        created_at: '2026-09-24T00:01:00.000Z',
        claimed_at: null,
        completed_at: null,
        not_before: null,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
        recipient_alias: null,
        motion_id: null,
        motion_revision_sha: null,
      } as unknown as DispatchMessage,
    ];
    const { deps, enqueued, escalations } = makeDeps({
      async listMessages() {
        return priorAttempts;
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'escalated', reason: 'rework_cap_exhausted' });
    expect(enqueued).toHaveLength(0);
    expect(escalations).toHaveLength(1);
  });

  test('non-run_rework prior messages on the same subject do not count against the cap', async () => {
    const priorAgentMessage: DispatchMessage = {
      id: 'prior-am',
      correlation_id: 'c1',
      idempotency_key: 'k1',
      task_type: 'agent_message',
      sender: 'overseer',
      sender_principal_id: null,
      recipient: 'overseer-rework',
      body: '{}',
      status: 'done',
      result_body: null,
      created_at: '2026-09-24T00:00:00.000Z',
      claimed_at: null,
      completed_at: null,
      not_before: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
      recipient_alias: null,
      motion_id: null,
      motion_revision_sha: null,
    } as unknown as DispatchMessage;
    const { deps, enqueued } = makeDeps({
      async listMessages() {
        return [priorAgentMessage];
      },
    });
    const result = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(result).toEqual({ action: 'enqueued', reason: 'changes_requested' });
    expect(enqueued).toHaveLength(1);
  });

  test('Scenario 15: no-flag byte-identical inputs enqueue byte-identical idempotency keys and bodies', async () => {
    const { deps, enqueued } = makeDeps();
    const first = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    const second = await assessAndEnqueueRework(
      { work: BASE_WORK, outcome: CHANGES_REQUESTED_OUTCOME },
      deps
    );
    expect(first).toEqual(second);
    expect(enqueued).toHaveLength(2);
    const [firstBody, secondBody] = enqueued as Array<{
      idempotency_key: string;
      body: string;
    }>;
    expect(firstBody.idempotency_key).toBe(secondBody.idempotency_key);
    expect(firstBody.body).toBe(secondBody.body);
  });
});

describe('escalateRework', () => {
  test('Scenario 4/6/14: posts exactly one marked comment and one blocker dispatch message', async () => {
    const { deps, escalations, comments } = makeDeps();
    const result = await escalateRework(deps, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 936,
      headSha: 'sha-current',
      branch: 'feat/wo-harness-overseer-rework-loop-01-thread-abc123',
      woId: 'WO-HARNESS-OVERSEER-REWORK-LOOP-01',
      reason: 'rework_cap_exhausted',
      findings: '[major] example finding',
      correlationId: 'corr-1',
    });
    expect(result).toEqual({ action: 'escalated', reason: 'rework_cap_exhausted' });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(
      '<!-- overseer-rework:rework_cap_exhausted:sha-current -->'
    );
    expect(comments[0]?.body).toContain('WO: WO-HARNESS-OVERSEER-REWORK-LOOP-01');
    expect(escalations).toHaveLength(1);
    const [escalation] = escalations as Array<{ recipient: string; priority: string }>;
    expect(escalation.recipient).toBe('operator');
    expect(escalation.priority).toBe('blocker');
  });

  test('a duplicate escalation for the same reason and head does not double-post the comment', async () => {
    const marker = reworkCommentMarker('rework_cap_exhausted', 'sha-current');
    const { deps, comments } = makeDeps({
      async listComments() {
        return [{ body: `${marker}\nalready posted` }];
      },
    });
    await escalateRework(deps, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 936,
      headSha: 'sha-current',
      branch: 'feat/x',
      woId: 'WO-1',
      reason: 'rework_cap_exhausted',
      findings: 'finding',
      correlationId: 'corr-1',
    });
    expect(comments).toHaveLength(0);
  });

  test('a comment-post failure still sends the operator dispatch escalation', async () => {
    const { deps, escalations } = makeDeps({
      async listComments() {
        throw new Error('github_unavailable');
      },
    });
    const result = await escalateRework(deps, {
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      prNumber: 936,
      headSha: 'sha-current',
      branch: 'feat/x',
      woId: 'WO-1',
      reason: 'branch_pattern_unsupported',
      findings: 'finding',
      correlationId: 'corr-1',
    });
    expect(result).toEqual({ action: 'escalated', reason: 'branch_pattern_unsupported' });
    expect(escalations).toHaveLength(1);
  });
});
