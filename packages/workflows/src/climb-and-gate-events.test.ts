/**
 * Tests for Layer 1 climb + gate events
 * (WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01).
 *
 * Four scenarios per the WO:
 *   T1 -- cascade_step event has all 4 required fields
 *   T2 -- node_failed with gate fail writes structured gate_result
 *   T3 -- node_completed emitter event with gate pass carries gateResult
 *   T4 -- existing fields on node_failed events are unchanged (backward compat)
 *
 * The bridge tests (T2/T4) use the REAL @archon/overseer classifier so a future
 * change to either the classifier or the bridge can't silently regress.
 *
 * This file runs in its own `bun test` invocation (see package.json `test`
 * script) to avoid mock.module pollution across siblings.
 */

import { describe, it, expect, mock } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) -----------
// cascade-events.ts and event-emitter.ts both use a lazy-initialized logger
// via getLog(); we mock @archon/paths before any import of those modules.

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
}));

// --- Imports (after mocks) --------------------------------------------------

import { emitCascadeStep } from './cascade-events.ts';
import { handleNodeFailure } from './overseer-bridge.ts';
import {
  gateResultPayload,
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
  type WorkflowEmitterEvent,
  type GateResult,
} from './event-emitter.ts';
import type { WorkflowRun } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { Logger } from '@archon/paths';

// --- Minimal mocks (mirrors overseer-bridge.test.ts) ------------------------

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
    id: 'test-run',
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

const baseCtx = { errorMsg: '', logDir: '/tmp/test-logs', outputSoFar: '' };

// ---------------------------------------------------------------------------
// T1 -- cascade_step event has all 4 required fields
// ---------------------------------------------------------------------------

