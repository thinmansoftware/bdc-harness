/**
 * Tests for WO-HARNESS-LAYER1-CLIMB-AND-GATE-EVENTS-01:
 * - T1: cascade_step event emitted with from_tier/to_tier/gate/reason (store + emitter)
 * - T3: recordGateResult API smoke + buildGateResultField pass outcome
 * - T4: buildGateResultField backward compat (no gate_result key when undefined)
 *
 * T2/T2b live in overseer-bridge.test.ts (gate_result on node_failed via handleNodeFailure).
 * T4 full-shape backward compat (cost_usd/tokens/served_model unchanged) is proven by
 * the unchanged passing dag-executor.test.ts and overseer-bridge.test.ts suites.
 *
 * IMPORTANT: mock.module() must appear before any workflow package imports.
 * This file runs in its own bun test invocation to avoid mock pollution.
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock @archon/paths BEFORE importing from workflow packages.
// dag-executor.ts uses a lazy-initialized createLogger from @archon/paths;
// the mock must be in place before first import.
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({})),
  level: 'info',
  levels: { values: {}, labels: {} },
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// All workflow package imports AFTER mock registration.
import { emitCascadeStep, recordGateResult } from './dag-executor.ts';
import {
  buildGateResultField,
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
} from './event-emitter.ts';
import type { GateResult } from './event-emitter.ts';
import type { IWorkflowStore } from './store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStore(): Pick<IWorkflowStore, 'createWorkflowEvent'> {
  return {
    createWorkflowEvent: mock(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// T1: emitCascadeStep -- store event + in-process emitter
// ---------------------------------------------------------------------------

describe('T1: emitCascadeStep', () => {
  beforeEach(() => {
    resetWorkflowEventEmitter();
    mockLogFn.mockClear();
  });

  it('emits cascade_step store event with from_tier/to_tier/gate/reason', async () => {
    const store = makeMockStore();
    const capturedEmits: unknown[] = [];
    const unsub = getWorkflowEventEmitter().subscribe(e => capturedEmits.push(e));

    emitCascadeStep(store, { id: 'run-abc' }, 'node-x', {
      from_tier: 'haiku',
      to_tier: 'sonnet',
      gate: 'tests',
      reason: 'tsc failed: 14 errors',
    });

    unsub();

    // Assert store event
    const createEvent = store.createWorkflowEvent as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(createEvent.mock.calls).toHaveLength(1);
    const ev = createEvent.mock.calls[0][0] as {
      event_type: string;
      step_name: string;
      data: Record<string, unknown>;
    };
    expect(ev.event_type).toBe('cascade_step');
    expect(ev.step_name).toBe('node-x');
    expect(ev.data.from_tier).toBe('haiku');
    expect(ev.data.to_tier).toBe('sonnet');
    expect(ev.data.gate).toBe('tests');
    expect(ev.data.reason).toBe('tsc failed: 14 errors');

    // Assert in-process emitter event
    expect(capturedEmits).toHaveLength(1);
    const emitted = capturedEmits[0] as {
      type: string;
      runId: string;
      nodeId: string;
      from_tier: string;
      to_tier: string;
      gate: string;
      reason: string;
    };
    expect(emitted.type).toBe('cascade_step');
    expect(emitted.runId).toBe('run-abc');
    expect(emitted.nodeId).toBe('node-x');
    expect(emitted.from_tier).toBe('haiku');
    expect(emitted.to_tier).toBe('sonnet');
    expect(emitted.gate).toBe('tests');
    expect(emitted.reason).toBe('tsc failed: 14 errors');
  });
});

// ---------------------------------------------------------------------------
// T3: recordGateResult API smoke + buildGateResultField pass outcome
// ---------------------------------------------------------------------------

describe('T3: gate pass path', () => {
  it('recordGateResult is callable with a pass GateResult without throwing', () => {
    // Smoke-tests the exported API shape and Map write.
    // Full integration (pendingGateResults -> node_completed event) requires
    // executeDagWorkflow harness (out of Phase 3 scope); T4 backward compat
    // is proven by the existing dag-executor.test.ts suite passing unchanged.
    expect(() =>
      recordGateResult('run-1', 'node-1', {
        gate: 'tests',
        outcome: 'pass',
        reason: 'all checks passed',
      })
    ).not.toThrow();
  });

  it('buildGateResultField returns { gate_result: { outcome: "pass" } } when outcome is pass', () => {
    const gr: GateResult = { gate: 'ci', outcome: 'pass', reason: 'all checks passed' };
    const result = buildGateResultField(gr);
    expect(result).toEqual({
      gate_result: { gate: 'ci', outcome: 'pass', reason: 'all checks passed' },
    });
    expect((result as Record<string, unknown>).gate_result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T4: buildGateResultField backward compat -- no gate_result key when undefined
// ---------------------------------------------------------------------------

describe('T4: buildGateResultField backward compat', () => {
  it('returns {} when gateResult is undefined (no gate_result key on spread)', () => {
    const result = buildGateResultField(undefined);
    expect(result).toEqual({});
    expect('gate_result' in result).toBe(false);
  });
});
