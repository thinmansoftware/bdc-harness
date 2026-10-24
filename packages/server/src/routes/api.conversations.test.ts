import { describe, test, expect, mock, spyOn } from 'bun:test';
import * as providerWaitScheduler from '@archon/workflows/reliability/wait-scheduler';
import type { IWorkflowStore } from '@archon/workflows/store';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  mockAllWorkflowModules,
  mockDiscoverWorkflowsWithConfig,
} from '../test/workflow-mock-factories';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { dispatchBindingSchema } from '@archon/workflows/reliability/dispatch-binding';

// The operator-token gate in registerApiRoutes() activates whenever
// ARCHON_OPERATOR_TOKEN is set. Clear it at module level so these tests run
// deterministically in container envs (Cauldron build image exports this var).
delete process.env.ARCHON_OPERATOR_TOKEN;
delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

const mockFindConversationByPlatformId = mock(
  async (_platformId: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

const mockGenerateAndSetTitle = mock(async () => {});
const mockHandleMessage = mock(async (..._args: unknown[]) => {});
mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  generateAndSetTitle: mockGenerateAndSetTitle,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
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
}));

mockAllWorkflowModules();

const mockGetOrCreateConversation = mock(
  async (_platform?: string, _platformId?: string, _codebaseId?: string | null) => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
  })
);
const mockContinuationGetConversation = mock(async (id: string) => ({
  id,
  platform_type: 'web',
  platform_conversation_id: 'web-' + id,
}));
mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  getConversationById: mockContinuationGetConversation,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mock(async () => []),
  getOrCreateConversation: mockGetOrCreateConversation,
}));

mock.module('@archon/core/db/isolation-environments', () => ({}));
const mockContinuationGetRun = mock(async (_id: string): Promise<WorkflowRun | null> => null);
const mockContinuationResume = mock(async (_id: string) => {});
const mockContinuationUpdate = mock(async (_id: string, _update: unknown) => {});
const mockContinuationCancel = mock(async (_id: string) => {});
const mockContinuationEvent = mock(async (_event: unknown) => {});
const mockContinuationExecute = mock(async () => ({ success: true }));
const mockContinuationDeps = mock(() => ({}));
const mockContinuationLane = mock(
  async (request: { workflowName?: string }) => request.workflowName
);
mock.module('@archon/core/db/workflows', () => ({
  getWorkflowRun: mockContinuationGetRun,
  resumeWorkflowRunFromPause: mockContinuationResume,
  updateWorkflowRun: mockContinuationUpdate,
  cancelWorkflowRun: mockContinuationCancel,
}));
mock.module('@archon/core/db/workflow-events', () => ({
  createWorkflowEvent: mockContinuationEvent,
}));
mock.module('@archon/core/workflows', () => ({ createWorkflowDeps: mockContinuationDeps }));
mock.module('@archon/workflows/executor', () => ({ executeWorkflow: mockContinuationExecute }));
mock.module('../adapters/web/workflow-bridge', () => ({ resolveWebLane: mockContinuationLane }));
const mockAddMessage = mock(async (_convId: string, _role: string, _content: string) => ({
  id: 'msg-uuid-1',
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));
const mockAdmissionCodebase = mock(async (_id?: string) => null as { default_cwd: string } | null);
const mockAdmissionCodexGate = mock(async () => ({ fresh: true, reason: 'test fixture' }));
mock.module('@archon/providers/auth-refresh/dispatch-gate', () => ({
  checkCodexDispatchGate: mockAdmissionCodexGate,
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mockAdmissionCodebase,
}));

const mockWaitTaskmasterStart = mock(() => {});
const mockWaitDeadmanStart = mock(() => {});
const mockWaitInboxStart = mock(() => {});
const mockWaitConsumerStart = mock(() => {});
mock.module('../taskmaster/loop', () => ({
  startTaskmaster: mockWaitTaskmasterStart,
  getTaskmasterRuntime: mock(() => null),
  getTickHealth: mock(() => 'test'),
}));
mock.module('@archon/overseer/taskmaster-deadman-check', () => ({
  startTaskmasterDeadmanChecker: mockWaitDeadmanStart,
}));
mock.module('../dispatch/operator-inbox-consumer', () => ({
  startOperatorInboxConsumer: mockWaitConsumerStart,
}));
mock.module('../dispatch/inbox-reader', () => ({
  startInboxReader: mockWaitInboxStart,
  shouldStartOperatorInboxConsumer: mock(() => false),
}));

import { registerApiRoutes, stopProviderWaitScheduler } from './api';

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

describe('binding-v2 shared DTO foundation', () => {
  const binding = {
    version: 'codex-only-v2',
    project: 'shopops',
    codebaseId: 'owned-codebase-id',
    codebaseName: 'shopops',
    defaultCwd: '/work/shopops',
    workflowName: 'bdc-feature-development-codex-only',
    workflowSha256: 'a'.repeat(64),
  };

  test('accepts the exact v2 comparison fields without changing identity', () => {
    expect(dispatchBindingSchema.parse(binding)).toEqual(binding);
    const reversed = Object.fromEntries(Object.entries(binding).reverse());
    expect(JSON.stringify(dispatchBindingSchema.parse(reversed))).toBe(JSON.stringify(binding));
    expect(Object.keys(reversed)[0]).toBe('workflowSha256');
  });

  test('requires every comparison field and string value', () => {
    for (const field of Object.keys(binding)) {
      const missing: Record<string, unknown> = { ...binding };
      delete missing[field];
      expect(dispatchBindingSchema.safeParse(missing).success).toBe(false);
      expect(dispatchBindingSchema.safeParse({ ...binding, [field]: null }).success).toBe(false);
      expect(dispatchBindingSchema.safeParse({ ...binding, [field]: 7 }).success).toBe(false);
    }
    for (const invalid of [null, [], 'binding', 7]) {
      expect(dispatchBindingSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('rejects unknown fields instead of dropping authority or model inputs', () => {
    for (const field of ['model', 'provider', 'workflow', 'token', 'unexpected']) {
      expect(dispatchBindingSchema.safeParse({ ...binding, [field]: 'extra' }).success).toBe(false);
    }
  });

  test('rejects whitespace-only identity without trimming valid values', () => {
    for (const field of ['project', 'codebaseId', 'codebaseName'] as const) {
      for (const value of [' ', '   ', '\u00a0']) {
        expect(dispatchBindingSchema.safeParse({ ...binding, [field]: value }).success).toBe(false);
      }
    }
  });

  test('requires the exact protocol version and reserved workflow', () => {
    for (const version of ['codex-only-v1', 'codex-only-v3', 'CODEX-ONLY-V2', 'codex-only-v2 ']) {
      expect(dispatchBindingSchema.safeParse({ ...binding, version }).success).toBe(false);
    }
    for (const workflowName of [
      'default',
      'codex',
      '/workflow run bdc-feature-development-codex-only',
    ]) {
      expect(dispatchBindingSchema.safeParse({ ...binding, workflowName }).success).toBe(false);
    }
  });

  test('accepts only a lowercase full SHA256 digest', () => {
    for (const workflowSha256 of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
    ]) {
      expect(dispatchBindingSchema.safeParse({ ...binding, workflowSha256 }).success).toBe(false);
    }
  });

  test('enforces exact identity limits without trimming or truncating', () => {
    for (const [field, maximum] of [
      ['project', 512],
      ['codebaseId', 128],
      ['codebaseName', 512],
    ] as const) {
      const value = 'x'.repeat(maximum);
      expect(dispatchBindingSchema.parse({ ...binding, [field]: value })[field]).toBe(value);
      expect(dispatchBindingSchema.safeParse({ ...binding, [field]: value + 'x' }).success).toBe(
        false
      );
      expect(dispatchBindingSchema.safeParse({ ...binding, [field]: '' }).success).toBe(false);
    }
    const defaultCwd = '/' + 'x'.repeat(4095);
    expect(dispatchBindingSchema.parse({ ...binding, defaultCwd }).defaultCwd).toBe(defaultCwd);
    expect(
      dispatchBindingSchema.safeParse({ ...binding, defaultCwd: defaultCwd + 'x' }).success
    ).toBe(false);
    const literal = { ...binding, project: ' ShopOps ', defaultCwd: '/work/../shopops/' };
    expect(dispatchBindingSchema.parse(literal)).toEqual(literal);
  });

  test('rejects C0, DEL and C1 controls in identity fields and cwd', () => {
    for (const field of ['project', 'codebaseId', 'codebaseName', 'defaultCwd'] as const) {
      for (const control of ['\u0000', '\n', '\u007f', '\u0085']) {
        expect(
          dispatchBindingSchema.safeParse({ ...binding, [field]: binding[field] + control }).success
        ).toBe(false);
      }
    }
  });

  test('retains existing cross-platform lexical absolute-path semantics', () => {
    // Matching the preflight predicate is not proof of filesystem ownership or accessibility.
    for (const defaultCwd of [
      '/work/shopops',
      'C:\\work\\shopops',
      'C:/work/shopops',
      '\\\\host\\share\\shopops',
      '\\shopops',
    ]) {
      expect(dispatchBindingSchema.parse({ ...binding, defaultCwd }).defaultCwd).toBe(defaultCwd);
    }
    for (const defaultCwd of ['', 'shopops', '../shopops', 'C:shopops']) {
      expect(dispatchBindingSchema.safeParse({ ...binding, defaultCwd }).success).toBe(false);
    }
  });

  test('keeps unenforced v2 requests closed at the actual atomic API', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    const adapter = { setConversationDbId: mock(() => {}) } as unknown as WebAdapter;
    registerApiRoutes(app, adapter, {} as ConversationLockManager);
    const beforeCreate = mockGetOrCreateConversation.mock.calls.length;
    const beforeMessage = mockAddMessage.mock.calls.length;
    const beforeDispatch = mockHandleMessage.mock.calls.length;
    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codebaseId: binding.codebaseId,
        message: '/workflow run ' + binding.workflowName,
        dispatchBinding: binding,
      }),
    });
    expect(response.status).toBe(400);
    expect(mockGetOrCreateConversation.mock.calls.length).toBe(beforeCreate);
    expect(mockAddMessage.mock.calls.length).toBe(beforeMessage);
    expect(mockHandleMessage.mock.calls.length).toBe(beforeDispatch);
  });
});

