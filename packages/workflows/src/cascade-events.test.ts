/**
 * Tests for cascade-events.ts -- WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01.
 *
 * T1: emitCascadeStep persists a cascade_step row + emits a cascade_step
 *     event with from_tier / to_tier / gate / reason (all four asserted).
 * T3: GateResult outcome:'pass' spreads correctly into a node_completed-shape
 *     payload, with existing fields (cost_usd) preserved.
 * T4 (node_completed compat): when nodeGateResult is undefined the spread is
 *     a no-op and existing node_completed fields (cost_usd, served_model_id)
 *     remain present and unchanged. T4 for node_failed (overseer_class /
 *     overseer_decision still present) lives in overseer-bridge.test.ts.
 *
 * Mock pattern: zero mock.module() calls -- inline object mocks identical to
 * overseer-bridge.test.ts. This file runs in its own isolated `bun test`
 * invocation per packages/workflows/package.json.
 */

import { describe, it, expect, mock } from 'bun:test';
import { emitCascadeStep, type GateResult } from './cascade-events.ts';
import type { IWorkflowStore } from './store.ts';
import type { Logger } from '@archon/paths';
import type { WorkflowEmitterEvent } from './event-emitter.ts';

// --- Minimal mocks ----------------------------------------------------------

function makeMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    findResumableRun: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    resumeWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve(null)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
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

function makeDeps() {
  const store = makeMockStore();
  const log = makeMockLog();
  const emitted: WorkflowEmitterEvent[] = [];
  const emitter = {
    emit: mock((event: WorkflowEmitterEvent) => {
      emitted.push(event);
    }),
  };
  return { store, log, emitter, emitted };
}

// --- Tests ------------------------------------------------------------------

