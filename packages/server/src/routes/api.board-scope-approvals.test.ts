import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  scopeApprovalPublicReadQuerySchema,
  scopeApprovalRecordBodySchema,
  scopeApprovalRevokeBodySchema,
} from './schemas/board-authority.schemas';

const S = '1'.repeat(40);
const B = '2'.repeat(40);
const authenticate = mock(async (proof: { principal_token?: string }) => {
  if (proof.principal_token === 'bad') throw new Error('board_principal_auth_rejected');
  return { principal_id: 'xo-model', seat_id: 'xo' as const, roles: ['acting_xo'] };
});
const read = mock(async () => ({ decision: 'deny' as const, reason: 'no_record' }));
const record = mock(async () => ({ ok: false as const, reason: 'invalid_request' as const }));
const revoke = mock(async () => ({ ok: false as const, reason: 'approval_not_found' as const }));
const listRuns = mock(async () => ({ data: { workflow_runs: [] as Record<string, unknown>[] } }));
const rerun = mock(async () => ({}));

mock.module('@archon/core/db/board-authority', () => ({
  authenticateBoardPrincipal: authenticate,
  getCurrentXoLease: mock(async () => null),
  resolveBoardRecipient: mock(async () => ({ ok: false, reason: 'no_valid_xo_lease' })),
}));
mock.module('@archon/core/db/board-scope-approvals', () => ({
  getScopeApprovalDecision: read,
  recordScopeApproval: record,
  revokeScopeApproval: revoke,
}));
mock.module('@archon/overseer/adapters/github-real-deps', () => ({
  createRealOctokitClient: () => ({
    pulls: {
      get: mock(async () => ({
        data: {
          state: 'open',
          head: { sha: S, ref: 'feature' },
          base: { sha: B, ref: 'release/ce' },
        },
      })),
    },
    actions: { listWorkflowRunsForRepo: listRuns, reRunWorkflow: rerun },
  }),
}));

import { registerApiRoutes } from './api';

const valid = {
  holder_id: 'h',
  holder_token: 't',
  fencing_token: 1,
  repo: 'thinmansoftware/lspro-react',
  pr_number: 626,
  head_sha: S,
  conditions: 'no regression',
  evidence_url: 'https://example.test/e',
};

function makeApp(): OpenAPIHono {
  delete process.env.ARCHON_OPERATOR_TOKEN;
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const web = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
  } as unknown as WebAdapter;
  const locks = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, web, locks);
  return app;
}

describe('scope approval routes', () => {
  beforeEach(() => {
    authenticate.mockClear();
    read.mockReset();
    read.mockImplementation(async () => ({ decision: 'deny', reason: 'no_record' }));
    record.mockReset();
    record.mockImplementation(async () => ({ ok: false, reason: 'invalid_request' }));
    revoke.mockReset();
    revoke.mockImplementation(async () => ({ ok: false, reason: 'approval_not_found' }));
    listRuns.mockReset();
    listRuns.mockImplementation(async () => ({ data: { workflow_runs: [] } }));
    rerun.mockClear();
  });

  test('uses production schemas and validates the registered mutation routes', async () => {
    expect(
      scopeApprovalRecordBodySchema.safeParse({ ...valid, authority: 'general' }).success
    ).toBe(false);
    expect(
      scopeApprovalRevokeBodySchema.safeParse({
        holder_id: 'h',
        holder_token: 't',
        fencing_token: 1,
        reason: '',
      }).success
    ).toBe(false);
    const response = await makeApp().request('/api/board/scope-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, recorded_by: 'forged' }),
    });
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  test('public read is unauthenticated and maps invalid queries and store failures', async () => {
    expect(
      scopeApprovalPublicReadQuerySchema.safeParse({
        repo: valid.repo,
        pr_number: '626',
        head_sha: S,
        base_sha: B,
      }).success
    ).toBe(true);
    const app = makeApp();
    const invalid = await app.request('/api/public/board/scope-approvals?repo=x&pr_number=nope');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ decision: 'deny', reason: 'invalid_query' });
    const malformedRepo = await app.request(
      `/api/public/board/scope-approvals?repo=x&pr_number=626&head_sha=${S}&base_sha=${B}`
    );
    expect(malformedRepo.status).toBe(400);
    expect(await malformedRepo.json()).toEqual({ decision: 'deny', reason: 'invalid_query' });
    const query = `repo=${encodeURIComponent(valid.repo)}&pr_number=626&head_sha=${S}&base_sha=${B}`;
    expect((await app.request(`/api/public/board/scope-approvals?${query}`)).status).toBe(200);
    read.mockImplementationOnce(async () => {
      throw new Error('store down');
    });
    const failed = await app.request(`/api/public/board/scope-approvals?${query}`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ decision: 'deny', reason: 'server_error' });
  });

  test('maps authentication and store refusal statuses', async () => {
    const app = makeApp();
    const unauthorized = await app.request('/api/board/scope-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...valid, principal_token: 'bad' }),
    });
    expect(unauthorized.status).toBe(401);
    record.mockImplementationOnce(async () => ({ ok: false, reason: 'seat_not_permitted' }));
    const forbidden = await app.request('/api/board/scope-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    });
    expect(forbidden.status).toBe(403);
    const missing = await app.request('/api/board/scope-approvals/unknown/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holder_id: 'h',
        holder_token: 't',
        fencing_token: 1,
        reason: 'withdraw',
      }),
    });
    expect(missing.status).toBe(404);
  });

  test('revoke reruns only a returned run matching head SHA and live branch', async () => {
    revoke.mockImplementation(async () => ({
      ok: true,
      approval: {
        ...valid,
        approval_id: 'approval-1',
        base_sha: B,
        target_branch: 'release/ce',
      },
    }));
    listRuns.mockImplementation(async () => ({
      data: {
        workflow_runs: [
          {
            id: 1,
            path: '.github/workflows/ce-change-scope-gate.yml',
            head_sha: B,
            head_branch: 'feature',
            run_started_at: '2026-01-02',
          },
          {
            id: 2,
            path: '.github/workflows/ce-change-scope-gate.yml',
            head_sha: S,
            head_branch: 'feature',
            run_started_at: '2026-01-01',
          },
        ],
      },
    }));
    const response = await makeApp().request('/api/board/scope-approvals/approval-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holder_id: 'h',
        holder_token: 't',
        fencing_token: 1,
        reason: 'withdraw',
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).rerun).toBe('requested');
    expect(rerun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 2 }));
  });
});
