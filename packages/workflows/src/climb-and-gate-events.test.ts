/**
 * Tests for WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01
 *
 * T1: emitCascadeStep emits cascade_step event with all 4 required fields
 * T2: handleNodeFailure with gate_result:fail includes gate_result in store + emitter
 * T3: applyGateResult includes gate_result when gateResult is pass
 * T4: backward compat -- gate_result absent when gateResult is undefined; existing fields unchanged
 */

import { describe, it, expect, mock } from 'bun:test';
import { emitCascadeStep } from './cascade-step.ts';
import type { CascadeStepDeps } from './cascade-step.ts';
import { applyGateResult } from './gate-result.ts';
import { handleNodeFailure } from './overseer-bridge.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { Logger } from '@archon/paths';

// --- Minimal mocks (follow overseer-bridge.test.ts pattern) -------------------

function makeMockStore(): IWorkflowStore {
  return {
    listWorkflowRuns: mock(() => Promise.resolve([])),
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    findResumableRun: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    resumeWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    updateWorkflowRunStatus: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  } as unknown as IWorkflowStore;
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

function makeWorkflowRun(): WorkflowRun {
  return {
    id: 'run-1',
    workflow_name: 'test-wf',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'msg',
    workflow_def: {},
    skip_persona: false,
    started_at: new Date('2026-06-29T00:00:00Z').toISOString(),
    completed_at: null,
    error: null,
    metadata: null,
  } as unknown as WorkflowRun;
}

function makeNode(id = 'test-node', overrides?: Partial<DagNode>): DagNode {
  return { id, command: 'test-cmd', ...overrides } as DagNode;
}

function makeDeps() {
  const store = makeMockStore();
  const log = makeMockLog();
  const emitter = { emit: mock(() => undefined) };
  const logNodeError = mock(() => Promise.resolve());
  return { store, log, emitter, logNodeError };
}

// --- T1 -----------------------------------------------------------------------

describe('T1: emitCascadeStep', () => {
  it('emits cascade_step with all 4 required fields (store + emitter)', async () => {
    const store = makeMockStore();
    const emitter = { emit: mock(() => undefined) };
    const deps: CascadeStepDeps = { store, emitter };
    const run = makeWorkflowRun();

    await emitCascadeStep(deps, run, 'node-1', {
      from_tier: 'sonnet',
      to_tier: 'opus',
      failed_gate: 'tests',
      reason: '2 failures',
    });

    // Store assertion
    const createEvent = store.createWorkflowEvent as unknown as { mock: { calls: unknown[][] } };
    expect(createEvent.mock.calls.length).toBe(1);
    const storePayload = createEvent.mock.calls[0][0] as {
      workflow_run_id: string;
      event_type: string;
      step_name: string;
      data: Record<string, unknown>;
    };
    expect(storePayload.event_type).toBe('cascade_step');
    expect(storePayload.workflow_run_id).toBe('run-1');
    expect(storePayload.step_name).toBe('node-1');
    expect(storePayload.data.from_tier).toBe('sonnet');
    expect(storePayload.data.to_tier).toBe('opus');
    expect(storePayload.data.failed_gate).toBe('tests');
    expect(storePayload.data.reason).toBe('2 failures');

    // Emitter assertion
    const emitMock = emitter.emit as unknown as { mock: { calls: unknown[][] } };
    expect(emitMock.mock.calls.length).toBe(1);
    const emitEvent = emitMock.mock.calls[0][0] as Record<string, unknown>;
    expect(emitEvent.type).toBe('cascade_step');
    expect(emitEvent.runId).toBe('run-1');
    expect(emitEvent.nodeId).toBe('node-1');
    expect(emitEvent.fromTier).toBe('sonnet');
    expect(emitEvent.toTier).toBe('opus');
    expect(emitEvent.failedGate).toBe('tests');
    expect(emitEvent.reason).toBe('2 failures');
  });
});

// --- T2 -----------------------------------------------------------------------

describe('T2: handleNodeFailure gate_result:fail passthrough', () => {
  it('includes structured gate_result in createWorkflowEvent data and emitter event', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'tests failed',
      logDir: '/tmp',
      outputSoFar: '',
      gate_result: { gate: 'tests', result: 'fail', reason: '3 test failures' },
    });

    // Store assertion
    const createEvent = deps.store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const storePayload = createEvent.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(storePayload.data.gate_result).toEqual({
      gate: 'tests',
      result: 'fail',
      reason: '3 test failures',
    });

    // Emitter assertion
    const emitMock = deps.emitter.emit as unknown as { mock: { calls: unknown[][] } };
    expect(emitMock.mock.calls.length).toBe(1);
    const emitEvent = emitMock.mock.calls[0][0] as Record<string, unknown>;
    expect(emitEvent.gateResult).toEqual({
      gate: 'tests',
      result: 'fail',
      reason: '3 test failures',
    });
  });
});

// --- T3 -----------------------------------------------------------------------

describe('T3: applyGateResult with pass', () => {
  it('includes gate_result when gateResult is pass, preserves existing fields', () => {
    const result = applyGateResult(
      { duration_ms: 100, node_output: 'ok' },
      { gate: 'tests', result: 'pass' }
    );
    expect(result.gate_result).toEqual({ gate: 'tests', result: 'pass' });
    expect(result.duration_ms).toBe(100);
    expect(result.node_output).toBe('ok');
  });
});

// --- T4 -----------------------------------------------------------------------

describe('T4: backward compatibility', () => {
  it('T4a: applyGateResult is identity when gateResult is undefined; existing fields unchanged', () => {
    const result = applyGateResult(
      {
        duration_ms: 500,
        cost_usd: 0.01,
        tokens: { input: 100, output: 50 },
        served_model_id: 'claude-sonnet-4-5',
      },
      undefined
    );
    expect('gate_result' in result).toBe(false);
    expect(result.cost_usd).toBe(0.01);
    expect(result.tokens).toEqual({ input: 100, output: 50 });
    expect(result.served_model_id).toBe('claude-sonnet-4-5');
    expect(result.duration_ms).toBe(500);
  });

  it('T4b: handleNodeFailure without gate_result -- existing data fields preserved, no gate_result', async () => {
    const deps = makeDeps();
    await handleNodeFailure(deps, makeWorkflowRun(), makeNode(), {
      errorMsg: 'something failed',
      logDir: '/tmp',
      outputSoFar: '',
    });

    const createEvent = deps.store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const storePayload = createEvent.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect('gate_result' in storePayload.data).toBe(false);
    expect(storePayload.data.error).toBe('something failed');
    expect(storePayload.data.overseer_class).toBeDefined();
    expect(storePayload.data.overseer_decision).toBeDefined();
  });
});