describe('cascade-events -- emitCascadeStep (T1)', () => {
  it('T1: persists cascade_step row + emits cascade_step event with all 4 fields', async () => {
    const { store, log, emitter, emitted } = makeDeps();

    await emitCascadeStep({ store, log, emitter }, 'run-abc', 'node-xyz', {
      from_tier: 'haiku',
      to_tier: 'sonnet',
      gate: 'tests',
      reason: 'coverage below 80%',
    });

    // Assertion 1: store.createWorkflowEvent called exactly once with cascade_step
    const createEvent = store.createWorkflowEvent as unknown as { mock: { calls: unknown[][] } };
    expect(createEvent.mock.calls.length).toBe(1);
    const persisted = createEvent.mock.calls[0][0] as {
      workflow_run_id: string;
      event_type: string;
      step_name: string;
      data: Record<string, unknown>;
    };
    expect(persisted.event_type).toBe('cascade_step');
    expect(persisted.workflow_run_id).toBe('run-abc');
    expect(persisted.step_name).toBe('node-xyz');
    expect(persisted.data.from_tier).toBe('haiku');
    expect(persisted.data.to_tier).toBe('sonnet');
    expect(persisted.data.gate).toBe('tests');
    expect(persisted.data.reason).toBe('coverage below 80%');

    // Assertion 2: emitter.emit called exactly once with cascade_step + all 4 fields
    expect(emitted.length).toBe(1);
    const ev = emitted[0];
    expect(ev.type).toBe('cascade_step');
    if (ev.type === 'cascade_step') {
      expect(ev.runId).toBe('run-abc');
      expect(ev.nodeId).toBe('node-xyz');
      expect(ev.from_tier).toBe('haiku');
      expect(ev.to_tier).toBe('sonnet');
      expect(ev.gate).toBe('tests');
      expect(ev.reason).toBe('coverage below 80%');
    }
  });

  it('T1 (additive): store.createWorkflowEvent rejection does not throw (fire-and-forget)', async () => {
    const { log, emitter } = makeDeps();
    const store = {
      createWorkflowEvent: mock(() => Promise.reject(new Error('db down'))),
    } as unknown as IWorkflowStore;

    // Must not throw -- emitCascadeStep treats persistence as observable-only.
    await emitCascadeStep({ store, log, emitter }, 'run-1', 'node-1', {
      from_tier: 'a',
      to_tier: 'b',
      gate: 'tests',
      reason: 'x',
    });

    // Wait one microtask tick for the .catch() handler to log the error.
    await Promise.resolve();
    await Promise.resolve();

    // Emitter still fires even when persistence failed.
    expect((emitter.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
    // Error was logged via deps.log.error.
    const errCalls = (log.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(errCalls.length).toBeGreaterThanOrEqual(1);
    const errFields = errCalls[0][0] as Record<string, unknown>;
    expect(errFields.eventType).toBe('cascade_step');
  });
});

describe('cascade-events -- GateResult spread mechanism (T3 + T4 node_completed compat)', () => {
  it('T3: GateResult pass spreads into node_completed-shape payload', () => {
    // Arrange: simulate the dag-executor node_completed conditional-spread
    // pattern with a real GateResult.
    const nodeGateResult: GateResult = {
      gate: 'tests',
      outcome: 'pass',
      reason: '42 / 42 tests pass',
    };

    const data: Record<string, unknown> = {
      duration_ms: 100,
      cost_usd: 0.001,
      served_model_id: 'claude-3-haiku',
      entry_rung: 'haiku',
      ...(nodeGateResult ? { gate_result: nodeGateResult } : {}),
    };

    // Assertion 1: gate_result is present and well-typed.
    expect(data.gate_result).toBeDefined();
    const gr = data.gate_result as GateResult;
    expect(gr.gate).toBe('tests');
    expect(gr.outcome).toBe('pass');
    expect(gr.reason).toBe('42 / 42 tests pass');

    // Assertion 2: existing node_completed fields are UNCHANGED -- the spread
    // is additive, never destructive (T4 backward-compat for node_completed).
    expect(data.duration_ms).toBe(100);
    expect(data.cost_usd).toBe(0.001);
    expect(data.served_model_id).toBe('claude-3-haiku');
    expect(data.entry_rung).toBe('haiku');
  });

  it('T4 (node_completed compat): undefined nodeGateResult => no gate_result key', () => {
    // Arrange: simulate Phase 3 default state where Phase 5's cascade engine
    // has not yet assigned a GateResult to nodeGateResult.
    const nodeGateResult: GateResult | undefined = undefined;

    const data: Record<string, unknown> = {
      duration_ms: 250,
      cost_usd: 0.002,
      served_model_id: 'claude-3-sonnet',
      entry_rung: 'sonnet',
      ...(nodeGateResult ? { gate_result: nodeGateResult } : {}),
    };

    // Assertion 1: existing fields preserved exactly.
    expect(data.duration_ms).toBe(250);
    expect(data.cost_usd).toBe(0.002);
    expect(data.served_model_id).toBe('claude-3-sonnet');
    expect(data.entry_rung).toBe('sonnet');

    // Assertion 2: gate_result key is ABSENT (own-property check, not just
    // undefined value -- the spread must produce no key at all).
    expect(Object.prototype.hasOwnProperty.call(data, 'gate_result')).toBe(false);
  });

  it('T3 (fail variant): GateResult fail spreads through with reason preserved', () => {
    const nodeGateResult: GateResult = {
      gate: 'validator',
      outcome: 'fail',
      reason: 'manifest missing required field tests_passing',
    };

    const data: Record<string, unknown> = {
      duration_ms: 50,
      ...(nodeGateResult ? { gate_result: nodeGateResult } : {}),
    };

    expect(data.gate_result).toBeDefined();
    const gr = data.gate_result as GateResult;
    expect(gr.gate).toBe('validator');
    expect(gr.outcome).toBe('fail');
    expect(gr.reason).toBe('manifest missing required field tests_passing');
  });
});

// --- T3-real: round-trip through the real WorkflowEventEmitter --------------
// The original T3 above asserted only the spread mechanics in isolation. This
// suite exercises the production singleton emitter path that dag-executor
// actually uses, so a typed gateResult survives emit -> subscribe end-to-end
// for both node_completed and node_failed.

import { getWorkflowEventEmitter, resetWorkflowEventEmitter } from './event-emitter.ts';

describe('cascade-events -- real WorkflowEventEmitter round-trip (T3-real)', () => {
  it('T3-real: gateResult survives the real emitter for node_completed', () => {
    resetWorkflowEventEmitter();
    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    const gateResult: GateResult = {
      gate: 'tests',
      outcome: 'pass',
      reason: '42 / 42 tests pass',
    };

    try {
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: 'run-t3-real',
        nodeId: 'node-real',
        nodeName: 'node-real',
        duration: 100,
        costUsd: 0.001,
        gateResult,
      });
    } finally {
      unsubscribe();
    }

    expect(received.length).toBe(1);
    const event = received[0];
    expect(event.type).toBe('node_completed');
    if (event.type !== 'node_completed') return;
    // Existing fields unchanged.
    expect(event.runId).toBe('run-t3-real');
    expect(event.nodeId).toBe('node-real');
    expect(event.duration).toBe(100);
    expect(event.costUsd).toBe(0.001);
    // New additive gateResult field round-trips with full shape.
    expect(event.gateResult).toBeDefined();
    expect(event.gateResult!.gate).toBe('tests');
    expect(event.gateResult!.outcome).toBe('pass');
    expect(event.gateResult!.reason).toBe('42 / 42 tests pass');
  });

  it('T3-real: gateResult survives the real emitter for node_failed', () => {
    resetWorkflowEventEmitter();
    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    const gateResult: GateResult = {
      gate: 'manifest',
      outcome: 'fail',
      reason: 'manifest missing tests_passing field',
    };

    try {
      getWorkflowEventEmitter().emit({
        type: 'node_failed',
        runId: 'run-t3-real-fail',
        nodeId: 'node-real-fail',
        nodeName: 'node-real-fail',
        error: 'manifest invalid',
        gateResult,
      });
    } finally {
      unsubscribe();
    }

    expect(received.length).toBe(1);
    const event = received[0];
    expect(event.type).toBe('node_failed');
    if (event.type !== 'node_failed') return;
    // Existing fields unchanged.
    expect(event.runId).toBe('run-t3-real-fail');
    expect(event.nodeId).toBe('node-real-fail');
    expect(event.error).toBe('manifest invalid');
    // New additive gateResult field round-trips with full shape.
    expect(event.gateResult).toBeDefined();
    expect(event.gateResult!.gate).toBe('manifest');
    expect(event.gateResult!.outcome).toBe('fail');
    expect(event.gateResult!.reason).toBe('manifest missing tests_passing field');
  });

  it('T4-real: node_completed without gateResult has no gateResult key on the event', () => {
    resetWorkflowEventEmitter();
    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    try {
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: 'run-t4-real',
        nodeId: 'node-no-gate',
        nodeName: 'node-no-gate',
        duration: 250,
        costUsd: 0.002,
      });
    } finally {
      unsubscribe();
    }

    expect(received.length).toBe(1);
    const event = received[0] as Record<string, unknown>;
    // gateResult key must be ABSENT on the emitted event itself, not just
    // present-with-undefined, so subscribers can rely on hasOwnProperty.
    expect(Object.prototype.hasOwnProperty.call(event, 'gateResult')).toBe(false);
  });
});

// --- T5: emitCascadeStep is re-exported from dag-executor for Phase 5 ------
// Documents the cross-module reachability contract: the cascade engine in
// Phase 5 can import emitCascadeStep from either ./cascade-events or the
// executor surface (./dag-executor), the same way it imports handleNodeFailure
// from ./overseer-bridge today.
import { emitCascadeStep as emitCascadeStepFromExecutor } from './dag-executor.ts';
import { emitCascadeStep as emitCascadeStepDirect } from './cascade-events.ts';

describe('cascade-events -- emitCascadeStep reachability (T5)', () => {
  it('T5: emitCascadeStep re-export from dag-executor is the same helper', () => {
    expect(emitCascadeStepFromExecutor).toBe(emitCascadeStepDirect);
  });
});
