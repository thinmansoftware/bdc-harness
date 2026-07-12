// M-26 dual-truth run recovery -- core-side wiring and non-interference tests.
//
// WO Ambiguity 1: transitionRunRecovery() itself lives in @archon/workflows
// (packages/workflows/src/reliability/recovery-transition.ts) and is unit-tested
// there. Section 7 forbids that orchestration from living in this package's
// startup recovery module. This file therefore asserts the two things the
// core package is actually responsible for:
//
//   (a) the two NEW DB functions are wired into the IWorkflowStore built by
//       createWorkflowStore(), so the workflows-package orchestrator can reach
//       them at runtime; and
//   (b) the startup expired-lease recovery module (recovery.ts) is unchanged and
//       does NOT own the operator-driven recovery transition -- proving the new
//       path did not leak into startup recovery.
//
// It deliberately does NOT mock.module('../db/workflows'): store-adapter.test.ts
// already mocks that path with a different implementation, and Bun's
// mock.module is process-global and irreversible. Reference-equality checks are
// robust to that pollution because both sides resolve to the same module object.

import { describe, test, expect } from 'bun:test';
import { createWorkflowStore } from './store-adapter';
import * as workflowDb from '../db/workflows';
import * as startupRecovery from './recovery';

describe('M-26 recovery transition -- core wiring', () => {
  // Store-adapter must expose the two new DB functions so the workflows-package
  // orchestrator (transitionRunRecovery) can reach the atomic finalizer and the
  // read-only detail query through the injected IWorkflowStore.
  test('createWorkflowStore wires finalizeSupervisorRecoveryTransition to the DB module', () => {
    const store = createWorkflowStore();
    expect(typeof store.finalizeSupervisorRecoveryTransition).toBe('function');
    expect(store.finalizeSupervisorRecoveryTransition).toBe(
      workflowDb.finalizeSupervisorRecoveryTransition
    );
  });

  test('createWorkflowStore wires getRunRecoveryDetails to the DB module', () => {
    const store = createWorkflowStore();
    expect(typeof store.getRunRecoveryDetails).toBe('function');
    expect(store.getRunRecoveryDetails).toBe(workflowDb.getRunRecoveryDetails);
  });
});

describe('M-26 recovery transition -- startup recovery non-interference', () => {
  // Startup expired-lease recovery must remain intact and behaviorally unchanged
  // (Section 3 / Section 7: recovery.ts "MUST remain behaviorally unchanged").
  test('startup recovery still exports its reconcile/resume entry points', () => {
    expect(typeof startupRecovery.reconcileExpiredWorkflowLeases).toBe('function');
    expect(typeof startupRecovery.claimAndResumeInterruptedRun).toBe('function');
  });

  // The operator-driven recovery transition MUST NOT live in the startup module.
  // If it ever leaks in here, this guard fails and forces the placement back to
  // @archon/workflows.
  test('startup recovery does NOT own the operator recovery transition', () => {
    expect((startupRecovery as Record<string, unknown>).transitionRunRecovery).toBeUndefined();
    expect(
      (startupRecovery as Record<string, unknown>).finalizeSupervisorRecoveryTransition
    ).toBeUndefined();
  });
});