describe('GET /api/conversations/:id', () => {
  test('returns conversation JSON by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('web-test-abc');
  });

  test('returns 404 for unknown platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 500 when DB throws unexpectedly', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get conversation');
  });
});

describe('DELETE /api/conversations/:id', () => {
  test('returns { success: true } when deleting by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockSoftDeleteConversation.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockSoftDeleteConversation).toHaveBeenCalledWith('internal-uuid-123');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('PATCH /api/conversations/:id', () => {
  test('resolves platform ID and updates title using internal ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('internal-uuid-123', 'New Title');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });

  test('returns { success: true } without calling updateConversationTitle when body has no title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const longTitle = 'a'.repeat(300);
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });
    expect(response.status).toBe(200);
    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });
});

describe('POST /api/conversations', () => {
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and returns auto-generated conversationId', async () => {
    const app = new OpenAPIHono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversationId: string; id: string };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
  });

  test('returns 400 if conversationId is provided in request body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'my-custom-id' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/conversations with message (atomic create+send)', () => {
  const mockLockManager = {
    acquireLock: mock(async (_convId: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' as const };
    }),
  } as unknown as ConversationLockManager;

  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitLockEvent: mock((_convId: string, _locked: boolean) => {}),
    emitSSE: mock(async (_convId: string, _data: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and dispatches message atomically', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBe(true);
  });

  test('persists user message during atomic creation', async () => {
    const callsBefore = mockAddMessage.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test message' }),
    });
    expect(mockAddMessage.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('generates title for non-command messages', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'help me debug this function' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('skips title generation for slash commands', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/status' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBe(callsBefore);
  });

  test('still works without message (backward compatible)', async () => {
    const simpleWebAdapter = {
      setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    } as unknown as WebAdapter;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, simpleWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched?: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBeUndefined();
  });

  // Regression: 2026-07-07 false-dispatch incident. Dispatching a retired /
  // nonexistent workflow via the atomic create+send path returned
  // {dispatched:true, accepted:true} and the failure only landed as an
  // assistant message inside the conversation -- fire.ps1 reported "run
  // started" twice for a lane that could never run. The dispatch endpoint
  // must validate the workflow name BEFORE accepting.
  describe('workflow-run pre-dispatch validation', () => {
    const makeWorkflow = (name: string): WorkflowDefinition =>
      ({ name, description: 'test', nodes: [{ id: 'n', prompt: 'p' }] }) as WorkflowDefinition;

    test('rejects /workflow run for a nonexistent workflow with accepted:false (no dispatch)', async () => {
      // Discovery mock returns [] by default -- no workflow can resolve.
      const acquireLock = mock(async (_convId: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, {
        acquireLock,
      } as unknown as ConversationLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '/workflow run bdc-feature-development-fusion-cx-qwen WO_ID=WO-TEST-01',
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        accepted: boolean;
        dispatched: boolean;
        error: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(body.error).toContain('bdc-feature-development-fusion-cx-qwen');
      // The orchestrator must never have been invoked.
      expect(acquireLock.mock.calls.length).toBe(0);
    });

    test('accepts /workflow run when the workflow resolves', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
        workflows: [
          { workflow: makeWorkflow('bdc-feature-development'), source: 'project' as const },
        ],
        errors: [],
      }));

      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, mockLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '/workflow run bdc-feature-development WO_ID=WO-TEST-01',
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);
    });

    test('non-workflow messages are not affected by validation', async () => {
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, mockLockManager);

      const response = await app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'plain chat message' }),
      });
      expect(response.status).toBe(200);
    });
  });

  // WO-HARNESS-ATOMIC-FIRE-FROM-BRANCH-01: atomic --from origin/<branch> override.
  describe('--from branch override (atomic fire)', () => {
    const makeWorkflow = (name: string, extra?: Partial<WorkflowDefinition>): WorkflowDefinition =>
      ({
        name,
        description: 'test',
        nodes: [{ id: 'n', prompt: 'p' }],
        ...extra,
      }) as WorkflowDefinition;

    const resolvingDiscovery = (wf: WorkflowDefinition) => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => ({
        workflows: [{ workflow: wf, source: 'project' as const }],
        errors: [],
      }));
    };

    const post = async (message: string, lock?: ConversationLockManager) => {
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(app, mockWebAdapter, lock ?? mockLockManager);
      return app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
    };

    test('valid --from origin/release/ce dispatches task hints to handleMessage', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from origin/release/ce'
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);

      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('task');
      expect(ctxArg?.isolationHints?.fromBranch).toBe('origin/release/ce');
      // workflowId keyed to the conversation at this layer (worker id assigned later).
      expect(ctxArg?.isolationHints?.workflowId).toBe('web-test-abc');
    });

    test('alias --from-branch behaves identically', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from-branch origin/release/ce'
      );
      expect(response.status).toBe(200);
      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('task');
      expect(ctxArg?.isolationHints?.fromBranch).toBe('origin/release/ce');
    });

    test('no --from preserves thread isolation (regression)', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();

      await post('/workflow run bdc-feature-development WO_ID=WO-X');
      const ctxArg = mockHandleMessage.mock.calls.at(-1)?.[3] as
        | { isolationHints?: Record<string, unknown> }
        | undefined;
      expect(ctxArg?.isolationHints?.workflowType).toBe('thread');
      expect(ctxArg?.isolationHints?.fromBranch).toBeUndefined();
    });

    test('discovery failure with --from fails closed before conversation creation', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => {
        throw new Error('workflow discovery unavailable');
      });
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      mockHandleMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from origin/release/ce',
        { acquireLock } as unknown as ConversationLockManager
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        accepted: boolean;
        dispatched: boolean;
        error: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(body.error).toContain('Workflow discovery');
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(0);
      expect(mockAddMessage).toHaveBeenCalledTimes(0);
      expect(mockHandleMessage).toHaveBeenCalledTimes(0);
      expect(acquireLock).toHaveBeenCalledTimes(0);
    });

    test('discovery failure without --from preserves graceful dispatch behavior', async () => {
      mockDiscoverWorkflowsWithConfig.mockImplementationOnce(async () => {
        throw new Error('workflow discovery unavailable');
      });
      mockGetOrCreateConversation.mockClear();
      mockHandleMessage.mockClear();

      const response = await post('/workflow run bdc-feature-development WO_ID=WO-X');

      expect(response.status).toBe(200);
      const body = (await response.json()) as { dispatched: boolean };
      expect(body.dispatched).toBe(true);
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
      expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    });

    test('non-origin value (bare release/ce) rejected 400 before conversation creation', async () => {
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post(
        '/workflow run bdc-feature-development WO_ID=WO-X --from release/ce',
        { acquireLock } as unknown as ConversationLockManager
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { accepted: boolean; dispatched: boolean };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      expect(mockGetOrCreateConversation.mock.calls.length).toBe(0);
      expect(mockAddMessage.mock.calls.length).toBe(0);
      expect(acquireLock.mock.calls.length).toBe(0);
    });

    test('missing --from value rejected 400', async () => {
      const response = await post('/workflow run bdc-feature-development WO_ID=WO-X --from');
      expect(response.status).toBe(400);
    });

    test('duplicate --from flags rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from origin/release/ce --from origin/main'
      );
      expect(response.status).toBe(400);
    });

    test('mixed --from/--from-branch flags rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from origin/release/ce --from-branch origin/main'
      );
      expect(response.status).toBe(400);
    });

    test('option-like value rejected 400', async () => {
      const response = await post(
        '/workflow run bdc-feature-development --from=-origin/release/ce'
      );
      expect(response.status).toBe(400);
    });

    test('invalid git ref (dot-dot) rejected 400', async () => {
      const response = await post('/workflow run bdc-feature-development --from origin/foo..bar');
      expect(response.status).toBe(400);
    });

    test('worktree.enabled:false workflow with valid --from rejected 400, no conversation', async () => {
      resolvingDiscovery(makeWorkflow('read-only-triage', { worktree: { enabled: false } }));
      mockGetOrCreateConversation.mockClear();
      mockAddMessage.mockClear();
      mockHandleMessage.mockClear();
      const acquireLock = mock(async (_c: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' as const };
      });

      const response = await post('/workflow run read-only-triage --from origin/release/ce', {
        acquireLock,
      } as unknown as ConversationLockManager);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { accepted: boolean; dispatched: boolean };
      expect(body.accepted).toBe(false);
      expect(body.dispatched).toBe(false);
      // The API boundary rejects before any workflow dispatch. Therefore no
      // conversation/worker, workflow-run path, or isolation path is reachable.
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(0);
      expect(mockAddMessage).toHaveBeenCalledTimes(0);
      expect(mockHandleMessage).toHaveBeenCalledTimes(0);
      expect(acquireLock).toHaveBeenCalledTimes(0);
    });

    test('two valid fires get independent conversation-keyed hints (idempotency)', async () => {
      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockHandleMessage.mockClear();
      mockGetOrCreateConversation.mockImplementationOnce(async (_platform, platformId) => ({
        id: 'internal-uuid-fire-a',
        platform_conversation_id: platformId ?? 'missing-fire-a',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_type: 'web',
        deleted_at: null,
        codebase_id: null,
      }));
      await post('/workflow run bdc-feature-development WO_ID=WO-A --from origin/release/ce');
      const first = mockHandleMessage.mock.calls.at(-1)?.[3] as {
        isolationHints?: Record<string, unknown>;
      };

      resolvingDiscovery(makeWorkflow('bdc-feature-development'));
      mockGetOrCreateConversation.mockImplementationOnce(async (_platform, platformId) => ({
        id: 'internal-uuid-fire-b',
        platform_conversation_id: platformId ?? 'missing-fire-b',
        title: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_type: 'web',
        deleted_at: null,
        codebase_id: null,
      }));
      await post('/workflow run bdc-feature-development WO_ID=WO-B --from origin/release/ce');
      const second = mockHandleMessage.mock.calls.at(-1)?.[3] as {
        isolationHints?: Record<string, unknown>;
      };

      expect(first?.isolationHints?.fromBranch).toBe('origin/release/ce');
      expect(second?.isolationHints?.fromBranch).toBe('origin/release/ce');
      expect(first?.isolationHints?.workflowType).toBe('task');
      expect(second?.isolationHints?.workflowType).toBe('task');
      expect(first?.isolationHints?.workflowId).not.toBe(second?.isolationHints?.workflowId);
    });
  });
});

