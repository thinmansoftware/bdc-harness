import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

const cardId = 'a'.repeat(64);
const payloadDigest = 'b'.repeat(64);
const job = (channel: 'dispatch' | 'builder_monitor' | 'notion') => ({
  card_id: cardId,
  channel,
  state: 'pending',
  attempts_started: 0,
  next_attempt_at: '2026-07-16T08:00:00.000Z',
  lease_owner: null,
  lease_expires_at: null,
  fencing_token: 0,
  updated_at: '2026-07-16T08:00:00.000Z',
});
const view = {
  card: {
    card_id: cardId,
    identity_version: 'overseer-actionable-event-v1',
    canonical_event_identity: { source_event_id: 'event-1' },
    payload_digest: payloadDigest,
    payload: { blocker: 'gate rejected' },
    run_id: 'run-1',
    wo_id: 'WO-1',
    repository: 'bluedevilcollectibles/bdc-harness',
    branch: 'feat/test',
    pr_url: null,
    pr_number: null,
    head_sha: null,
    base_branch: 'dev',
    base_sha: null,
    checks: {},
    mergeability: 'unknown',
    blocker: 'gate rejected',
    mechanical_evidence: {},
    recovery_attempted: {},
    proposed_remediation: {},
    next_permitted_action: 'await operator ruling',
    responsible_actor: 'acting-xo',
    actionable_event_at: '2026-07-16T08:00:00.000Z',
    required_ruling: 'approve repair',
    evidence_links: {},
    lifecycle_classification: 'recovery',
    governance_classification: 'information-only',
    created_at: '2026-07-16T08:00:00.000Z',
  },
  jobs: [job('builder_monitor'), job('dispatch'), job('notion')],
  receipts: [],
  delivery_summary: {
    builder_monitor: job('builder_monitor'),
    dispatch: job('dispatch'),
    notion: job('notion'),
  },
};

mock.module('@archon/core/db/overseer-briefing', () => ({
  listOperatorCards: mock(async () => ({ items: [view], next_cursor: null })),
  getOperatorCard: mock(async (id: string) => (id === cardId ? view : null)),
}));
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
    bindings: mock(() => ({})),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => []),
  getCommandFolderSearchPaths: mock(() => []),
  getDefaultCommandsPath: mock(() => '/tmp/commands'),
  getDefaultWorkflowsPath: mock(() => '/tmp/workflows'),
  getArchonWorkspacesPath: () => '/tmp/workspaces',
  getArchonHome: () => '/tmp/archon',
  getRunArtifactsPath: () => '/tmp/artifacts',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));
mockAllWorkflowModules();
mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (value: string) => value,
  toWorktreePath: (value: string) => value,
}));
mock.module('@archon/core/db/conversations', () => ({ listConversations: mock(async () => []) }));
mock.module('@archon/core/db/codebases', () => ({ listCodebases: mock(async () => []) }));
mock.module('@archon/core/db/env-vars', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    drained: false,
    updatedAt: null,
  })),
}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
    emitSSE: mock(async () => {}),
  } as unknown as WebAdapter;
  const locks = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, locks);
  return app;
}

describe('read-only overseer briefing feed', () => {
  const priorOperatorAuthDisabled = process.env.ARCHON_OPERATOR_AUTH_DISABLED;
  beforeAll(() => {
    process.env.ARCHON_OPERATOR_AUTH_DISABLED = 'true';
  });
  afterAll(() => {
    if (priorOperatorAuthDisabled === undefined) {
      delete process.env.ARCHON_OPERATOR_AUTH_DISABLED;
    } else {
      process.env.ARCHON_OPERATOR_AUTH_DISABLED = priorOperatorAuthDisabled;
    }
    expect(process.env.ARCHON_OPERATOR_AUTH_DISABLED).toBe(priorOperatorAuthDisabled);
  });
  beforeEach(() => {
    setBoardPrincipalResolverForTests(async proof => {
      if (proof.principal_token !== 'valid') throw new Error('board_principal_auth_rejected');
      return { principal_id: 'xo', seat_id: 'xo', roles: ['acting_xo'], principal_token: 'valid' };
    });
  });
  afterEach(() => setBoardPrincipalResolverForTests(undefined));

  test('returns list/detail payload parity to an authenticated board principal', async () => {
    const app = makeApp();
    const headers = { 'x-board-principal-token': 'valid' };
    const list = await app.request('/api/overseer/operator-cards', { headers });
    const detail = await app.request(`/api/overseer/operator-cards/${cardId}`, { headers });
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    const listBody = (await list.json()) as { items: (typeof view)[] };
    const detailBody = (await detail.json()) as typeof view;
    expect(listBody.items[0].card.payload_digest).toBe(payloadDigest);
    expect(detailBody.card).toEqual(listBody.items[0].card);
  });

  test('rejects missing authority, returns 404, and exposes no write route', async () => {
    const app = makeApp();
    expect((await app.request('/api/overseer/operator-cards')).status).toBe(401);
    expect(
      (
        await app.request(`/api/overseer/operator-cards/${'c'.repeat(64)}`, {
          headers: { 'x-board-principal-token': 'valid' },
        })
      ).status
    ).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await app.request('/api/overseer/operator-cards', { method })).status).toBe(404);
    }
  });
});
