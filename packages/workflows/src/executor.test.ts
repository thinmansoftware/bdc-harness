/**
 * Tests for executeWorkflow() -- the top-level orchestration function.
 * Covers concurrent-run guards, model/provider resolution, and resume logic
 * that the inner dag-executor.test.ts cannot reach.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'node:crypto';

// --- Mock logger ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
}));

// --- Mock git ---
const mockGetRemoteUrl = mock(async (): Promise<string | null> => null);
const mockExecFileAsync = mock(async () => ({ stdout: '', stderr: '' }));
mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  getDefaultBranch: mock(async () => 'main'),
  getRemoteUrl: mockGetRemoteUrl,
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
const mockExecuteDagWorkflow = mock(async (): Promise<string | undefined> => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// --- Mock logger functions ---
mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

// --- Mock event emitter ---
const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Bootstrap provider registry (after path mocks) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Import after mocks ---
import { executeWorkflow, resolveExecutorLane, LaneAvailabilityRefusedError } from './executor';
import { markEngineDarkIfZeroUsage, resetEngineAvailabilityForTests } from './engine-availability';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    createWorkflowEvent: mock(async () => {}),
    listWorkflowEvents: mock(async () => []),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    createRunAuthority: mock(async () => 'created' as const),
    getRunAuthority: mock(async () => null),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: {
          claude: {},
          codex: {},
        },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', prompt: 'Do something' }],
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function getExecutedWorkflow(): WorkflowDefinition {
  return mockExecuteDagWorkflow.mock.calls[0]?.[4] as WorkflowDefinition;
}

describe('executeWorkflow', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  // -------------------------------------------------------------------------
  // Concurrent-run guard
  // -------------------------------------------------------------------------

  describe('concurrent-run guard', () => {
    it('allows workflow when no active workflow exists', async () => {
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => null) });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.workflowRunId).toBe('run-123');
    });

    it('blocks workflow when active workflow check fails', async () => {
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('DB connection lost');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('blocks workflow when another is actively running', async () => {
      const activeRun = makeRun({
        id: 'other-run-456',
        status: 'running',
        started_at: new Date().toISOString(), // Recent -- not stale
      });
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => activeRun),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');
    });

    it('passes self-id and started_at to the lock query so self is excluded', async () => {
      // The guard runs AFTER workflowRun is finalized so we always have
      // a self-ID. Without these args, the dispatch's own row would match
      // and falsely trigger the guard.
      const selfRun = makeRun({ id: 'self-run-789', started_at: '2026-04-14T10:00:00.000Z' });
      const getActiveSpy = mock(async () => null);
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: getActiveSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      expect(getActiveSpy).toHaveBeenCalledWith(
        '/tmp',
        expect.objectContaining({ id: 'self-run-789', startedAt: expect.any(Date) })
      );
    });

    it('marks self as cancelled when guard fires (no zombie pending row)', async () => {
      const selfRun = makeRun({ id: 'self-run-789' });
      const otherRun = makeRun({ id: 'other-run-456', status: 'running' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: mock(async () => otherRun),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      // Without this, every guard-blocked dispatch would leak a `pending`
      // row that briefly blocks future dispatches via the lock query.
      expect(updateSpy).toHaveBeenCalledWith('self-run-789', { status: 'cancelled' });
    });

    it('uses the actionable "in use" message format with workflow name, duration, and short id', async () => {
      const otherRun = makeRun({
        id: 'abc12345-rest-of-uuid',
        workflow_name: 'archon-implement',
        status: 'running',
        started_at: new Date(Date.now() - 125000).toISOString(), // 2m 5s ago
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => otherRun),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        platform,
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      expect(sendMessageSpy).toHaveBeenCalled();
      const sentMessage = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(sentMessage).toContain('archon-implement');
      expect(sentMessage).toContain('abc12345');
      expect(sentMessage).toContain('2m 5s');
      // Concrete next actions -- every line tells the user something to do.
      expect(sentMessage).toContain('/workflow status');
      expect(sentMessage).toContain('/workflow cancel abc12345');
      expect(sentMessage).toContain('--branch');
    });

    it('skips path-lock check when mutates_checkout is false', async () => {
      const getActiveSpy = mock(async () =>
        makeRun({ id: 'other-run', status: 'running' as const })
      );
      const store = makeStore({ getActiveWorkflowRunByPath: getActiveSpy });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ mutates_checkout: false }),
        'test message',
        'db-conv-1'
      );
      // Guard skipped: spy never called, run succeeds
      expect(getActiveSpy).not.toHaveBeenCalled();
      expect(result.workflowRunId).toBe('run-123');
    });

    it('still enforces path lock when mutates_checkout is true', async () => {
      const otherRun = makeRun({ id: 'other-run-456', status: 'running' as const });
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => otherRun) });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ mutates_checkout: true }),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');
    });

    it('still returns failure when guard self-cancel update throws (best-effort)', async () => {
      const selfRun = makeRun({ id: 'self-run', status: 'pending' });
      const otherRun = makeRun({ id: 'other-run', status: 'running' });
      const updateSpy = mock(async (id: string) => {
        // Self-cancel attempt fails -- must not crash, must still surface
        // the "in use" failure to the user.
        if (id === 'self-run') throw new Error('Update failed');
      });
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: mock(async () => otherRun),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1'
      );

      // Cleanup failure must not mask the "in use" outcome.
      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');
    });
  });

  describe('run authority', () => {
    it('fails closed before DAG execution when a required frozen source is missing', async () => {
      const failSpy = mock(async () => {});
      const store = makeStore({ failWorkflowRun: failSpy });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({
          run_authority: {
            required: true,
            spec_repository: 'bluedevilcollectibles/bdc-xo',
            spec_revision: 'main',
            spec_paths: ['docs/work-orders/{WO_ID}.md'],
          },
        }),
        'WO-TEST-01',
        'db-conv-1',
        'codebase-1'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('scope_authority_missing');
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      expect(failSpy).toHaveBeenCalled();
    });

    it('persists immutable repository facts before starting the DAG', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'executor-authority-'));
      try {
        const createAuthority = mock(async () => 'created' as const);
        const store = makeStore({ createRunAuthority: createAuthority });
        const deps = makeDeps(store);
        const freezeWorkOrderSource = mock(async () => ({
          woId: 'WO-TEST-01',
          specSource: 'github:bluedevilcollectibles/bdc-xo:docs/work-orders/WO-TEST-01.md',
          specRevision: 'a'.repeat(40),
          specBytes: Buffer.from('# Exact\n', 'utf8'),
        }));
        deps.freezeWorkOrderSource = freezeWorkOrderSource;
        deps.loadConfig = mock(async () => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          baseBranch: 'main',
          commands: { folder: '' },
        })) as WorkflowDeps['loadConfig'];
        mockGetRemoteUrl.mockImplementationOnce(
          async () => 'https://github.com/bluedevilcollectibles/example.git'
        );
        mockExecFileAsync.mockImplementation(async (_command, args) => {
          const values = args as string[];
          if (values.includes('symbolic-ref')) {
            return { stdout: 'archon/thread-test\n', stderr: '' };
          }
          if (values.includes('rev-parse')) {
            const revision = values.at(-1) ?? '';
            return {
              stdout: revision.startsWith('refs/remotes/origin/main')
                ? `${'b'.repeat(40)}\n`
                : `${'c'.repeat(40)}\n`,
              stderr: '',
            };
          }
          return { stdout: '', stderr: '' };
        });

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            run_authority: {
              required: true,
              spec_repository: 'bluedevilcollectibles/bdc-xo',
              spec_revision: 'main',
              spec_paths: ['docs/work-orders/{WO_ID}.md'],
            },
          }),
          'WO-TEST-01',
          'db-conv-1',
          'codebase-1'
        );

        expect(result).toEqual({ success: true, workflowRunId: 'run-123', summary: undefined });
        expect(freezeWorkOrderSource).toHaveBeenCalledTimes(1);
        expect(createAuthority).toHaveBeenCalledTimes(1);
        const authority = createAuthority.mock.calls[0]?.[0];
        expect(authority?.dispatchId).toBe('conv-1');
        expect(authority?.baseSha).toBe('b'.repeat(40));
        expect(authority?.runScopeSha).toBe('c'.repeat(40));
        expect(authority?.headBranch).toBe('archon/thread-test');
        expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('uses a caller-supplied frozen source without fetching it again', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'executor-supplied-authority-'));
      try {
        const createAuthority = mock(async () => 'created' as const);
        const store = makeStore({ createRunAuthority: createAuthority });
        const deps = makeDeps(store);
        const freezeWorkOrderSource = mock(async () => {
          throw new Error('must not refetch caller-supplied authority');
        });
        deps.freezeWorkOrderSource = freezeWorkOrderSource;
        mockGetRemoteUrl.mockImplementationOnce(
          async () => 'https://github.com/bluedevilcollectibles/example.git'
        );
        mockExecFileAsync.mockImplementation(async (_command, args) => {
          const values = args as string[];
          if (values.includes('symbolic-ref')) {
            return { stdout: 'archon/thread-test\n', stderr: '' };
          }
          return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
        });

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            run_authority: {
              required: true,
              spec_repository: 'bluedevilcollectibles/bdc-xo',
              spec_revision: 'main',
              spec_paths: ['docs/work-orders/{WO_ID}.md'],
            },
          }),
          'WO-TEST-01',
          'db-conv-1',
          'codebase-1',
          undefined,
          undefined,
          undefined,
          undefined,
          {
            dispatchId: 'dispatch-frozen',
            woId: 'WO-TEST-01',
            specSource: 'github:bluedevilcollectibles/bdc-xo:docs/work-orders/WO-TEST-01.md',
            specRevision: 'a'.repeat(40),
            specBytes: Buffer.from('# Exact\n', 'utf8'),
          }
        );

        expect(result.success).toBe(true);
        expect(freezeWorkOrderSource).not.toHaveBeenCalled();
        expect(createAuthority.mock.calls[0]?.[0]?.dispatchId).toBe('dispatch-frozen');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('reuses persisted authority when resuming a failed run', async () => {
      const resumedRun = makeRun({ id: 'run-resumed', status: 'failed' });
      const createAuthority = mock(async () => 'created' as const);
      const persistedAuthority = {
        runId: resumedRun.id,
        dispatchId: 'dispatch-original',
        woId: 'WO-TEST-01',
        specSource: 'github:bluedevilcollectibles/bdc-xo:docs/work-orders/WO-TEST-01.md',
        specRevision: 'a'.repeat(40),
        specHash: `sha256:${'1'.repeat(64)}`,
        workflowName: 'test-workflow',
        codebaseId: 'codebase-1',
        canonicalRemote: 'https://github.com/bluedevilcollectibles/example.git',
        baseBranch: 'main',
        baseSha: 'b'.repeat(40),
        runScopeSha: 'c'.repeat(40),
        headBranch: 'archon/thread-test',
        worktreePath: '/tmp',
        workflowRevision: `sha256:${'2'.repeat(64)}`,
        bundleRevision: `sha256:${'3'.repeat(64)}`,
        engineRevision: `sha256:${'4'.repeat(64)}`,
        runtimeImageRevision: null,
        createdAt: '2026-07-10T12:00:00.000Z',
      };
      const store = makeStore({
        findResumableRun: mock(async () => resumedRun),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node0', 'done']])),
        resumeWorkflowRun: mock(async () => ({ ...resumedRun, status: 'running' })),
        getRunAuthority: mock(async () => persistedAuthority),
        createRunAuthority: createAuthority,
      });
      const deps = makeDeps(store);
      const freezeWorkOrderSource = mock(async () => {
        throw new Error('must not refetch persisted authority');
      });
      deps.freezeWorkOrderSource = freezeWorkOrderSource;

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({
          run_authority: {
            required: true,
            spec_repository: 'bluedevilcollectibles/bdc-xo',
            spec_revision: 'main',
            spec_paths: ['docs/work-orders/{WO_ID}.md'],
          },
        }),
        'WO-TEST-01',
        'db-conv-1',
        'codebase-1'
      );

      expect(result.success).toBe(true);
      expect(freezeWorkOrderSource).not.toHaveBeenCalled();
      expect(createAuthority).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Resume orphan cleanup
  // -------------------------------------------------------------------------

  describe('resume orphan cleanup', () => {
    it('cancels orphaned pre-created row when resume activates', async () => {
      // Orchestrator dispatched and pre-created this row before resume
      // detection ran. Once resume takes over (using resumableRun instead),
      // the pre-created row is a stale lock-token that would block the
      // user's next back-to-back resume.
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'output1']])),
        resumeWorkflowRun: mock(async () => makeRun({ id: 'failed-prior-run', status: 'running' })),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preCreated
      );

      // Find the orphan-cancellation call (there may be other updateWorkflowRun
      // calls during normal execution flow, e.g., status transitions).
      const orphanCancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'pre-created-orphan' &&
          (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(orphanCancelCall).toBeDefined();
    });

    it('proceeds with resume even if orphan cancellation fails (best-effort)', async () => {
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async (id: string) => {
        if (id === 'pre-created-orphan') throw new Error('DB busy');
      });
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'output1']])),
        resumeWorkflowRun: mock(async () => makeRun({ id: 'failed-prior-run', status: 'running' })),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preCreated
      );

      // Resume must still complete -- the 5-min stale-pending window is the
      // safety net for cleanup failures here.
      expect(result.workflowRunId).toBe('failed-prior-run');
    });
  });

  // -------------------------------------------------------------------------
  // Model/provider resolution
  // -------------------------------------------------------------------------

  describe('model/provider resolution', () => {
    it('uses default provider from config when workflow has no provider or model', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should succeed -- uses config.assistant (claude) as default
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('passes workflow.model through unchanged when workflow.provider is unset', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      // Provider falls back to config.assistant ('claude'); model is forwarded
      // verbatim. The SDK is the source of truth for what model strings work.
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'sonnet' }),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('passes provider+model through to the SDK without re-routing on model name', async () => {
      // Provider is explicit; the model string is forwarded verbatim to
      // whichever SDK the resolved provider names. A workflow that sets
      // provider:codex with a Claude-looking model gets the request handed
      // to the codex SDK as-is -- the SDK decides whether to accept it.
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ provider: 'codex', model: 'sonnet' }),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('throws when workflow.provider is not a registered provider', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await expect(
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ provider: 'claud', model: 'sonnet' }),
          'test message',
          'db-conv-1'
        )
      ).rejects.toThrow(/unknown provider 'claud'/);
    });
  });

  describe('canary probe Telegram alerts', () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;

    function providerThatThrows(error: Error) {
      return {
        getType: () => 'claude',
        getCapabilities: () => ({}),
        sendQuery: async function* () {
          throw error;
        },
      };
    }

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    });

    it('pages Telegram for canary probe warnings', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      const fetchCalls: RequestInit[] = [];
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init) fetchCalls.push(init);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      const err = Object.assign(new Error('bad request'), { httpStatus: 400 });
      const deps = {
        ...makeDeps(),
        getAgentProvider: mock(() => providerThatThrows(err)),
      } as unknown as WorkflowDeps;

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      const body = JSON.parse(String(fetchCalls[0]?.body)) as { text: string };
      expect(body.text).toContain('[CANARY PROBE WARN]');
      expect(body.text).toContain('unknown_400');
    });

    it('pages Telegram for canary probe red blocks', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      const fetchCalls: RequestInit[] = [];
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init) fetchCalls.push(init);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;
      const err = Object.assign(new Error('model is not supported'), { httpStatus: 400 });
      const store = makeStore();
      const deps = {
        ...makeDeps(store),
        getAgentProvider: mock(() => providerThatThrows(err)),
      } as unknown as WorkflowDeps;

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      const body = JSON.parse(String(fetchCalls[0]?.body)) as { text: string };
      expect(result.success).toBe(false);
      expect(body.text).toContain('[CANARY PROBE RED]');
      expect(body.text).toContain('structural_model_not_supported');
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // $DOCS_DIR default resolution
  // -------------------------------------------------------------------------

  describe('docsDir resolution', () => {
    it('passes docs/ default when config.docsPath is undefined', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      // docsDir is arg index 11 (0-indexed) of executeDagWorkflow
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[11];
      expect(docsDir).toBe('docs/');
    });

    it('passes configured docsPath when set', async () => {
      const store = makeStore();
      const deps = {
        store,
        loadConfig: mock(
          async (): Promise<WorkflowConfig> => ({
            assistant: 'claude' as const,
            assistants: { claude: {}, codex: {} },
            baseBranch: '',
            commands: { folder: '' },
            docsPath: 'packages/docs-web/src/content/docs',
          })
        ),
        getAgentProvider: mock(() => ({
          run: mock(async () => {}),
        })),
      } as unknown as WorkflowDeps;
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[11];
      expect(docsDir).toBe('packages/docs-web/src/content/docs');
    });
  });

  // -------------------------------------------------------------------------
  // Resume logic
  // -------------------------------------------------------------------------

  describe('resume logic', () => {
    it('resumes the exact waiting-provider run even when it has no completed nodes', async () => {
      const waitingRun = makeRun({ id: 'waiting-run', status: 'waiting_provider' });
      const resumedRun = makeRun({ id: 'waiting-run', status: 'running' });
      const store = makeStore({
        findResumableRun: mock(async () => null),
        getCompletedDagNodeOutputs: mock(async () => new Map()),
        resumeWorkflowRun: mock(async () => resumedRun),
        getWorkflowRun: mock(async () => ({ ...resumedRun, status: 'completed' as const })),
      });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        waitingRun
      );

      expect(store.resumeWorkflowRun).toHaveBeenCalledWith('waiting-run');
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
      const dagArgs = mockExecuteDagWorkflow.mock.calls[0];
      expect(dagArgs?.[5]).toEqual(
        expect.objectContaining({ id: 'waiting-run', status: 'running' })
      );
      expect(dagArgs?.[15]).toEqual(new Map());
    });

    it('starts fresh run when findResumableRun returns null', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => null),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when findResumableRun throws', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => {
          throw new Error('DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should fall back to creating a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when prior run has 0 completed nodes', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => new Map()),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should skip resume and create a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    });

    it('returns error when resumeWorkflowRun throws', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const priorNodes = new Map([['node1', 'output1']]);
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => priorNodes),
        resumeWorkflowRun: mock(async () => {
          throw new Error('Resume DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error resuming');
    });
  });

  // -------------------------------------------------------------------------
  // Summary propagation
  // -------------------------------------------------------------------------

  describe('summary propagation', () => {
    it('passes dag summary from executeDagWorkflow into WorkflowExecutionResult', async () => {
      mockExecuteDagWorkflow.mockResolvedValueOnce('This is the workflow summary');
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary).toBe('This is the workflow summary');
      }
    });

    it('passes undefined summary when executeDagWorkflow returns undefined', async () => {
      mockExecuteDagWorkflow.mockResolvedValueOnce(undefined);
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // policyFile
  // -------------------------------------------------------------------------

  describe('policyFile', () => {
    it('loads policyFile content into prompt node systemPrompt', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        await writeFile(join(cwd, 'policy.md'), 'TEST POLICY CONTENT');
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            policyFile: 'policy.md',
            nodes: [
              { id: 'node1', prompt: 'Do something' },
              { id: 'loop1', loop: { prompt: 'Iterate', until: 'DONE', max_iterations: 2 } },
            ],
          }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(true);
        expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
        const executedWorkflow = getExecutedWorkflow();
        expect(executedWorkflow.nodes[0]).toMatchObject({
          systemPrompt: 'TEST POLICY CONTENT',
        });
        expect(executedWorkflow.nodes[1]).toMatchObject({
          systemPrompt: 'TEST POLICY CONTENT',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('fails closed when policyFile is missing', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({ policyFile: 'missing-policy.md' }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('policyFile not found');
        expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('fails closed when policyFile is empty', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        await writeFile(join(cwd, 'empty-policy.md'), '');
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({ policyFile: 'empty-policy.md' }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('policyFile is empty');
        expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('prepends policyFile content before an existing prompt node systemPrompt', async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        await writeFile(join(cwd, 'policy.md'), 'TEST POLICY CONTENT');
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            policyFile: 'policy.md',
            nodes: [{ id: 'node1', prompt: 'Do something', systemPrompt: 'NODE-SPECIFIC' }],
          }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(true);
        expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
        const executedWorkflow = getExecutedWorkflow();
        expect(executedWorkflow.nodes[0]).toMatchObject({
          systemPrompt: 'TEST POLICY CONTENT\n\nNODE-SPECIFIC',
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Bundled fallback (Approach B -- central resolver)
    // WO-HARNESS-POLICYFILE-NOT-ENFORCED-01
    // -----------------------------------------------------------------------

    it('falls back to BUNDLED_POLICIES when the local file is absent', async () => {
      // No policy file written to cwd -- must resolve via the bundled canonical
      // copy embedded at bundle time from harness/policies/.
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            policyFile: 'harness/policies/agent-behavior.md',
            nodes: [
              { id: 'node1', prompt: 'Do something' },
              { id: 'loop1', loop: { prompt: 'Iterate', until: 'DONE', max_iterations: 2 } },
            ],
          }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(true);
        expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
        const executedWorkflow = getExecutedWorkflow();

        // Sentinel checks: both required by the Universal Agent Behavior Policy v1.1
        const node0SystemPrompt = executedWorkflow.nodes[0].systemPrompt;
        const node1SystemPrompt = executedWorkflow.nodes[1].systemPrompt;
        expect(node0SystemPrompt).toContain('Think before building');
        expect(node0SystemPrompt).toContain('Surgical changes only');
        expect(node1SystemPrompt).toContain('Think before building');
        expect(node1SystemPrompt).toContain('Surgical changes only');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('local copy wins over bundled when both are present', async () => {
      // When the target repo ships its own copy (only bdc-xo does today), the
      // local file takes precedence over the bundled canonical. This preserves
      // a documented override path for bdc-xo.
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        const subdir = join(cwd, 'harness', 'policies');
        await mkdir(subdir, { recursive: true });
        await writeFile(
          join(subdir, 'agent-behavior.md'),
          'LOCAL OVERRIDE -- does not contain sentinels'
        );
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            policyFile: 'harness/policies/agent-behavior.md',
            nodes: [{ id: 'node1', prompt: 'Do something' }],
          }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(true);
        const executedWorkflow = getExecutedWorkflow();
        expect(executedWorkflow.nodes[0].systemPrompt).toBe(
          'LOCAL OVERRIDE -- does not contain sentinels'
        );
        // Bundled sentinels should NOT appear since local took precedence
        expect(executedWorkflow.nodes[0].systemPrompt).not.toContain('Think before building');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('fails loud when neither local nor bundled policy resolves', async () => {
      // Declared policyFile path does not exist locally AND is not in
      // BUNDLED_POLICIES -- must throw with both sources named.
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({ policyFile: 'harness/policies/does-not-exist.md' }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('policyFile not found');
        expect(result.error).toContain('harness/policies/does-not-exist.md');
        expect(result.error).toContain('bundled canonical source');
        expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('injects policy exactly once per prompt node (idempotent)', async () => {
      // Each prompt node receives the policy as systemPrompt prefix exactly
      // once -- no duplication within a node when the policy text contains
      // unique markers.
      const cwd = await mkdtemp(join(tmpdir(), 'archon-policy-'));
      try {
        const deps = makeDeps();

        const result = await executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          cwd,
          makeWorkflow({
            policyFile: 'harness/policies/agent-behavior.md',
            nodes: [
              { id: 'a', prompt: 'A' },
              { id: 'b', prompt: 'B' },
              { id: 'c', prompt: 'C' },
            ],
          }),
          'test',
          'db-conv-1'
        );

        expect(result.success).toBe(true);
        const executedWorkflow = getExecutedWorkflow();
        // The phrase "Think before building" appears once in the canonical
        // policy text. Count occurrences per node -- must be exactly 1.
        for (const node of executedWorkflow.nodes) {
          const sentinelCount = (node.systemPrompt?.match(/Think before building/g) ?? []).length;
          expect(sentinelCount).toBe(1);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });

    it('bundled canonical policy passes checksum verification', async () => {
      // The bundled copy MUST contain the canonical policy. We assert:
      //  1. The bundled entry exists for the canonical key.
      //  2. SHA256 produces a deterministic 64-char hex digest (not empty).
      //  3. The content includes both locked principles' sentinels.
      //
      // No hard-coded hash is asserted: the canonical policy may legitimately
      // change in bdc-xo, at which point this PR's bundled snapshot is
      // expected to be refreshed via `bun run generate:bundled`. The
      // sentinel + non-empty-digest combo is sufficient to detect a
      // bundled-but-stub-empty regression.
      const { BUNDLED_POLICIES } = await import('./defaults/bundled-defaults');
      const canonicalKey = 'harness/policies/agent-behavior.md';

      expect(Object.hasOwn(BUNDLED_POLICIES, canonicalKey)).toBe(true);
      const bundledContent = BUNDLED_POLICIES[canonicalKey];
      expect(typeof bundledContent).toBe('string');
      expect(bundledContent.length).toBeGreaterThan(100);

      const digest = createHash('sha256').update(bundledContent, 'utf-8').digest('hex');
      expect(digest).toMatch(/^[a-f0-9]{64}$/);

      // Sentinels -- these are the Locked Principles 1 and 3 from v1.1.
      expect(bundledContent).toContain('Think before building');
      expect(bundledContent).toContain('Surgical changes only');
    });
  });

  // -------------------------------------------------------------------------
  // Pre-created run (uses existing row but still runs guards)
  // -------------------------------------------------------------------------

  describe('pre-created run', () => {
    it('uses pre-created run row but still runs concurrent-run check', async () => {
      const preRun = makeRun({ id: 'pre-run-1' });
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preRun
      );
      // Guards still run (no bypass)
      expect(store.getActiveWorkflowRunByPath).toHaveBeenCalled();
      // But uses the pre-created run instead of creating a new one
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
      expect(result.workflowRunId).toBe('pre-run-1');
    });
  });

  // -------------------------------------------------------------------------
  // DB env var merge
  // -------------------------------------------------------------------------

  describe('DB env var merge', () => {
    it('merges DB env vars on top of file config envVars when codebaseId provided', async () => {
      const store = makeStore({
        getCodebaseEnvVars: mock(async () => ({ DB_KEY: 'db_val' })),
      });
      const deps = makeDeps(store);
      // Override loadConfig to return file-level envVars
      (deps.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
        envVars: { FILE_KEY: 'file_val' },
      });

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        'codebase-1'
      );

      // DB env vars should have been fetched for the codebaseId
      expect(store.getCodebaseEnvVars).toHaveBeenCalledWith('codebase-1');

      // The config passed to executeDagWorkflow (arg index 12) should have merged envVars
      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[12] as WorkflowConfig | undefined;
      expect(configArg?.envVars).toEqual({ FILE_KEY: 'file_val', DB_KEY: 'db_val' });
    });

    it('does not call getCodebaseEnvVars when no codebaseId', async () => {
      const store = makeStore();
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
        // no codebaseId
      );

      expect(store.getCodebaseEnvVars).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Lock-token cleanup on pre-DAG failure paths (review #1)
  //
  // Any failure between row creation and DAG start that returns early must
  // release the lock token. Without this, ghost pending/running rows block
  // the path until the 5-min stale window or manual intervention.
  // -------------------------------------------------------------------------

  describe('lock cleanup on failure paths', () => {
    it('cancels pre-created row when resumeWorkflowRun throws', async () => {
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'out1']])),
        resumeWorkflowRun: mock(async () => {
          throw new Error('DB blew up during resume activation');
        }),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preCreated
      );

      expect(result.success).toBe(false);
      const cancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'pre-created-orphan' &&
          (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(cancelCall).toBeDefined();
    });

    it('cancels workflowRun when guard query throws (no zombie row)', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('DB connection lost during guard');
        }),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1'
      );

      expect(result.success).toBe(false);
      const cancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(cancelCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Status-aware blocking message (review #3)
  //
  // The lock query returns running, paused, AND fresh-pending rows.
  // Telling a user to "wait" when the holder is `paused` is misleading --
  // they need to approve/reject to unblock it.
  // -------------------------------------------------------------------------

  describe('blocking message status awareness', () => {
    it('uses paused-specific copy when blocker is paused', async () => {
      const pausedRun = makeRun({
        id: 'paused-run-id',
        workflow_name: 'archon-implement',
        status: 'paused',
        started_at: new Date(Date.now() - 10000).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => pausedRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      // Wrong action ("wait for it to finish") would let users sit forever
      // on a workflow waiting for their own approval.
      expect(msg).toContain('paused');
      expect(msg).toContain('/workflow approve');
      expect(msg).toContain('/workflow reject');
      expect(msg).not.toContain('Wait for it to finish');
    });

    it('uses pending-specific copy when blocker is just starting', async () => {
      const pendingRun = makeRun({
        id: 'pending-run',
        workflow_name: 'archon-implement',
        status: 'pending',
        started_at: new Date(Date.now() - 500).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => pendingRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(msg).toContain('starting');
    });

    it('uses running copy by default', async () => {
      const runningRun = makeRun({
        id: 'running-run',
        workflow_name: 'archon-implement',
        status: 'running',
        started_at: new Date(Date.now() - 60000).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => runningRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(msg).toContain('running 1m');
      expect(msg).toContain('Wait for it to finish');
    });
  });
});

describe('finally backstop', () => {
  it('calls failWorkflowRun when run is still running at finally', async () => {
    const failSpy = mock(async () => {});
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'running' as const),
      failWorkflowRun: failSpy,
    });
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'test',
      'db-conv-1'
    );

    const call = (failSpy.mock.calls as unknown[][]).find(
      c => typeof c[1] === 'string' && (c[1] as string).includes('exited without finalizing')
    );
    expect(call).toBeDefined();
  });

  it('does not call failWorkflowRun when run already completed', async () => {
    const failSpy = mock(async () => {});
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'completed' as const),
      failWorkflowRun: failSpy,
    });
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'test',
      'db-conv-1'
    );

    const backstopCall = (failSpy.mock.calls as unknown[][]).find(
      c => typeof c[1] === 'string' && (c[1] as string).includes('exited without finalizing')
    );
    expect(backstopCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// target_repo pre-flight guard (Rule 28)
// ---------------------------------------------------------------------------

describe('target_repo pre-flight guard', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockGetRemoteUrl.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  it('blocks workflow when target_repo does not match origin remote', async () => {
    mockGetRemoteUrl.mockImplementation(
      async () => 'https://github.com/bluedevilcollectibles/bdc-harness.git'
    );
    const failWorkflowRunSpy = mock(async () => {});
    const createEventSpy = mock(async () => {});
    const store = makeStore({
      failWorkflowRun: failWorkflowRunSpy,
      createWorkflowEvent: createEventSpy,
    });
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ target_repo: 'bluedevilcollectibles/bdc-xo' }),
      'test message',
      'db-conv-1'
    );

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain('target_repo_mismatch');
    expect(failWorkflowRunSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('target_repo_mismatch')
    );
    // dag_workflow_failed event must be written
    const dagFailCall = (createEventSpy.mock.calls as unknown[][]).find(
      c => (c[0] as { event_type: string }).event_type === 'dag_workflow_failed'
    );
    expect(dagFailCall).toBeDefined();
    // dag-executor must NOT have been called
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('proceeds when target_repo matches origin remote (HTTPS)', async () => {
    mockGetRemoteUrl.mockImplementation(
      async () => 'https://github.com/bluedevilcollectibles/bdc-xo.git'
    );
    const store = makeStore();
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ target_repo: 'bluedevilcollectibles/bdc-xo' }),
      'test message',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(mockExecuteDagWorkflow).toHaveBeenCalled();
  });

  it('proceeds when target_repo matches origin remote (SSH)', async () => {
    mockGetRemoteUrl.mockImplementation(
      async () => 'git@github.com:bluedevilcollectibles/bdc-xo.git'
    );
    const store = makeStore();
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ target_repo: 'bluedevilcollectibles/bdc-xo' }),
      'test message',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(mockExecuteDagWorkflow).toHaveBeenCalled();
  });

  it('skips target_repo check when field is not set', async () => {
    // getRemoteUrl should never be called
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(), // no target_repo
      'test message',
      'db-conv-1'
    );

    expect(mockGetRemoteUrl).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).toHaveBeenCalled();
  });
});

describe('resolveExecutorLane -- M-20260726-87 Cause 2 (explicit-fire availability refusal)', () => {
  const ROUTER_OPTS = {
    routerYamlPath: '/fixture/router.yaml',
    routerYamlContent: `version: 1
tiers:
  "4":
    name: workhorse-subscription
    engines:
      - sonnet-subscription
      - codex-subscription
  "5":
    name: fable-opus
    engines:
      - fable-session
      - opus-api
defaults:
  fallback_tier: "4"
task_classes:
  spec-authoring:
    starting_tier: "5"
`,
  };

  beforeEach(() => {
    resetEngineAvailabilityForTests();
  });

  it('explicit workflowName still wins and fires when its engines are healthy', async () => {
    const lane = await resolveExecutorLane({
      workflowName: 'bdc-feature-development-fable',
      ...ROUTER_OPTS,
    });
    expect(lane).toBe('bdc-feature-development-fable');
  });

  it('explicit workflowName for a lane not wired to any router engine is never refused (no mapping != dark)', async () => {
    const lane = await resolveExecutorLane({
      workflowName: 'bdc-feature-development-fusion-cx-qwen',
      ...ROUTER_OPTS,
    });
    expect(lane).toBe('bdc-feature-development-fusion-cx-qwen');
  });

  it('refuses an explicit fire when the ONLY engine wired to that lane is dark', async () => {
    markEngineDarkIfZeroUsage('codex-subscription', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'implement',
    });

    await expect(
      resolveExecutorLane({
        workflowName: 'bdc-feature-development-codex',
        ...ROUTER_OPTS,
      })
    ).rejects.toThrow(LaneAvailabilityRefusedError);
  });

  it('does NOT refuse when only ONE of several engines wired to the lane is dark (fable lane has two: fable-session, opus-api)', async () => {
    markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'plan',
    });

    // opus-api (also wired to the fable lane) is still healthy -- the lane
    // is not FULLY dark, so the explicit fire proceeds.
    const lane = await resolveExecutorLane({
      workflowName: 'bdc-feature-development-fable',
      ...ROUTER_OPTS,
    });
    expect(lane).toBe('bdc-feature-development-fable');
  });

  it('refuses an explicit fire when BOTH engines wired to the fable lane are dark', async () => {
    markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'plan',
    });
    markEngineDarkIfZeroUsage('opus-api', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'plan',
    });

    let caught: unknown;
    try {
      await resolveExecutorLane({ workflowName: 'bdc-feature-development-fable', ...ROUTER_OPTS });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LaneAvailabilityRefusedError);
    const refusal = caught as LaneAvailabilityRefusedError;
    expect(refusal.workflowName).toBe('bdc-feature-development-fable');
    expect(refusal.darkEngines.sort()).toEqual(['fable-session', 'opus-api']);
  });

  it('taskClass path (no explicit workflowName) is unaffected by dark marks -- it climbs via resolveEntryLane as before', async () => {
    markEngineDarkIfZeroUsage('fable-session', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'plan',
    });
    markEngineDarkIfZeroUsage('opus-api', { input: 0, output: 0 }, 0, {
      runId: 'sim-run',
      nodeId: 'plan',
    });

    // spec-authoring starts at Tier 5; both its engines are dark, so the
    // ladder walk (already exercised in router-dispatcher.test.ts) falls
    // back down to Tier 4 -- no throw, just a different resolved lane.
    const lane = await resolveExecutorLane({ taskClass: 'spec-authoring', ...ROUTER_OPTS });
    expect(lane).toBe('bdc-feature-development');
  });
});
