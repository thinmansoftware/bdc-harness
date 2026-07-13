import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

const TARGET_SHA = 'a'.repeat(40);

const sampleClaim = {
  claim_id: 'claim-1',
  motion_id: 'M-27',
  action_kind: 'production_deploy',
  environment: 'production',
  target_sha: TARGET_SHA,
  action_key: 'k'.repeat(64),
  motion_file_path: 'docs/board/motions/M-27.md',
  motion_revision_sha: 'b'.repeat(40),
  claimant_principal: 'xo-model',
  claimant_xo_holder_id: 'holder-1',
  claimant_xo_lease_id: 'lease-1',
  claimant_xo_fencing_token: 1,
  execution_fencing_token: 1,
  status: 'active',
  reconciliation_status: 'clear',
  effect_attempt_id: null,
  effect_attempt_state: 'none',
  effect_armed_at: null,
  acquired_at: '2026-07-13T00:00:00.000Z',
  renewed_at: null,
  expires_at: '2026-07-13T00:05:00.000Z',
  released_at: null,
  completed_at: null,
  external_effect_reference: null,
  completion_evidence: null,
  reconciliation_evidence: null,
};

// Reversible spies (installed in beforeEach, restored in afterEach) instead of
// mock.module, which is process-global and irreversible. Stop 1 runs this file in
// the SAME `bun test` invocation as execution-claims.test.ts, which exercises the
// REAL execution-claims module; a mock.module here would permanently replace it and
// break those tests. Namespace spyOn works because api.ts calls
// executionClaimsDb.<fn> through this same module namespace object at request time.
// The @archon/core/db/connection mock is intentionally omitted: these routes reach
// the db only through the (spied) execution-claims functions and the board-principal
// resolver DI seam, so they never call getDatabase() directly.
type Spy = ReturnType<typeof spyOn>;
let acquireSpy: Spy;
let getSpy: Spy;
const installedSpies: Spy[] = [];

function installExecutionClaimSpies(): void {
  acquireSpy = spyOn(executionClaimsDb, 'acquireExecutionClaim').mockImplementation((async () => ({
    ok: true as const,
    claim: sampleClaim,
    created: true as const,
    outcome: 'acquired' as const,
  })) as never);
  getSpy = spyOn(executionClaimsDb, 'getExecutionClaim').mockImplementation(
    (async () => sampleClaim as Record<string, unknown> | null) as never
  );
  const renewSpy = spyOn(executionClaimsDb, 'renewExecutionClaim').mockImplementation(
    (async () => ({ ok: true, claim: sampleClaim })) as never
  );
  const validateSpy = spyOn(executionClaimsDb, 'validateExecutionFence').mockImplementation(
    (async () => ({
      ok: true,
      claim_id: 'claim-1',
      permitted: true,
      effect_attempt_id: 'attempt-1',
      execution_fencing_token: 1,
      motion_revision_sha: 'b'.repeat(40),
    })) as never
  );
  const markSpy = spyOn(
    executionClaimsDb,
    'markExecutionReconciliationRequired'
  ).mockImplementation((async () => ({ ok: true, claim: sampleClaim })) as never);
  const resolveSpy = spyOn(executionClaimsDb, 'resolveExecutionReconciliation').mockImplementation(
    (async () => ({ ok: true, claim: sampleClaim })) as never
  );
  const releaseSpy = spyOn(executionClaimsDb, 'releaseExecutionClaim').mockImplementation(
    (async () => ({ ok: true, claim: sampleClaim })) as never
  );
  const completeSpy = spyOn(executionClaimsDb, 'completeExecutionClaim').mockImplementation(
    (async () => ({ ok: true, claim: sampleClaim })) as never
  );
  installedSpies.push(
    acquireSpy,
    getSpy,
    renewSpy,
    validateSpy,
    markSpy,
    resolveSpy,
    releaseSpy,
    completeSpy
  );
}

function restoreExecutionClaimSpies(): void {
  for (const spy of installedSpies) spy.mockRestore();
  installedSpies.length = 0;
}

