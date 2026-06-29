/**
 * Tests for WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01.
 *
 * Layer 1 of the Smart Cauldron / Cauldron 2.0 data contract. Verifies:
 *   T1 -- emitCascadeStep emits a cascade_step event carrying from_tier,
 *         to_tier, gate, reason as structured data (both store and emitter
 *         paths).
 *   T2 -- gate_result on node_failed is persisted as a structured object via
 *         the existing extraEventData mechanism in overseer-bridge.ts.
 *   T3 -- gate_result on node_completed round-trips through the emitter as a
 *         structured object (gate, outcome).
 *   T4 -- existing node_completed fields (costUsd, stopReason, numTurns) are
 *         UNCHANGED in shape -- additive Layer 1 schema does not remove or
 *         rename existing fields.
 *
 * Test file lives at packages/workflows/src/climb-and-gate-events.test.ts and
 * runs in its own bun-test invocation (see package.json) to avoid
 * mock.module('@archon/paths') pollution across files.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock logger (MUST come before imports of modules under test) ------------
// event-emitter.ts + dag-executor.ts both use lazy-initialized loggers via
// createLogger(...) from @archon/paths, so the mock must be installed before
// either module is imported.

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
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// --- Imports (after mocks) ---------------------------------------------------

import { emitCascadeStep } from './dag-executor';
import {
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
  type WorkflowEmitterEvent,
  type GateResult,
} from './event-emitter';
import { handleNodeFailure } from './overseer-bridge';
import type { WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas/workflow-run';
import type { DagNode } from './schemas/dag-node';
import type { Logger } from '@archon/paths';

// --- Helpers -----------------------------------------------------------------

function makeWorkflowRun(id = 'run-test'): WorkflowRun {
  return {
    id,
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

function makeNode(id = 'node-1', overrides?: Partial<DagNode>): DagNode {
  return { id, command: 'test-cmd', ...overrides } as DagNode;
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

/**
 * Build a minimal WorkflowDeps whose only real method is store.createWorkflowEvent.
 * Other methods are stubbed and cast away -- emitCascadeStep only touches the
 * store via createWorkflowEvent, so the rest never run.
 */
function makeDepsForCascade(): {
  deps: WorkflowDeps;
  createWorkflowEvent: ReturnType<typeof mock>;
} {
  const createWorkflowEvent = mock(() => Promise.resolve());
  const deps: WorkflowDeps = {
    store: {
      createWorkflowEvent,
    } as unknown as IWorkflowStore,
    getAgentProvider: () => {
      throw new Error('not used in cascade_step tests');
    },
    loadConfig: () => {
      throw new Error('not used in cascade_step tests');
    },
  };
  return { deps, createWorkflowEvent };
}

// --- T1: cascade_step event carries from_tier, to_tier, gate, reason ---------

describe('T1: emitCascadeStep emits structured cascade_step event', () => {
  beforeEach(() => {
    resetWorkflowEventEmitter();
  });

  it('persists cascade_step event with all 4 required fields in data payload', async () => {
    const { deps, createWorkflowEvent } = makeDepsForCascade();
    const workflowRun = makeWorkflowRun('run-t1');

    await emitCascadeStep(
      deps,
      workflowRun,
      'node-1',
      'rung-1',
      'rung-2',
      'validator',
      'schema mismatch'
    );

    expect(createWorkflowEvent.mock.calls.length).toBe(1);
    const payload = createWorkflowEvent.mock.calls[0][0] as {
      workflow_run_id: string;
      event_type: string;
      step_name?: string;
      data?: Record<string, unknown>;
    };
    expect(payload.workflow_run_id).toBe('run-t1');
    expect(payload.event_type).toBe('cascade_step');
    expect(payload.step_name).toBe('node-1');
    expect(payload.data).toBeDefined();
    expect(payload.data!.from_tier).toBe('rung-1');
    expect(payload.data!.to_tier).toBe('rung-2');
    expect(payload.data!.gate).toBe('validator');
    expect(payload.data!.reason).toBe('schema mismatch');
  });

  it('emits cascade_step on the workflow event emitter with all 4 required fields', async () => {
    const { deps } = makeDepsForCascade();
    const workflowRun = makeWorkflowRun('run-t1b');

    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    try {
      await emitCascadeStep(
        deps,
        workflowRun,
        'node-2',
        'rung-2',
        'rung-3',
        'tests',
        'unit test failure'
      );
    } finally {
      unsubscribe();
    }

    const cascadeEvents = received.filter(e => e.type === 'cascade_step');
    expect(cascadeEvents.length).toBe(1);
    const event = cascadeEvents[0];
    if (event.type !== 'cascade_step') {
      throw new Error('expected cascade_step event');
    }
    expect(event.runId).toBe('run-t1b');
    expect(event.nodeId).toBe('node-2');
    expect(event.from_tier).toBe('rung-2');
    expect(event.to_tier).toBe('rung-3');
    expect(event.gate).toBe('tests');
    expect(event.reason).toBe('unit test failure');
  });
});