describe('emitCascadeStep -- structured tier-climb event', () => {
  it('T1: persists cascade_step with from_tier, to_tier, gate, reason AND emits the same on the workflow emitter', async () => {
    resetWorkflowEventEmitter();

    const store = makeMockStore();
    const run = makeWorkflowRun();
    const captured: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => captured.push(event));

    await emitCascadeStep(store, run, 'node-a', {
      from_tier: 'haiku',
      to_tier: 'sonnet',
      gate: 'tests',
      reason: 'test suite failed',
    });

    // Persistence assertion
    const createEvent = store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const payload = createEvent.mock.calls[0][0] as {
      workflow_run_id: string;
      event_type: string;
      step_name?: string;
      data: Record<string, unknown>;
    };
    expect(payload.event_type).toBe('cascade_step');
    expect(payload.workflow_run_id).toBe('test-run');
    expect(payload.step_name).toBe('node-a');
    expect(payload.data.from_tier).toBe('haiku');
    expect(payload.data.to_tier).toBe('sonnet');
    expect(payload.data.gate).toBe('tests');
    expect(payload.data.reason).toBe('test suite failed');

    // Emitter assertion -- same 4 fields surface to subscribers
    expect(captured.length).toBe(1);
    const event = captured[0];
    expect(event.type).toBe('cascade_step');
    if (event.type === 'cascade_step') {
      expect(event.runId).toBe('test-run');
      expect(event.nodeId).toBe('node-a');
      expect(event.from_tier).toBe('haiku');
      expect(event.to_tier).toBe('sonnet');
      expect(event.gate).toBe('tests');
      expect(event.reason).toBe('test suite failed');
    }

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// T2 -- node_failed with gate fail writes structured gate_result
// ---------------------------------------------------------------------------

describe('handleNodeFailure -- gate fail records structured gate_result', () => {
  it('T2: gateResult on failure surfaces as gate_result on the persisted node_failed event AND as gateResult on the emitter event', async () => {
    const deps = makeDeps();
    const gateResult: GateResult = {
      gate: 'tests',
      outcome: 'fail',
      reason: 'TypeScript type error',
    };

    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('gate-node'), {
      ...baseCtx,
      // 'something weird happened' classifies as `unknown` -> escalate without
      // escalationContext, so runEscalation does NOT fire. Keeps the test
      // hermetic (no Notion / disk / webhook side effects).
      errorMsg: 'something weird happened during tsc',
      gateResult,
    });

    const createEvent = deps.store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const payload = createEvent.mock.calls[0][0] as {
      event_type: string;
      data: Record<string, unknown>;
    };
    expect(payload.event_type).toBe('node_failed');
    // Structured gate_result is present (not parsed from error text)
    const persistedGate = payload.data.gate_result as GateResult;
    expect(persistedGate).toBeDefined();
    expect(persistedGate.gate).toBe('tests');
    expect(persistedGate.outcome).toBe('fail');
    expect(persistedGate.reason).toBe('TypeScript type error');
    // Existing error field is NOT displaced by the new gate_result field
    expect(payload.data.error).toBe('something weird happened during tsc');

    // Emitter mirror -- gateResult surfaces on the in-process event too
    const emit = deps.emitter.emit as unknown as { mock: { calls: unknown[][] } };
    expect(emit.mock.calls.length).toBe(1);
    const event = emit.mock.calls[0][0] as {
      type: string;
      gateResult?: GateResult;
    };
    expect(event.type).toBe('node_failed');
    expect(event.gateResult).toBeDefined();
    expect(event.gateResult?.outcome).toBe('fail');
    expect(event.gateResult?.gate).toBe('tests');
  });
});

// ---------------------------------------------------------------------------
// T3 -- node_completed emitter event with gate pass carries gateResult
// ---------------------------------------------------------------------------

describe('WorkflowEventEmitter -- node_completed gate pass', () => {
  it('T3: a node_completed emitted with gateResult.outcome=pass reaches subscribers with the structured field intact', () => {
    resetWorkflowEventEmitter();

    const captured: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => captured.push(event));

    getWorkflowEventEmitter().emit({
      type: 'node_completed',
      runId: 'r1',
      nodeId: 'n1',
      nodeName: 'n',
      duration: 100,
      gateResult: { gate: 'validator', outcome: 'pass' },
    });

    expect(captured.length).toBe(1);
    const event = captured[0];
    expect(event.type).toBe('node_completed');
    if (event.type === 'node_completed') {
      expect(event.runId).toBe('r1');
      expect(event.nodeId).toBe('n1');
      expect(event.duration).toBe(100);
      expect(event.gateResult).toBeDefined();
      expect(event.gateResult?.outcome).toBe('pass');
      expect(event.gateResult?.gate).toBe('validator');
    }

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// T4 -- existing fields on node_failed events are unchanged (backward compat)
// ---------------------------------------------------------------------------

describe('handleNodeFailure -- backward compatibility', () => {
  it('T4: when gateResult is NOT passed, existing fields (error, overseer_class, overseer_decision) are present and no spurious gate_result is injected', async () => {
    const deps = makeDeps();

    await handleNodeFailure(deps, makeWorkflowRun(), makeNode('bc-node'), {
      ...baseCtx,
      // 'something weird happened' classifies as `unknown` -> escalate.
      errorMsg: 'something weird happened',
      // No gateResult -- the omit-when-absent contract must NOT add the field.
    });

    const createEvent = deps.store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls.length).toBe(1);
    const payload = createEvent.mock.calls[0][0] as {
      event_type: string;
      data: Record<string, unknown>;
    };
    expect(payload.event_type).toBe('node_failed');
    expect(payload.data.error).toBe('something weird happened');
    expect(payload.data.overseer_class).toBe('unknown');
    expect(payload.data.overseer_decision).toBe('escalate');
    // The omit-when-absent invariant: gate_result must be entirely absent
    // from the payload (not present as undefined, not present as null).
    expect('gate_result' in payload.data).toBe(false);

    // Emitter mirror: same invariant on the in-process event.
    const emit = deps.emitter.emit as unknown as { mock: { calls: unknown[][] } };
    expect(emit.mock.calls.length).toBe(1);
    const event = emit.mock.calls[0][0] as Record<string, unknown>;
    expect(event.type).toBe('node_failed');
    expect('gateResult' in event).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T5/T6 -- gateResultPayload helper: structural proof of the spread invariant
//
// The dag-executor sites currently spread `gateResultPayload(<key>,
// nodeGateResult)` into event payloads. In Phase 3 `nodeGateResult` is always
// undefined at those sites, which means the integration test at
// dag-executor.test.ts only exercises the negative (omit-when-absent) branch.
//
// These unit tests directly exercise the helper with both branches, so the
// positive case ("when nodeGateResult is set, gate_result/gateResult appears
// under the exact key with the exact value") is proven structurally today --
// before Phase 5 (WO-HARNESS-V1-PERRUN-CASCADE-01) ever assigns
// nodeGateResult. The combination of:
//   (a) T5/T6: helper is structurally correct under both branches
//   (b) Production code calls the helper at every emit/persist site (verified
//       by reading dag-executor.ts -- the 7 spreads are all `...gateResultPayload(...)`)
//   (c) Existing integration test: the negative branch fires in real execution
// means the Phase 5 patch only has to set `nodeGateResult = ...`; the wire
// from that assignment through to node_completed / node_failed payloads is
// already verified end-to-end.
// ---------------------------------------------------------------------------

describe('gateResultPayload -- spread helper', () => {
  it('T5: returns {} when gateResult is undefined (omit-when-absent contract)', () => {
    // Both key variants -- the snake_case persist key and the camelCase emit key.
    const persistEmpty = gateResultPayload('gate_result', undefined);
    expect(persistEmpty).toEqual({});
    expect(Object.keys(persistEmpty).length).toBe(0);
    expect('gate_result' in persistEmpty).toBe(false);

    const emitEmpty = gateResultPayload('gateResult', undefined);
    expect(emitEmpty).toEqual({});
    expect(Object.keys(emitEmpty).length).toBe(0);
    expect('gateResult' in emitEmpty).toBe(false);
  });

  it('T6: returns { [key]: gateResult } when a GateResult is provided (positive wire proof)', () => {
    const failResult: GateResult = {
      gate: 'tests',
      outcome: 'fail',
      reason: 'TypeScript type error',
    };
    const passResult: GateResult = { gate: 'validator', outcome: 'pass' };

    // Persist key (snake_case): proves the wire used by
    //   createWorkflowEvent({ data: { ..., ...gateResultPayload('gate_result', x) } })
    // at both the node_completed and node_failed (catch block) call sites
    // in dag-executor.ts.
    const persistFail = gateResultPayload('gate_result', failResult);
    expect('gate_result' in persistFail).toBe(true);
    expect(persistFail.gate_result).toEqual(failResult);
    // Key must NOT be the camelCase variant -- catches a key-swap regression
    // that would silently break Mission Control's persisted-event query.
    expect('gateResult' in persistFail).toBe(false);

    // Emit key (camelCase): proves the wire used by
    //   emitter.emit({ ..., ...gateResultPayload('gateResult', x) })
    // and the handleNodeFailure ctx spread at the 3 failure-site call sites.
    const emitPass = gateResultPayload('gateResult', passResult);
    expect('gateResult' in emitPass).toBe(true);
    expect(emitPass.gateResult).toEqual(passResult);
    expect('gate_result' in emitPass).toBe(false);

    // Value identity -- not a shallow clone, since GateResult is a plain
    // value object the consumers carry through unmodified.
    expect(persistFail.gate_result).toBe(failResult);
    expect(emitPass.gateResult).toBe(passResult);
  });

  it('T6b: helper output spreads correctly into a host event payload (structural proof of the dag-executor call sites)', () => {
    // Simulates the exact pattern at dag-executor.ts node_completed
    // createWorkflowEvent.data construction.
    const failResult: GateResult = { gate: 'manifest', outcome: 'fail', reason: 'missing files' };
    const persistData = {
      duration_ms: 100,
      node_output: 'sample',
      ...gateResultPayload('gate_result', failResult),
    };
    expect(persistData).toEqual({
      duration_ms: 100,
      node_output: 'sample',
      gate_result: { gate: 'manifest', outcome: 'fail', reason: 'missing files' },
    });
    expect(persistData.gate_result).toBe(failResult);

    // Same simulation for the omit-when-absent branch -- proves the spread
    // adds no key when gateResult is undefined (matches Phase 3 production state).
    const persistDataAbsent = {
      duration_ms: 100,
      node_output: 'sample',
      ...gateResultPayload('gate_result', undefined),
    };
    expect(persistDataAbsent).toEqual({ duration_ms: 100, node_output: 'sample' });
    expect('gate_result' in persistDataAbsent).toBe(false);

    // Same simulation for the camelCase emitter spread -- proves the in-process
    // event-emitter event would carry gateResult when set.
    const passResult: GateResult = { gate: 'ci', outcome: 'pass' };
    const emitEvent = {
      type: 'node_completed' as const,
      runId: 'r1',
      nodeId: 'n1',
      nodeName: 'n',
      duration: 100,
      ...gateResultPayload('gateResult', passResult),
    };
    expect(emitEvent.gateResult).toEqual(passResult);
    expect(emitEvent.gateResult).toBe(passResult);
  });
});