// Regression tests for non-web adapter conversations (Gitea, GitHub forge adapters)
// Platform conversation IDs from forge adapters contain slashes and # characters:
// e.g. "CyberFitz-LLC/devops-platform#24" -- these must be URL-encoded by the client
// and correctly decoded by the server route params.
// Ref: https://github.com/coleam00/Archon/issues/476
describe('GET /api/conversations/:id -- forge platform IDs with encoded slashes', () => {
  const GITEA_CONV = {
    id: 'gitea-internal-uuid',
    platform_conversation_id: 'CyberFitz-LLC/devops-platform#24',
    title: 'feat: add context enrichment',
    created_at: new Date(),
    updated_at: new Date(),
    platform_type: 'gitea',
    deleted_at: null,
    codebase_id: null,
  };

  test('finds gitea conversation when ID contains encoded slash and hash', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      // Server should receive the decoded platform ID (slashes + # restored)
      expect(platformId).toBe('CyberFitz-LLC/devops-platform#24');
      return GITEA_CONV;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Client must URL-encode the ID: %2F for slash, %23 for #
    const response = await app.request('/api/conversations/CyberFitz-LLC%2Fdevops-platform%2324');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      platform_conversation_id: string;
      platform_type: string;
    };
    expect(body.platform_conversation_id).toBe('CyberFitz-LLC/devops-platform#24');
    expect(body.platform_type).toBe('gitea');
  });

  test('finds gitea PR conversation with ! separator when ID is encoded', async () => {
    const giteaPRConv = {
      ...GITEA_CONV,
      platform_conversation_id: 'owner/repo!42',
      platform_type: 'gitea',
    };

    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      expect(platformId).toBe('owner/repo!42');
      return giteaPRConv;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/owner%2Frepo!42');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('owner/repo!42');
  });

  test('returns 404 for unknown gitea conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/unknown-org%2Funknown-repo%2399');
    expect(response.status).toBe(404);
  });
});

