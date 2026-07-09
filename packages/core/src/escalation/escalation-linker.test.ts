/**
 * Tests for WO-HARNESS-ESCALATED-RUN-STATUS-01 escalated-run linker.
 *
 * Scenarios from the WO:
 * 1. failed+rejection-signal + same-WO successor => prior becomes escalated
 * 2. failed WITHOUT rejection signal + successor => prior stays failed
 * 4. no successor => status unchanged (linker only runs at dispatch time)
 * 5. packet inject: rejection findings marker present; plain-failed no packet
 */
import { describe, expect, test } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  extractWoId,
  hasValidatorRejectionSignal,
  linkEscalatedPredecessor,
  prepareDispatchWithEscalation,
  type EscalationLinkerStore,
} from './escalation-linker';
import { ESCALATION_FINDINGS_MARKER } from './escalation-packet-builder';

function makeRun(partial: Partial<WorkflowRun> & { id: string; user_message: string }): WorkflowRun {
  return {
    workflow_name: 'bdc-feature-development',
    conversation_id: 'c1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'failed',
    metadata: {},
    started_at: new Date('2026-07-07T10:00:00Z'),
    completed_at: new Date('2026-07-07T11:00:00Z'),
    last_activity_at: null,
    working_path: null,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    ...partial,
  };
}

function makeStore(opts: {
  failedRuns: WorkflowRun[];
  eventsByRun: Record<
    string,
    { event_type: string; step_name: string | null; data: Record<string, unknown> }[]
  >;
}): EscalationLinkerStore & {
  updates: { id: string; updates: { status?: string; metadata?: Record<string, unknown> } }[];
} {
  const updates: {
    id: string;
    updates: { status?: string; metadata?: Record<string, unknown> };
  }[] = [];
  return {
    updates,
    async listWorkflowRuns(): Promise<WorkflowRun[]> {
      return opts.failedRuns;
    },
    async listWorkflowEvents(runId: string) {
      return opts.eventsByRun[runId] ?? [];
    },
    async updateWorkflowRun(id, u) {
      updates.push({ id, updates: u });
    },
  };
}

describe('extractWoId', () => {
  test('reads WO_ID= assignment', () => {
    expect(extractWoId('WO_ID=WO-HARNESS-FOO-01\nhello')).toBe('WO-HARNESS-FOO-01');
  });

  test('reads bare WO token from free text', () => {
    expect(extractWoId('Execute WO-SHOPOPS-PULLLIST-EXPORT-01')).toBe(
      'WO-SHOPOPS-PULLLIST-EXPORT-01'
    );
  });

  test('returns null when absent', () => {
    expect(extractWoId('no work order here')).toBeNull();
  });
});

describe('hasValidatorRejectionSignal', () => {
  test('detects FALLBACK_FLIP_DECLINED', () => {
    expect(
      hasValidatorRejectionSignal([
        {
          event_type: 'node_completed',
          step_name: 'flip-notion-on-failure',
          data: {
            output:
              'FALLBACK_FLIP_DECLINED: validator verdict not satisfied; real failure; leaving issue as-is.',
          },
        },
      ])
    ).toBe(true);
  });

  test('detects needs_revision verdict class', () => {
    expect(
      hasValidatorRejectionSignal([
        {
          event_type: 'node_completed',
          step_name: 'war-council-validator',
          data: { output: 'verdict: needs_revision -- money path mutated' },
        },
      ])
    ).toBe(true);
  });

  test('returns false for a genuine breakage (no rejection phrase)', () => {
    expect(
      hasValidatorRejectionSignal([
        {
          event_type: 'node_failed',
          step_name: 'implement',
          data: { error: 'TypeError: cannot read property of undefined at line 42' },
        },
      ])
    ).toBe(false);
  });

  test('returns false for empty events', () => {
    expect(hasValidatorRejectionSignal([])).toBe(false);
  });
});

