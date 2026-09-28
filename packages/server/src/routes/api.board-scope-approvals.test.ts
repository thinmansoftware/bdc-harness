import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
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
const actualScopeApprovals = await import('@archon/core/db/board-scope-approvals');
const actualGetScopeApprovalDecision = actualScopeApprovals.getScopeApprovalDecision;
const actualGetScopeApprovalMetadata = actualScopeApprovals.getScopeApprovalMetadata;
const actualRecordScopeApproval = actualScopeApprovals.recordScopeApproval;
const actualRevokeScopeApproval = actualScopeApprovals.revokeScopeApproval;

mock.module('@archon/core/db/board-authority', () => ({
  authenticateBoardPrincipal: authenticate,
  getCurrentXoLease: mock(async () => null),
  resolveBoardRecipient: mock(async () => ({ ok: false, reason: 'no_valid_xo_lease' })),
}));
mock.module('@archon/core/db/board-scope-approvals', () => ({
  getScopeApprovalDecision: (input: Record<string, unknown>) =>
    input.database ? actualGetScopeApprovalDecision(input as never) : read(),
  getScopeApprovalMetadata: actualGetScopeApprovalMetadata,
  recordScopeApproval: (input: Record<string, unknown>) =>
    input.database ? actualRecordScopeApproval(input as never) : record(),
  revokeScopeApproval: (input: Record<string, unknown>) =>
    input.database ? actualRevokeScopeApproval(input as never) : revoke(),
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

afterAll(() => mock.restore());

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

function makeApp(options: { preserveOperatorToken?: boolean } = {}): OpenAPIHono {
  if (!options.preserveOperatorToken) delete process.env.ARCHON_OPERATOR_TOKEN;
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

  test('record_rejects_forged_body_fields', async () => {
    const app = makeApp();
    const invalidBodies = [
      { ...valid, authority: 'general' },
      { ...valid, recorded_by: 'john' },
      { ...valid, conditions: '   ' },
      Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'evidence_url')),
    ];

    for (const body of invalidBodies) {
      const response = await app.request('/api/board/scope-approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(authenticate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  test('public_read_needs_no_operator_token_and_rejects_bad_input', async () => {
    expect(
      scopeApprovalPublicReadQuerySchema.safeParse({
        repo: valid.repo,
        pr_number: '626',
        head_sha: S,
        base_sha: B,
      }).success
    ).toBe(true);
    const previousToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret';
    try {
      const app = makeApp({ preserveOperatorToken: true });
      const query = `repo=${encodeURIComponent(valid.repo)}&pr_number=626&head_sha=${S}&base_sha=${B}`;
      const publicResponse = await app.request(`/api/public/board/scope-approvals?${query}`);
      expect(publicResponse.status).toBe(200);
      expect(publicResponse.headers.get('content-type')).toContain('application/json');

      const malformed = [
        `repo=x&pr_number=626&head_sha=${S}&base_sha=${B}`,
        `repo=${encodeURIComponent(valid.repo)}&pr_number=x&head_sha=${S}&base_sha=${B}`,
        `repo=${encodeURIComponent(valid.repo)}&pr_number=626&head_sha=abc&base_sha=${B}`,
        `repo=${encodeURIComponent(valid.repo)}&pr_number=626&head_sha=${S}&base_sha=abc`,
      ];
      for (const invalidQuery of malformed) {
        const response = await app.request(`/api/public/board/scope-approvals?${invalidQuery}`);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ decision: 'deny', reason: 'invalid_query' });
      }

      for (const path of [
        '/api/board/scope-approvals',
        '/api/board/scope-approvals/approval-1/revoke',
      ]) {
        const response = await app.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            path.endsWith('/revoke')
              ? {
                  holder_id: 'h',
                  holder_token: 't',
                  fencing_token: 1,
                  reason: 'withdraw',
                }
              : valid
          ),
        });
        expect(response.status).toBe(401);
      }
    } finally {
      if (previousToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousToken;
    }
  });

  test('public_read_fails_closed_on_store_error', async () => {
    read.mockImplementationOnce(async () => {
      throw new Error('store down');
    });
    const query = `repo=${encodeURIComponent(valid.repo)}&pr_number=626&head_sha=${S}&base_sha=${B}`;
    const response = await makeApp().request(`/api/public/board/scope-approvals?${query}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ decision: 'deny', reason: 'server_error' });
  });

  test('revoke_requires_lease_proof_and_requests_rerun', async () => {
    const app = makeApp();
    const revokeBody = { holder_id: 'h', holder_token: 't', fencing_token: 1, reason: 'withdraw' };
    revoke.mockImplementation(async () => ({ ok: false, reason: 'stale_xo_lease_token' }));
    for (const body of [
      { ...revokeBody, holder_token: 'missing-proof' },
      { ...revokeBody, holder_token: 'wrong' },
      { ...revokeBody, fencing_token: 2 },
    ]) {
      const response = await app.request('/api/board/scope-approvals/approval-1/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(409);
    }

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
            id: 2,
            path: '.github/workflows/ce-change-scope-gate.yml',
            head_sha: S,
            head_branch: 'feature',
            run_started_at: '2026-01-01',
          },
        ],
      },
    }));
    const response = await app.request('/api/board/scope-approvals/approval-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(revokeBody),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).rerun).toBe('requested');
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 2 }));

    rerun.mockImplementationOnce(async () => {
      throw new Error('network failed');
    });
    const failed = await app.request('/api/board/scope-approvals/approval-1/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(revokeBody),
    });
    expect(failed.status).toBe(200);
    expect((await failed.json()).rerun).toBe('failed');
  });

  test('revoke_rerun_selects_trusted_run_and_survives_denied_permission', async () => {
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
            id: 20,
            path: '.github/workflows/sneaky.yml',
            head_sha: S,
            head_branch: 'feature',
            run_started_at: '2026-01-02',
          },
          {
            id: 10,
            path: '.github/workflows/ce-change-scope-gate.yml',
            head_sha: S,
            head_branch: 'feature',
            run_started_at: '2026-01-01',
          },
        ],
      },
    }));
    rerun.mockImplementationOnce(async () => {
      throw { status: 403 };
    });

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
    expect((await response.json()).rerun).toBe('unavailable');
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(rerun).toHaveBeenCalledWith(expect.objectContaining({ run_id: 10 }));
  });
});