describe('binding-v2 API closed admission', () => {
  const reserved = 'bdc-feature-development-codex-only';
  const reservedWorkflow = {
    name: reserved,
    description: 'Owned in-memory API fixture',
    provider: 'codex',
    nodes: [{ id: 'n', prompt: 'No provider runs in this test' }],
  } as WorkflowDefinition;

  function setup(workflow: WorkflowDefinition = reservedWorkflow, scoped = false) {
    mockGetOrCreateConversation.mockClear();
    mockAddMessage.mockClear();
    mockUpdateConversationTitle.mockClear();
    mockGenerateAndSetTitle.mockClear();
    mockHandleMessage.mockClear();
    mockAdmissionCodebase.mockReset();
    mockAdmissionCodebase.mockImplementation(async () =>
      scoped ? { default_cwd: '/tmp/project' } : null
    );
    mockAdmissionCodexGate.mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [{ workflow, source: 'project' as const }],
      errors: [],
    }));
    const mapping = mock(() => {});
    const acquireLock = mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' as const };
    });
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(
      app,
      {
        setConversationDbId: mapping,
        emitLockEvent: mock(() => {}),
        emitSSE: mock(async () => {}),
      } as unknown as WebAdapter,
      { acquireLock } as unknown as ConversationLockManager
    );
    const post = (message: string) =>
      app.request('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          ...(scoped ? { codebaseId: 'owned-in-memory-project' } : {}),
        }),
      });
    return { post, mapping, acquireLock };
  }

  async function expectClosed(response: Response, effects: ReturnType<typeof setup>) {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      accepted: false,
      dispatched: false,
      error: 'Codex-only dispatch is not available yet.',
    });
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
    expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    expect(effects.mapping).not.toHaveBeenCalled();
    expect(effects.acquireLock).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockAdmissionCodexGate).not.toHaveBeenCalled();
  }

  test.each(['canonical', 'case', 'whitespace', 'discovery-unavailable', 'scoped'])(
    'refuses canonical token before discovery and atomic writes: %s',
    async mode => {
      const effects = setup(reservedWorkflow, mode === 'scoped');
      if (mode === 'discovery-unavailable') {
        mockDiscoverWorkflowsWithConfig.mockImplementation(async () => {
          throw new Error('fixture discovery unavailable');
        });
      }
      const token = mode === 'case' ? reserved.toUpperCase() : reserved;
      const message =
        mode === 'whitespace'
          ? `  /workflow   run\t${token} WO-fixture  `
          : `/workflow run ${token} WO-fixture`;
      await expectClosed(await effects.post(message), effects);
      expect(mockDiscoverWorkflowsWithConfig).not.toHaveBeenCalled();
    }
  );

  test.each(['codex-only', 'feature-development'])(
    'refuses actual reserved definition selected by real resolver: %s',
    async alias => {
      const effects = setup();
      await expectClosed(await effects.post(`/workflow run ${alias} WO-fixture`), effects);
      expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(1);
    }
  );

  test('ordinary workflow with reserved message text still dispatches', async () => {
    const effects = setup({ ...reservedWorkflow, name: 'ordinary', provider: 'claude' });
    const response = await effects.post(`/workflow run ordinary Discuss ${reserved}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(effects.acquireLock).toHaveBeenCalledTimes(1);
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
    expect(mockAdmissionCodexGate).not.toHaveBeenCalled();
  });

  test('ordinary Codex workflow still consults existing dispatch gate', async () => {
    const effects = setup({ ...reservedWorkflow, name: 'ordinary-codex' });
    expect((await effects.post('/workflow run ordinary-codex WO-fixture')).status).toBe(200);
    expect(mockAdmissionCodexGate).toHaveBeenCalledTimes(1);
    expect(effects.acquireLock).toHaveBeenCalledTimes(1);
  });

  test('ordinary discovery-error degradation remains unchanged', async () => {
    const effects = setup({ ...reservedWorkflow, name: 'ordinary' });
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => {
      throw new Error('ordinary discovery unavailable');
    });
    expect((await effects.post('/workflow run ordinary WO-fixture')).status).toBe(200);
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(1);
    expect(effects.acquireLock).toHaveBeenCalledTimes(1);
    expect(mockHandleMessage).toHaveBeenCalledTimes(1);
  });

  test('real ambiguous suffix remains rejected before atomic effects', async () => {
    const effects = setup();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [reservedWorkflow, { ...reservedWorkflow, name: 'other-codex-only' }].map(
        workflow => ({ workflow, source: 'project' as const })
      ),
      errors: [],
    }));
    const response = await effects.post('/workflow run codex-only WO-fixture');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('Ambiguous');
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
    expect(effects.acquireLock).not.toHaveBeenCalled();
    expect(mockAdmissionCodexGate).not.toHaveBeenCalled();
  });
});

describe('binding-v2 API continuation closed gate', () => {
  const reserved = 'bdc-feature-development-codex-only';

  function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id: 'owned-memory-run',
      workflow_name: 'ordinary-workflow',
      conversation_id: 'owned-memory-worker',
      parent_conversation_id: 'owned-memory-parent',
      codebase_id: null,
      status: 'paused',
      user_message: 'fixture',
      metadata: { paused_by: 'operator', approval: { nodeId: 'gate', message: 'fixture' } },
      started_at: new Date(0),
      completed_at: null,
      last_activity_at: null,
      working_path: '/owned-memory-worktree',
      archived_at: null,
      archived_by: null,
      archive_reason: null,
      ...overrides,
    };
  }

  function setup(run: WorkflowRun | null) {
    mockContinuationGetRun.mockReset();
    mockContinuationGetRun.mockImplementation(async () => run);
    for (const effect of [
      mockContinuationResume,
      mockContinuationUpdate,
      mockContinuationCancel,
      mockContinuationEvent,
      mockContinuationGetConversation,
      mockContinuationExecute,
      mockContinuationDeps,
      mockContinuationLane,
      mockHandleMessage,
      mockGetOrCreateConversation,
    ]) {
      effect.mockClear();
    }
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [
        {
          workflow: {
            name: run?.workflow_name ?? 'ordinary-workflow',
            description: 'Owned memory fixture',
            nodes: [{ id: 'n', prompt: 'fixture' }],
          },
          source: 'project' as const,
        },
      ],
      errors: [],
    }));
    const mapping = mock(() => {});
    const bridge = mock(() => () => {});
    const acquireLock = mock(async () => ({ status: 'started' as const }));
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(
      app,
      {
        setConversationDbId: mapping,
        setupEventBridge: bridge,
        emitLockEvent: mock(() => {}),
        emitSSE: mock(async () => {}),
      } as unknown as WebAdapter,
      { acquireLock } as unknown as ConversationLockManager
    );
    const post = (action: string) =>
      app.request('/api/workflows/runs/owned-memory-run/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    return { post, mapping, bridge, acquireLock };
  }

  function expectNoContinuation(effects: ReturnType<typeof setup>) {
    for (const effect of [
      mockContinuationResume,
      mockContinuationUpdate,
      mockContinuationCancel,
      mockContinuationEvent,
      mockContinuationGetConversation,
      mockContinuationExecute,
      mockContinuationDeps,
      mockContinuationLane,
      mockDiscoverWorkflowsWithConfig,
      mockHandleMessage,
      mockGetOrCreateConversation,
      effects.mapping,
      effects.bridge,
      effects.acquireLock,
    ])
      expect(effect).not.toHaveBeenCalled();
  }

  for (const action of ['resume', 'approve']) {
    for (const [label, marker] of [
      ['null', null],
      ['undefined', undefined],
      ['false', false],
      ['corrupt', 'corrupt'],
      ['v1', { version: 'codex-only-v1' }],
      ['v2', { version: 'codex-only-v2' }],
      ['unknown', { version: 'codex-only-v999' }],
    ] as const) {
      test('refuses ' + action + ' with own ' + label + ' marker before effects', async () => {
        const run = makeRun({
          metadata: {
            paused_by: 'operator',
            approval: { nodeId: 'gate', message: 'fixture' },
            codex_only_dispatch: marker,
          },
        });
        const before = structuredClone(run);
        const effects = setup(run);
        const response = await effects.post(action);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'codex_only_resume_unsupported' });
        expect(mockContinuationGetRun).toHaveBeenCalledTimes(1);
        expectNoContinuation(effects);
        expect(run).toEqual(before);
        expect(Object.hasOwn(run.metadata, 'codex_only_dispatch')).toBe(true);
      });
    }
    test('refuses named reserved ' + action + ' with missing marker', async () => {
      const run = makeRun({ workflow_name: reserved });
      const before = structuredClone(run);
      const effects = setup(run);
      const response = await effects.post(action);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'codex_only_resume_unsupported' });
      expectNoContinuation(effects);
      expect(run).toEqual(before);
    });
    test('preserves missing-run404 for ' + action, async () => {
      const effects = setup(null);
      const response = await effects.post(action);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Workflow run not found' });
      expectNoContinuation(effects);
    });
    test('preserves lookup-error500 for ' + action + ' without replacement', async () => {
      const effects = setup(null);
      mockContinuationGetRun.mockImplementation(async () => {
        throw new Error('owned lookup failure');
      });
      expect((await effects.post(action)).status).toBe(500);
      expectNoContinuation(effects);
    });
  }

  for (const status of ['failed', 'waiting_provider', 'completed'] as const) {
    test('refuses restricted approve ' + status + ' before idempotent success', async () => {
      const run = makeRun({
        status,
        metadata: {
          codex_only_dispatch: false,
          approval_response: 'approved',
          approval: { nodeId: 'gate', type: 'interactive_loop' },
        },
      });
      const before = structuredClone(run);
      const effects = setup(run);
      const response = await effects.post('approve');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'codex_only_resume_unsupported' });
      expectNoContinuation(effects);
      expect(run).toEqual(before);
    });
  }

  test('preserves ordinary operator-pause activation and event', async () => {
    const effects = setup(makeRun());
    expect((await effects.post('resume')).status).toBe(200);
    expect(mockContinuationResume).toHaveBeenCalledWith('owned-memory-run');
    expect(mockContinuationEvent).toHaveBeenCalledWith({
      workflow_run_id: 'owned-memory-run',
      event_type: 'run_resumed',
      data: { actor: 'operator' },
    });
    expect(mockContinuationExecute).not.toHaveBeenCalled();
  });
  test('preserves ordinary failed-run readiness without writes', async () => {
    const effects = setup(makeRun({ status: 'failed', metadata: {} }));
    const response = await effects.post('resume');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toContain('ready to resume');
    expectNoContinuation(effects);
  });
  for (const type of ['approval', 'interactive_loop']) {
    test('preserves ordinary ' + type + ' persistence', async () => {
      const effects = setup(
        makeRun({
          parent_conversation_id: null,
          metadata: { approval: { nodeId: 'gate', message: 'fixture', type } },
        })
      );
      expect((await effects.post('approve')).status).toBe(200);
      expect(mockContinuationUpdate).toHaveBeenCalledWith('owned-memory-run', {
        status: 'failed',
        metadata:
          type === 'interactive_loop'
            ? { loop_user_input: 'Approved' }
            : { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
      });
      expect(mockContinuationEvent).toHaveBeenCalledTimes(type === 'interactive_loop' ? 1 : 2);
      expect(mockContinuationGetConversation).not.toHaveBeenCalled();
      expect(mockContinuationExecute).not.toHaveBeenCalled();
    });
  }
  test('preserves ordinary already-approved idempotent response', async () => {
    const effects = setup(
      makeRun({ status: 'failed', metadata: { approval_response: 'approved' } })
    );
    const response = await effects.post('approve');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { message: string }).message).toContain('already approved');
    expectNoContinuation(effects);
  });
  test('keeps explicit abandonment available for a restricted run', async () => {
    const effects = setup(
      makeRun({
        workflow_name: reserved,
        metadata: { codex_only_dispatch: { version: 'codex-only-v2' } },
      })
    );
    expect((await effects.post('abandon')).status).toBe(200);
    expect(mockContinuationCancel).toHaveBeenCalledWith('owned-memory-run');
    expect(mockContinuationUpdate).not.toHaveBeenCalled();
    expect(mockContinuationEvent).not.toHaveBeenCalled();
    expect(mockContinuationExecute).not.toHaveBeenCalled();
  });

  describe('binding-v2 API rejection closed gate', () => {
    function approval(onRejectPrompt: unknown = 'Fix the rejected fixture', maximum?: number) {
      return {
        nodeId: 'gate',
        message: 'fixture',
        onRejectPrompt,
        ...(maximum === undefined ? {} : { onRejectMaxAttempts: maximum }),
      };
    }
    async function expectRefused(run: WorkflowRun) {
      const before = structuredClone(run);
      const effects = setup(run);
      const response = await effects.post('reject');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'codex_only_resume_unsupported' });
      expect(mockContinuationGetRun).toHaveBeenCalledTimes(1);
      expectNoContinuation(effects);
      expect(run).toEqual(before);
    }
    function expectNoLaunch(effects: ReturnType<typeof setup>) {
      for (const effect of [
        mockContinuationUpdate,
        mockContinuationResume,
        mockContinuationGetConversation,
        mockContinuationExecute,
        mockContinuationDeps,
        mockContinuationLane,
        mockDiscoverWorkflowsWithConfig,
        effects.mapping,
        effects.bridge,
        effects.acquireLock,
        mockHandleMessage,
      ])
        expect(effect).not.toHaveBeenCalled();
    }
    async function expectCancelled(run: WorkflowRun, limit = false) {
      const effects = setup(run);
      const response = await effects.post('reject');
      expect(response.status).toBe(200);
      if (limit)
        expect(((await response.json()) as { message: string }).message).toContain(
          'max attempts reached'
        );
      expect(mockContinuationCancel).toHaveBeenCalledTimes(1);
      expect(mockContinuationCancel).toHaveBeenCalledWith('owned-memory-run');
      expect(mockContinuationEvent).toHaveBeenCalledTimes(1);
      expect(mockContinuationEvent).toHaveBeenCalledWith({
        workflow_run_id: 'owned-memory-run',
        event_type: 'approval_received',
        step_name: 'gate',
        data: { decision: 'rejected', reason: 'Rejected' },
      });
      expectNoLaunch(effects);
    }

    for (const [label, marker] of [
      ['null', null],
      ['undefined', undefined],
      ['false', false],
      ['corrupt', 'corrupt'],
      ['v1', { version: 'codex-only-v1' }],
      ['v2', { version: 'codex-only-v2' }],
      ['unknown', { version: 'codex-only-v999' }],
    ] as const) {
      test(
        'refuses rejection continuation with own ' + label + ' marker before event',
        async () => {
          const run = makeRun({ metadata: { approval: approval(), codex_only_dispatch: marker } });
          await expectRefused(run);
          expect(Object.hasOwn(run.metadata, 'codex_only_dispatch')).toBe(true);
        }
      );
    }
    test('refuses named restricted rejection without marker before event', async () => {
      await expectRefused(makeRun({ workflow_name: reserved, metadata: { approval: approval() } }));
    });
    for (const [label, prompt] of [
      ['empty', ''],
      ['null', null],
      ['false', false],
      ['zero', 0],
    ] as const) {
      test(
        'treats ' + label + ' on-reject prompt as present under existing comparison',
        async () => {
          await expectRefused(
            makeRun({ workflow_name: reserved, metadata: { approval: approval(prompt) } })
          );
        }
      );
    }
    test('refuses below custom rejection limit without changing count', async () => {
      await expectRefused(
        makeRun({
          workflow_name: reserved,
          metadata: { approval: approval('Fix', 4), rejection_count: 2 },
        })
      );
    });
    test('refuses malformed numeric count under unchanged comparison semantics', async () => {
      await expectRefused(
        makeRun({
          workflow_name: reserved,
          metadata: { approval: approval(), rejection_count: 'not-a-number' },
        })
      );
    });
    test('preserves restricted no-handler cancellation', async () => {
      await expectCancelled(
        makeRun({
          workflow_name: reserved,
          metadata: {
            approval: { nodeId: 'gate', message: 'fixture' },
            codex_only_dispatch: false,
          },
        })
      );
    });
    test('preserves restricted default rejection-limit cancellation', async () => {
      await expectCancelled(
        makeRun({
          workflow_name: reserved,
          metadata: { approval: approval(), rejection_count: 2 },
        }),
        true
      );
    });
    test('preserves restricted custom rejection-limit cancellation', async () => {
      await expectCancelled(
        makeRun({ workflow_name: reserved, metadata: { approval: approval('Fix', 1) } }),
        true
      );
    });
    test('preserves restricted above-limit cancellation', async () => {
      await expectCancelled(
        makeRun({
          workflow_name: reserved,
          metadata: { approval: approval(), rejection_count: 5 },
        }),
        true
      );
    });
    test('preserves ordinary rejection continuation persistence', async () => {
      const effects = setup(
        makeRun({
          parent_conversation_id: null,
          metadata: { approval: approval(), rejection_count: 1 },
        })
      );
      const response = await effects.post('reject');
      expect(response.status).toBe(200);
      expect(mockContinuationEvent).toHaveBeenCalledTimes(1);
      expect(mockContinuationUpdate).toHaveBeenCalledWith('owned-memory-run', {
        status: 'failed',
        metadata: { rejection_reason: 'Rejected', rejection_count: 2 },
      });
      expect(mockContinuationCancel).not.toHaveBeenCalled();
      expect(mockContinuationGetConversation).not.toHaveBeenCalled();
      expect(mockContinuationExecute).not.toHaveBeenCalled();
    });
    test('preserves ordinary no-handler cancellation', async () => {
      await expectCancelled(makeRun());
    });
    test('preserves ordinary rejection-limit cancellation', async () => {
      await expectCancelled(
        makeRun({ metadata: { approval: approval(), rejection_count: 2 } }),
        true
      );
    });
    test('preserves restricted already-cancelled idempotency', async () => {
      const effects = setup(makeRun({ workflow_name: reserved, status: 'cancelled' }));
      const response = await effects.post('reject');
      expect(response.status).toBe(200);
      expect(((await response.json()) as { message: string }).message).toContain(
        'already rejected'
      );
      expectNoContinuation(effects);
    });
    test('preserves failed status rejection without effects', async () => {
      const effects = setup(makeRun({ workflow_name: reserved, status: 'failed' }));
      const response = await effects.post('reject');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Cannot reject workflow in 'failed' status" });
      expectNoContinuation(effects);
    });
    test('preserves rejection missing-run404', async () => {
      const effects = setup(null);
      expect((await effects.post('reject')).status).toBe(404);
      expectNoContinuation(effects);
    });
    test('preserves rejection lookup-error500 without replacement', async () => {
      const effects = setup(null);
      mockContinuationGetRun.mockImplementation(async () => {
        throw new Error('owned reject lookup failure');
      });
      expect((await effects.post('reject')).status).toBe(500);
      expectNoContinuation(effects);
    });
  });
});

describe('restricted provider-wait registered timer', () => {
  const realProcessDueProviderWaits = providerWaitScheduler.processDueProviderWaits;
  const reserved = 'bdc-feature-development-codex-only';

  async function runRegisteredTick(
    run: WorkflowRun,
    mode: 'normal' | 'cancel-before' | 'cancel-after' | 'release-fails' = 'normal'
  ) {
    const before = structuredClone(run);
    const oldNodeEnv = process.env.NODE_ENV;
    const oldInterval = process.env.ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS;
    const oldGetConversation = mockContinuationGetConversation.getMockImplementation();
    const oldExecute = mockContinuationExecute.getMockImplementation();
    const oldDeps = mockContinuationDeps.getMockImplementation();
    const oldLane = mockContinuationLane.getMockImplementation();
    const oldDiscovery = mockDiscoverWorkflowsWithConfig.getMockImplementation();
    const promises: ReturnType<typeof realProcessDueProviderWaits>[] = [];
    const timer = { unref: mock(() => {}) };
    const mapping = mock(() => {});
    const bridge = mock(() => () => {});
    let statusReads = 0;
    const wait = {
      state: 'scheduled' as 'scheduled' | 'claimed' | 'completed' | 'cancelled',
      claimToken: null as string | null,
      ownerId: null as string | null,
      resumeAt: null as string | null,
    };
    const store = {
      listDueProviderWaits: mock(async () => [{ waitId: 'owned-wait', runId: run.id }]),
      getWorkflowRunStatus: mock(async () => {
        statusReads += 1;
        return mode === 'cancel-before' || (mode === 'cancel-after' && statusReads > 1)
          ? 'cancelled'
          : 'waiting_provider';
      }),
      claimProviderWait: mock(async (data: Parameters<IWorkflowStore['claimProviderWait']>[0]) => {
        if (data.waitId !== 'owned-wait' || wait.state !== 'scheduled') return false;
        wait.state = 'claimed';
        wait.claimToken = data.claimToken;
        wait.ownerId = data.ownerId;
        return true;
      }),
      getWorkflowRun: mock(async () => run),
      completeProviderWait: mock(
        async (data: Parameters<IWorkflowStore['completeProviderWait']>[0]) => {
          if (
            data.waitId !== 'owned-wait' ||
            wait.state !== 'claimed' ||
            data.claimToken !== wait.claimToken
          )
            return false;
          wait.state = 'completed';
          return true;
        }
      ),
      releaseProviderWaitClaim: mock(
        async (data: Parameters<NonNullable<IWorkflowStore['releaseProviderWaitClaim']>>[0]) => {
          // Model cancellation winning after the callback but before release CAS.
          if (mode === 'release-fails') wait.state = 'cancelled';
          if (
            data.waitId !== 'owned-wait' ||
            wait.state !== 'claimed' ||
            data.claimToken !== wait.claimToken
          )
            return false;
          wait.state = 'scheduled';
          wait.resumeAt = data.resumeAt;
          wait.claimToken = null;
          wait.ownerId = null;
          return true;
        }
      ),
      cancelProviderWaits: mock(async () => {
        wait.state = 'cancelled';
        return 1;
      }),
    };
    for (const effect of [
      mockContinuationGetConversation,
      mockContinuationExecute,
      mockContinuationDeps,
      mockContinuationLane,
      mockWaitTaskmasterStart,
      mockWaitDeadmanStart,
      mockWaitInboxStart,
      mockWaitConsumerStart,
    ])
      effect.mockClear();
    mockContinuationGetConversation.mockImplementation(async id => ({
      id,
      platform_type: 'web',
      platform_conversation_id: 'web-' + id,
    }));
    mockContinuationDeps.mockImplementation(() => ({ store: store as unknown as IWorkflowStore }));
    mockContinuationLane.mockImplementation(async request => request.workflowName);
    // Only the final executor boundary is stubbed. The registered callback,
    // shared helper and scheduler below all execute their actual source.
    mockContinuationExecute.mockImplementation(async () => ({
      success: false,
      error: 'codex_only_resume_unsupported',
    }));
    if (
      !Object.hasOwn(run.metadata ?? {}, 'codex_only_dispatch') &&
      run.workflow_name !== reserved
    ) {
      mockContinuationExecute.mockImplementation(async () => ({ success: true }));
    }
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(async () => ({
      workflows: [
        {
          workflow: {
            name: run.workflow_name,
            description: 'Owned provider-wait fixture',
            nodes: [{ id: 'fixture', prompt: 'owned fixture' }],
          },
          source: 'project' as const,
        },
      ],
      errors: [],
    }));
    stopProviderWaitScheduler();
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(
      (() => timer) as unknown as typeof setInterval
    );
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const schedulerSpy = spyOn(providerWaitScheduler, 'processDueProviderWaits').mockImplementation(
      (...args: Parameters<typeof realProcessDueProviderWaits>) => {
        const promise = realProcessDueProviderWaits(...args);
        promises.push(promise);
        return promise;
      }
    );
    try {
      process.env.NODE_ENV = 'provider-wait-hermetic-test';
      process.env.ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS = '15000';
      const app = new OpenAPIHono({ defaultHook: validationErrorHook });
      registerApiRoutes(
        app,
        {
          setConversationDbId: mapping,
          setupEventBridge: bridge,
        } as unknown as WebAdapter,
        {} as ConversationLockManager
      );
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(timer.unref).toHaveBeenCalledTimes(1);
      expect(promises).toHaveLength(1);
      let result;
      if (mode === 'release-fails') {
        await expect(promises[0]).rejects.toThrow('provider_wait_resume_not_dispatched: ' + run.id);
      } else {
        result = await promises[0];
      }
      expect(run).toEqual(before);
      expect(mockWaitTaskmasterStart).toHaveBeenCalledTimes(1);
      expect(mockWaitDeadmanStart).toHaveBeenCalledTimes(1);
      expect(mockWaitInboxStart).toHaveBeenCalledTimes(1);
      expect(mockWaitConsumerStart).not.toHaveBeenCalled();
      return { store, wait, result, mapping, bridge };
    } finally {
      await Promise.allSettled(promises);
      stopProviderWaitScheduler();
      schedulerSpy.mockRestore();
      clearSpy.mockRestore();
      intervalSpy.mockRestore();
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = oldNodeEnv;
      if (oldInterval === undefined) delete process.env.ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS;
      else process.env.ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS = oldInterval;
      if (oldGetConversation)
        mockContinuationGetConversation.mockImplementation(oldGetConversation);
      if (oldExecute) mockContinuationExecute.mockImplementation(oldExecute);
      if (oldDeps) mockContinuationDeps.mockImplementation(oldDeps);
      if (oldLane) mockContinuationLane.mockImplementation(oldLane);
      if (oldDiscovery) mockDiscoverWorkflowsWithConfig.mockImplementation(oldDiscovery);
    }
  }

  function makeWaitRun(extra: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id: 'owned-provider-wait-run',
      workflow_name: 'ordinary-wait-workflow',
      status: 'waiting_provider',
      parent_conversation_id: 'owned-wait-parent',
      conversation_id: 'owned-wait-worker',
      working_path: '/tmp/owned-provider-wait',
      metadata: {},
      ...extra,
    } as WorkflowRun;
  }

  function expectRefused(effects: Awaited<ReturnType<typeof runRegisteredTick>>) {
    expect(effects.store.completeProviderWait).not.toHaveBeenCalled();
    expect(effects.store.releaseProviderWaitClaim).toHaveBeenCalledTimes(1);
    expect(effects.store.releaseProviderWaitClaim).toHaveBeenCalledWith({
      waitId: 'owned-wait',
      claimToken: expect.any(String),
      resumeAt: expect.any(String),
    });
    expect(effects.store.cancelProviderWaits).not.toHaveBeenCalled();
    expect(effects.store.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockContinuationDeps).toHaveBeenCalledTimes(1);
    for (const effect of [
      mockContinuationGetConversation,
      mockContinuationExecute,
      mockContinuationLane,
      mockDiscoverWorkflowsWithConfig,
      effects.mapping,
      effects.bridge,
    ])
      expect(effect).not.toHaveBeenCalled();
  }

  for (const [label, marker] of [
    ['null', null],
    ['undefined', undefined],
    ['false', false],
    ['corrupt', 'corrupt'],
    ['v1', { version: 'codex-only-v1' }],
    ['v2', { version: 'codex-only-v2' }],
    ['unknown', { version: 'codex-only-v999' }],
  ] as const) {
    test('defers own ' + label + ' marker before resume effects', async () => {
      const effects = await runRegisteredTick(
        makeWaitRun({ metadata: { codex_only_dispatch: marker } })
      );
      expect(effects.result).toEqual({ due: 1, resumed: 0, cancelled: 0, deferred: 1 });
      expect(effects.wait).toEqual({
        state: 'scheduled',
        claimToken: null,
        ownerId: null,
        resumeAt: expect.any(String),
      });
      expectRefused(effects);
    });
  }

  test('defers reserved name without marker before resume effects', async () => {
    const effects = await runRegisteredTick(makeWaitRun({ workflow_name: reserved }));
    expect(effects.result).toEqual({ due: 1, resumed: 0, cancelled: 0, deferred: 1 });
    expect(effects.wait.state).toBe('scheduled');
    expect(effects.wait.claimToken).toBeNull();
    expect(effects.wait.ownerId).toBeNull();
    expectRefused(effects);
  });

  test('preserves ordinary eligible provider-wait completion', async () => {
    const effects = await runRegisteredTick(makeWaitRun());
    expect(effects.result).toEqual({ due: 1, resumed: 1, cancelled: 0, deferred: 0 });
    expect(effects.wait.state).toBe('completed');
    expect(effects.store.completeProviderWait).toHaveBeenCalledTimes(1);
    expect(effects.store.releaseProviderWaitClaim).not.toHaveBeenCalled();
    expect(mockContinuationExecute).toHaveBeenCalledTimes(1);
    expect(mockContinuationDeps).toHaveBeenCalledTimes(2);
    expect(effects.mapping).toHaveBeenCalledTimes(1);
    expect(effects.bridge).toHaveBeenCalledTimes(1);
  });

  test('preserves ordinary missing-parent defer', async () => {
    const effects = await runRegisteredTick(makeWaitRun({ parent_conversation_id: null }));
    expect(effects.result).toEqual({ due: 1, resumed: 0, cancelled: 0, deferred: 1 });
    expectRefused(effects);
  });

  for (const mode of ['cancel-before', 'cancel-after'] as const) {
    test('preserves ' + mode + ' claim cancellation', async () => {
      const effects = await runRegisteredTick(makeWaitRun({ workflow_name: reserved }), mode);
      expect(effects.result).toEqual({ due: 1, resumed: 0, cancelled: 1, deferred: 0 });
      expect(effects.wait.state).toBe('cancelled');
      expect(effects.store.cancelProviderWaits).toHaveBeenCalledTimes(1);
      expect(effects.store.claimProviderWait).toHaveBeenCalledTimes(
        mode === 'cancel-before' ? 0 : 1
      );
      expect(effects.store.getWorkflowRun).not.toHaveBeenCalled();
      expect(effects.store.releaseProviderWaitClaim).not.toHaveBeenCalled();
      expect(effects.store.completeProviderWait).not.toHaveBeenCalled();
      expect(mockContinuationExecute).not.toHaveBeenCalled();
      expect(effects.mapping).not.toHaveBeenCalled();
      expect(effects.bridge).not.toHaveBeenCalled();
    });
  }

  test('retains refusal when claim release fails without false completion', async () => {
    const effects = await runRegisteredTick(
      makeWaitRun({ workflow_name: reserved }),
      'release-fails'
    );
    expect(effects.result).toBeUndefined();
    expect(effects.wait.state).toBe('cancelled');
    expectRefused(effects);
  });
});