describe('linkEscalatedPredecessor', () => {
  const WO = 'WO-HARNESS-ESCALATED-RUN-STATUS-01';
  const priorMsg = `WO_ID=${WO}\nbuild the thing`;

  test('1: rejection-signal prior becomes escalated on same-WO successor', async () => {
    const store = makeStore({
      failedRuns: [makeRun({ id: 'prior-1', user_message: priorMsg })],
      eventsByRun: {
        'prior-1': [
          {
            event_type: 'node_completed',
            step_name: 'war-council-validator',
            data: {
              output:
                'needs_revision: money path incorrect; do not flip.\nFALLBACK_FLIP_DECLINED would fire.',
            },
          },
          {
            event_type: 'node_completed',
            step_name: 'flip-notion-on-failure',
            data: {
              output:
                'FALLBACK_FLIP_DECLINED: validator verdict not satisfied; real failure; leaving issue as-is.',
            },
          },
        ],
      },
    });

    const result = await linkEscalatedPredecessor(`WO_ID=${WO}\nrefire on codex`, store);
    expect(result.woId).toBe(WO);
    expect(result.escalatedRunIds).toEqual(['prior-1']);
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].id).toBe('prior-1');
    expect(store.updates[0].updates.status).toBe('escalated');
    // Packet must include the findings marker
    expect(result.packet).toContain(ESCALATION_FINDINGS_MARKER);
    expect(result.packet).toContain('needs_revision');
  });

  test('2: genuine failure without rejection signal stays failed (no packet)', async () => {
    const store = makeStore({
      failedRuns: [makeRun({ id: 'prior-break', user_message: priorMsg })],
      eventsByRun: {
        'prior-break': [
          {
            event_type: 'node_failed',
            step_name: 'implement',
            data: { error: 'spawn EACCES /usr/bin/git' },
          },
        ],
      },
    });

    const result = await linkEscalatedPredecessor(`WO_ID=${WO}\nrefire`, store);
    expect(result.escalatedRunIds).toEqual([]);
    expect(store.updates).toHaveLength(0);
    expect(result.packet).toBe('');
  });

  test('4: different WO_ID does not touch prior', async () => {
    const store = makeStore({
      failedRuns: [makeRun({ id: 'prior-other', user_message: 'WO_ID=WO-OTHER-01\nbuild' })],
      eventsByRun: {
        'prior-other': [
          {
            event_type: 'node_completed',
            step_name: 'flip-notion-on-failure',
            data: { output: 'FALLBACK_FLIP_DECLINED: validator verdict not satisfied' },
          },
        ],
      },
    });

    const result = await linkEscalatedPredecessor(`WO_ID=${WO}\nrefire`, store);
    expect(result.escalatedRunIds).toEqual([]);
    expect(store.updates).toHaveLength(0);
  });

  test('5: prepareDispatchWithEscalation prepends packet only for rejection priors', async () => {
    const store = makeStore({
      failedRuns: [makeRun({ id: 'p1', user_message: priorMsg })],
      eventsByRun: {
        p1: [
          {
            event_type: 'node_completed',
            step_name: 'war-council-validator',
            data: { output: 'needs_revision -- schema mismatch at payments.ts' },
          },
        ],
      },
    });

    const prepared = await prepareDispatchWithEscalation(`WO_ID=${WO}\noriginal prompt`, store);
    expect(prepared.link.escalatedRunIds).toEqual(['p1']);
    expect(prepared.userMessage.startsWith('=== ESCALATION PACKET')).toBe(true);
    expect(prepared.userMessage).toContain(ESCALATION_FINDINGS_MARKER);
    expect(prepared.userMessage).toContain('original prompt');
  });

  test('no WO_ID in message => no-op', async () => {
    const store = makeStore({ failedRuns: [], eventsByRun: {} });
    const result = await linkEscalatedPredecessor('just chatting', store);
    expect(result.escalatedRunIds).toEqual([]);
    expect(result.woId).toBeNull();
  });
});
