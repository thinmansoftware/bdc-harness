import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

const authenticate = mock(async () => ({ principal_id: 'p', seat_id: 'xo' as const, roles: [] }));
const record = mock(async (input: { repo: string }) => input.repo === 'thinmansoftware/lspro-react'
  ? { ok: true as const, created: true, approval: { approval_id: crypto.randomUUID() } }
  : { ok: false as const, reason: 'repo_not_allowed' as const });
const revoke = mock(async () => ({ ok: true as const, rerun: 'requested' as const, credential_class: 'github_token' }));
const decision = mock(async () => ({ decision: 'deny' as const, reason: 'no_record' as const }));
mock.module('@archon/core/db/board-authority', () => ({ authenticateBoardPrincipal: authenticate }));
mock.module('@archon/core/db/board-scope-approvals', () => ({ recordScopeApproval: record, revokeScopeApproval: revoke, getScopeApprovalDecision: decision }));

const { registerApiRoutes } = await import('./api');

function app() {
  const instance = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerApiRoutes(instance, {} as WebAdapter, {} as ConversationLockManager);
  return instance;
}

beforeEach(() => {
  authenticate.mockClear(); record.mockClear(); revoke.mockClear(); decision.mockClear();
  decision.mockImplementation(async () => ({ decision: 'deny' as const, reason: 'no_record' as const }));
});

describe('CE scope approval API', () => {
  test('returns repo_not_allowed from the handler instead of schema validation', async () => {
    const response = await app().request('/api/board/scope-approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ holder_id: 'h', holder_token: 't', fencing_token: 1, repo: 'other/repo', pr_number: 1, head_sha: 'a'.repeat(40), conditions: 'ok', evidence_url: 'https://example.test/e' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'repo_not_allowed' });
    expect(record).toHaveBeenCalledTimes(1);
  });

  test('public read needs no auth, validates exact query, and fails closed', async () => {
    const valid = `/api/public/board/scope-approvals?repo=r&pr_number=1&head_sha=${'a'.repeat(40)}&base_sha=${'b'.repeat(40)}`;
    expect(await (await app().request(valid)).json()).toEqual({ decision: 'deny', reason: 'no_record' });
    expect(authenticate).not.toHaveBeenCalled();
    const malformed = await app().request('/api/public/board/scope-approvals?repo=r&pr_number=nope');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ decision: 'deny', reason: 'invalid_query' });
    decision.mockImplementation(async () => { throw new Error('store down'); });
    const failed = await app().request(valid);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ decision: 'deny', reason: 'server_error' });
  });

  test('revoke authenticates and returns rerun contract', async () => {
    const response = await app().request(`/api/board/scope-approvals/${crypto.randomUUID()}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ holder_id: 'h', holder_token: 't', fencing_token: 1, reason: 'withdrawn' }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rerun: 'requested', credential_class: 'github_token' });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
