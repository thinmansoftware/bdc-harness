/**
 * Tests for the authorization boundary in overseer-bridge.ts.
 *
 * Runs in a separate bun test invocation from overseer-bridge.test.ts because
 * mock.module calls must not conflict across test files.
 *
 * Strategy: The bridge calls runAuthorizedEscalation(runId, options) where
 * options.permit comes from permitFromMetadata(workflowRun.metadata).
 * No permit -> accepted=false, reason=permit_missing -> escalation_denied log.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';

let authorizedEscalationCallCount = 0;
let lastAuthorizedEscalationOptions: { permit: unknown; actor: string } | undefined;

mock.module('@archon/overseer', () => ({
  classifyError: (input: { message: string }) => {
    if (
      typeof input.message === 'string' &&
      (input.message.includes('npm') || input.message.includes('yarn'))
    )
      return 'npm_not_found';
    return 'unknown';
  },
  decide: (input: { errorClass: string }) => {
    if (input.errorClass === 'npm_not_found') {
      return { decision: 'skip', reason: 'tool missing' };
    }
    return {
      decision: 'escalate',
      reason: 'unknown failure',
      escalationContext: { errorClass: input.errorClass, woId: 'WO-GATE-TEST' },
    };
  },
  runAuthorizedEscalation: async (_runId: string, options: { permit: unknown; actor: string }) => {
    authorizedEscalationCallCount++;
    lastAuthorizedEscalationOptions = options;
    if (!options.permit) return { accepted: false, reason: 'permit_missing', mutation_sent: false };
    return { accepted: true, reason: 'fake_accepted', mutation_sent: false };
  },
  permitFromMetadata: (metadata: unknown) => {
    if (!metadata || typeof metadata !== 'object') return null;
    return (metadata as Record<string, unknown>).overseer_m31_permit ?? null;
  },
}));

const { handleNodeFailure } = await import('./overseer-bridge.ts');
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
import type { Logger } from '@archon/paths';

function makeMockStore(): IWorkflowStore {
  return {
    listWorkflowRuns: mock(() => Promise.resolve([])),
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    updateWorkflowRunStatus: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

function makeMockLog(): Logger {
  const noop = () => undefined as never;
  return {
    info: mock(noop),
    warn: mock(noop),
    error: mock(noop),
    debug: mock(noop),
    fatal: mock(noop),
    trace: mock(noop),
    silent: mock(noop),
    child: mock(() => makeMockLog()),
    bindings: mock(() => ({})),
    level: 'info',
    levels: { values: {}, labels: {} },
  } as unknown as Logger;
}

function makeWorkflowRun(metadata?: Record<string, unknown>): WorkflowRun {
  return {
    id: 'gate-test-run',
    workflow_name: 'test-wf',
    conversation_id: 'conv-gate',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'msg',
    workflow_def: {},
    skip_persona: false,
    started_at: new Date('2026-05-16T00:00:00Z').toISOString(),
    completed_at: null,
    error: null,
    metadata: metadata ?? null,
  } as unknown as WorkflowRun;
}

function makeNode(id = 'gate-node'): DagNode {
  return { id, command: 'test-cmd' } as DagNode;
}

function makeDeps() {
  const store = makeMockStore();
  const log = makeMockLog();
  const emitter = { emit: mock(() => undefined) };
  const logNodeError = mock(() => Promise.resolve());
  return { store, log, emitter, logNodeError };
}

function hasDeniedLog(log: Logger): boolean {
  const logInfo = log.info as unknown as { mock: { calls: unknown[][] } };
  return logInfo.mock.calls.some(call => call[1] === 'overseer.escalation_denied');
}

describe('handleNodeFailure -- authorization boundary', () => {
  afterEach(() => {
    authorizedEscalationCallCount = 0;
    lastAuthorizedEscalationOptions = undefined;
  });

  it('no permit -> boundary returns accepted=false/permit_missing -> escalation_denied log', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'something weird',
      logDir: '/tmp/test',
    });
    expect(authorizedEscalationCallCount).toBe(1);
    expect(lastAuthorizedEscalationOptions?.permit).toBeNull();
    expect(hasDeniedLog(deps.log)).toBe(true);
  });

  it('authorization boundary is always invoked for escalate decisions -- never bypassed', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'something weird',
      logDir: '/tmp/test',
    });
    expect(authorizedEscalationCallCount).toBe(1);
  });

  it('skip decision never invokes authorization boundary', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'npm: command not found',
      logDir: '/tmp/test',
    });
    expect(authorizedEscalationCallCount).toBe(0);
  });

  it('denial log reason is permit_missing -- boundary ran and rejected, not bypassed', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'something weird',
      logDir: '/tmp/test',
    });
    expect(authorizedEscalationCallCount).toBe(1);
    expect(hasDeniedLog(deps.log)).toBe(true);
    const logInfo = deps.log.info as unknown as { mock: { calls: unknown[][] } };
    const denialCall = logInfo.mock.calls.find(call => call[1] === 'overseer.escalation_denied');
    expect(denialCall).toBeDefined();
    const fields = denialCall![0] as Record<string, unknown>;
    expect(fields.reason).toBe('permit_missing');
  });

  it('valid permit metadata is passed only to the shared fake-safe boundary', async () => {
    const permit = { permit_id: 'permit-workflow-valid' };
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun({ overseer_m31_permit: permit }), makeNode(), {
      errorMsg: 'something weird',
      logDir: '/tmp/test',
    });

    expect(authorizedEscalationCallCount).toBe(1);
    expect(lastAuthorizedEscalationOptions).toEqual({
      permit,
      actor: 'overseer-workflow-bridge',
    });
    expect(hasDeniedLog(deps.log)).toBe(false);
  });
});