mock.module('@archon/core/db/dispatch', () => ({
  createMessage: mock(async () => ({})),
  listMessages: mock(async () => []),
  claimMessage: mock(async () => null),
  postResult: mock(async () => null),
  cancelMessage: mock(async () => null),
  registerWorker: mock(async () => ({})),
  heartbeatWorker: mock(async () => null),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x' })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/env-vars', () => ({
  listEnvVars: mock(async () => []),
  setEnvVar: mock(async () => null),
  deleteEnvVar: mock(async () => false),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    drained: false,
    updatedAt: null,
  })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';
import * as executionClaimsDb from '@archon/core/db/execution-claims';

function makeApp(token?: string): OpenAPIHono {
  if (token) {
    process.env.ARCHON_OPERATOR_TOKEN = token;
  } else {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  }
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

const TOKEN = 'secret-token';
const authHeaders = {
  'Content-Type': 'application/json',
  'x-archon-operator-token': TOKEN,
  'x-board-principal-token': 'board-token',
  'x-xo-holder-token': 'holder-session-secret',
};

function acquireBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    motion_id: 'M-27',
    action_kind: 'production_deploy',
    environment: 'production',
    target_sha: TARGET_SHA,
    motion_file_path: 'docs/board/motions/M-27.md',
    xo_holder_id: 'holder-1',
    xo_lease_id: 'lease-1',
    xo_fencing_token: 1,
    ...over,
  });
}

function fenceBody(): string {
  return JSON.stringify({
    execution_fencing_token: 1,
    xo_holder_id: 'holder-1',
    xo_lease_id: 'lease-1',
    xo_fencing_token: 1,
  });
}

describe('execution claims API', () => {
  beforeEach(() => {
    installExecutionClaimSpies();
    setBoardPrincipalResolverForTests(async () => ({
      principal_id: 'xo-model',
      seat_id: 'xo',
      roles: ['acting_xo'],
    }));
  });

  afterEach(() => {
    setBoardPrincipalResolverForTests(undefined);
    restoreExecutionClaimSpies();
  });

  test('requires operator token for acquire when configured', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/board/execution-claims/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: acquireBody(),
    });
    expect(response.status).toBe(401);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  test('rejects unknown body fields with a strict schema failure', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/board/execution-claims/acquire', {
      method: 'POST',
      headers: authHeaders,
      body: acquireBody({ surprise: 'field' }),
    });
    expect(response.status).toBe(400);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  test('rejects a non-hex target SHA', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/board/execution-claims/acquire', {
      method: 'POST',
      headers: authHeaders,
      body: acquireBody({ target_sha: 'nothex' }),
    });
    expect(response.status).toBe(400);
  });

  test('requires the XO holder token header', async () => {
    const app = makeApp(TOKEN);
    const { 'x-xo-holder-token': _omit, ...noHolder } = authHeaders;
    const response = await app.request('/api/board/execution-claims/acquire', {
      method: 'POST',
      headers: noHolder,
      body: acquireBody(),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authority_rejected');
  });

  test('acquire returns 201 and forwards the authenticated initiator identity', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/board/execution-claims/acquire', {
      method: 'POST',
      headers: authHeaders,
      body: acquireBody(),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { claim: { claim_id: string }; outcome: string };
    expect(body.claim.claim_id).toBe('claim-1');
    expect(body.outcome).toBe('acquired');
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    const arg = acquireSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.initiator_seat_id).toBe('xo');
    expect(arg.initiator_principal_id).toBe('xo-model');
    expect(arg.xo_holder_token).toBe('holder-session-secret');
  });

  test('every mutation route is mounted, protected, and reachable', async () => {
    const app = makeApp(TOKEN);
    const routes: Array<[string, string]> = [
      [
        '/api/board/execution-claims/claim-1/renew',
        JSON.stringify({
          execution_fencing_token: 1,
          xo_holder_id: 'holder-1',
          xo_lease_id: 'lease-1',
          xo_fencing_token: 1,
        }),
      ],
      ['/api/board/execution-claims/claim-1/pre-effect', fenceBody()],
      [
        '/api/board/execution-claims/claim-1/reconciliation-required',
        JSON.stringify({
          execution_fencing_token: 1,
          xo_holder_id: 'holder-1',
          xo_lease_id: 'lease-1',
          xo_fencing_token: 1,
          effect_attempt_id: 'attempt-1',
          uncertainty: { reported_at: '2026-07-13T00:00:00Z', summary: 'uncertain' },
        }),
      ],
      [
        '/api/board/execution-claims/claim-1/reconcile',
        JSON.stringify({
          execution_fencing_token: 1,
          xo_holder_id: 'holder-1',
          xo_lease_id: 'lease-1',
          xo_fencing_token: 1,
          effect_attempt_id: 'attempt-1',
          resolution: 'retryable',
          evidence: {
            observed_at: '2026-07-13T00:00:00Z',
            checked_by: 'xo-model',
            command_or_source: 'live status probe',
            observed_state: 'not_started',
            evidence_reference: 'ref',
          },
        }),
      ],
      ['/api/board/execution-claims/claim-1/release', fenceBody()],
      [
        '/api/board/execution-claims/claim-1/complete',
        JSON.stringify({
          execution_fencing_token: 1,
          xo_holder_id: 'holder-1',
          xo_lease_id: 'lease-1',
          xo_fencing_token: 1,
          effect_attempt_id: 'attempt-1',
          external_effect_reference: 'ref-1',
          evidence: {
            verified_target_sha: TARGET_SHA,
            active_work_count: 0,
            backup_ready: true,
            rollback_ready: true,
            deployment_health: 'green',
            post_deploy_evidence: 'evidence',
          },
        }),
      ],
    ];

    for (const [path, body] of routes) {
      const unauth = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(unauth.status).toBe(401);

      const authed = await app.request(path, { method: 'POST', headers: authHeaders, body });
      expect(authed.status).toBe(200);
    }
  });

  test('pre-effect returns the armed permission payload', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/board/execution-claims/claim-1/pre-effect', {
      method: 'POST',
      headers: authHeaders,
      body: fenceBody(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { permitted: boolean; effect_attempt_id: string };
    expect(body.permitted).toBe(true);
    expect(body.effect_attempt_id).toBe('attempt-1');
  });

  test('get by action identity returns the claim, or 404 when absent', async () => {
    const app = makeApp(TOKEN);
    const query = `motion_id=M-27&action_kind=production_deploy&environment=production&target_sha=${TARGET_SHA}`;
    const found = await app.request(`/api/board/execution-claims?${query}`, {
      method: 'GET',
      headers: { 'x-archon-operator-token': TOKEN },
    });
    expect(found.status).toBe(200);

    getSpy.mockImplementation(async () => null);
    const missing = await app.request(`/api/board/execution-claims?${query}`, {
      method: 'GET',
      headers: { 'x-archon-operator-token': TOKEN },
    });
    expect(missing.status).toBe(404);
  });
});