// --- T2: gate_result on node_failed is structured, not parsed text -----------

describe('T2: gate_result on node_failed is persisted as a structured object', () => {
  it('passes gate_result through extraEventData into the persisted node_failed event', async () => {
    // handleNodeFailure routes the optional extraEventData fields verbatim into
    // the createWorkflowEvent data payload. This is the Phase 5 wire path:
    // the cascade engine will populate ctx.extraEventData.gate_result; the
    // executor's overseer-bridge call already forwards it. We verify the
    // contract by passing it in directly and asserting the persisted event
    // contains gate_result as a structured object (not embedded in error text).
    const createWorkflowEvent = mock(() => Promise.resolve());
    const store = { createWorkflowEvent } as unknown as IWorkflowStore;
    const log = makeMockLog();
    const emitter = { emit: mock(() => undefined) };
    const logNodeError = mock(() => Promise.resolve());
    const deps = { store, log, emitter, logNodeError };

    const gateResult: GateResult = {
      gate: 'validator',
      outcome: 'fail',
      reason: 'output mismatch',
    };

    await handleNodeFailure(deps, makeWorkflowRun('run-t2'), makeNode('node-failing'), {
      errorMsg: 'test error',
      logDir: '/tmp/test-logs',
      outputSoFar: '',
      extraEventData: { gate_result: gateResult },
    });

    expect(createWorkflowEvent.mock.calls.length).toBe(1);
    const payload = createWorkflowEvent.mock.calls[0][0] as {
      event_type: string;
      data: Record<string, unknown>;
    };
    expect(payload.event_type).toBe('node_failed');

    // Critical assertion: gate_result is a STRUCTURED OBJECT on the event data,
    // not parsed out of error text. The full GateResult shape must survive.
    const persistedGateResult = payload.data.gate_result as GateResult;
    expect(typeof persistedGateResult).toBe('object');
    expect(persistedGateResult).not.toBeNull();
    expect(persistedGateResult.gate).toBe('validator');
    expect(persistedGateResult.outcome).toBe('fail');
    expect(persistedGateResult.reason).toBe('output mismatch');

    // The error text is preserved as `data.error` separately -- gate_result is
    // not stuffed into the error string.
    expect(payload.data.error).toBe('test error');
  });
});

// --- T3: gate_result = pass on node_completed round-trips through emitter ----

describe('T3: gate_result on node_completed survives emitter round-trip', () => {
  beforeEach(() => {
    resetWorkflowEventEmitter();
  });

  it('emits node_completed with gate_result {gate, outcome:pass} intact', () => {
    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    try {
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: 'run-t3',
        nodeId: 'n1',
        nodeName: 'n1',
        duration: 100,
        gate_result: { gate: 'tests', outcome: 'pass' },
      });
    } finally {
      unsubscribe();
    }

    expect(received.length).toBe(1);
    const event = received[0];
    if (event.type !== 'node_completed') {
      throw new Error('expected node_completed event');
    }
    expect(event.gate_result).toBeDefined();
    expect(event.gate_result!.gate).toBe('tests');
    expect(event.gate_result!.outcome).toBe('pass');
  });
});

// --- T4: existing node_completed fields are UNCHANGED ------------------------

describe('T4: existing node_completed fields remain UNCHANGED (backward compat)', () => {
  beforeEach(() => {
    resetWorkflowEventEmitter();
  });

  it('costUsd, stopReason, numTurns survive emit-and-subscribe alongside new gate_result', () => {
    const received: WorkflowEmitterEvent[] = [];
    const unsubscribe = getWorkflowEventEmitter().subscribe(event => {
      received.push(event);
    });

    try {
      getWorkflowEventEmitter().emit({
        type: 'node_completed',
        runId: 'run-t4',
        nodeId: 'n2',
        nodeName: 'n2',
        duration: 250,
        costUsd: 0.0015,
        stopReason: 'end_turn',
        numTurns: 3,
        gate_result: { gate: 'ci', outcome: 'pass' },
      });
    } finally {
      unsubscribe();
    }

    expect(received.length).toBe(1);
    const event = received[0];
    if (event.type !== 'node_completed') {
      throw new Error('expected node_completed event');
    }

    // Existing fields -- nothing renamed or removed.
    expect(event.runId).toBe('run-t4');
    expect(event.nodeId).toBe('n2');
    expect(event.nodeName).toBe('n2');
    expect(event.duration).toBe(250);
    expect(event.costUsd).toBe(0.0015);
    expect(event.stopReason).toBe('end_turn');
    expect(event.numTurns).toBe(3);

    // New additive field -- present alongside, does not disrupt the rest.
    expect(event.gate_result).toBeDefined();
    expect(event.gate_result!.gate).toBe('ci');
    expect(event.gate_result!.outcome).toBe('pass');
  });
});
