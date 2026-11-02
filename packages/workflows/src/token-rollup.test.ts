import { describe, expect, it, mock } from 'bun:test';
import { aggregateRunTokenTotals, emitRunTokenTotals } from './token-rollup';
import type { IWorkflowStore, WorkflowEventRecord } from './store';

function event(
  event_type: string,
  data: Record<string, unknown>,
  id = `${event_type}-1`
): WorkflowEventRecord {
  return {
    id,
    workflow_run_id: 'run-1',
    event_type,
    step_index: null,
    step_name: 'node-1',
    data,
    created_at: '2026-07-02T00:00:00.000Z',
  };
}

function makeStore(events: WorkflowEventRecord[]): IWorkflowStore {
  return {
    createWorkflowRun: mock(async () => undefined as never),
    getWorkflowRun: mock(async () => null),
    getActiveWorkflowRunByPath: mock(async () => null),
    findResumableRun: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    resumeWorkflowRun: mock(async () => undefined as never),
    updateWorkflowRun: mock(async () => {}),
    updateWorkflowActivity: mock(async () => {}),
    getWorkflowRunStatus: mock(async () => 'running' as const),
    completeWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    pauseWorkflowRun: mock(async () => {}),
    cancelWorkflowRun: mock(async () => {}),
    createWorkflowEvent: mock(async () => {}),
    listWorkflowEvents: mock(async () => events),
    getCompletedDagNodeOutputs: mock(async () => new Map<string, string>()),
    getCodebaseEnvVars: mock(async () => ({})),
    getCodebase: mock(async () => null),
  };
}

describe('aggregateRunTokenTotals', () => {
  it('sums Claude model_usage by model', () => {
    const totals = aggregateRunTokenTotals([
      event('node_completed', {
        model_usage: {
          'claude-sonnet': { input_tokens: 100, output_tokens: 50 },
        },
      }),
      event(
        'node_failed',
        {
          model_usage: {
            'claude-sonnet': { input_tokens: 30, output_tokens: 20 },
          },
        },
        'failed-1'
      ),
    ]);

    expect(totals).toEqual({
      by_model: { 'claude-sonnet': { input_tokens: 130, output_tokens: 70 } },
      total_input_tokens: 130,
      total_output_tokens: 70,
    });
  });

  it('falls back to normalized tokens for non-Claude providers', () => {
    const totals = aggregateRunTokenTotals([
      event('node_completed', {
        requested_model_id: 'openrouter/anthropic/claude',
        tokens: { input: 10, output: 5, total: 15 },
      }),
      event('node_completed', {
        declared_model_id: 'gpt-5.4-codex',
        tokens: { input: 7, output: 3 },
      }),
    ]);

    expect(totals).toEqual({
      by_model: {
        'openrouter/anthropic/claude': { input_tokens: 10, output_tokens: 5 },
        'gpt-5.4-codex': { input_tokens: 7, output_tokens: 3 },
      },
      total_input_tokens: 17,
      total_output_tokens: 8,
    });
  });

  it('marks incomplete when usage-eligible node events have no usage', () => {
    const totals = aggregateRunTokenTotals([
      event('node_completed', {
        requested_model_id: 'model-without-usage',
        entry_rung: 'frontier',
        node_output: 'done',
      }),
    ]);

    expect(totals).toEqual({
      by_model: {},
      total_input_tokens: 0,
      total_output_tokens: 0,
      incomplete: true,
    });
  });
});

describe('emitRunTokenTotals', () => {
  it('writes exactly one run_token_totals event', async () => {
    const store = makeStore([
      event('node_completed', {
        requested_model_id: 'model-a',
        tokens: { input: 2, output: 3 },
      }),
    ]);

    await emitRunTokenTotals(store, 'run-1');

    expect(store.createWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: 'run-1',
      event_type: 'run_token_totals',
      data: {
        by_model: { 'model-a': { input_tokens: 2, output_tokens: 3 } },
        total_input_tokens: 2,
        total_output_tokens: 3,
      },
    });
  });

  it('skips when a rollup already exists', async () => {
    const store = makeStore([event('run_token_totals', { total_input_tokens: 1 })]);

    await emitRunTokenTotals(store, 'run-1');

    expect(store.createWorkflowEvent).not.toHaveBeenCalled();
  });

  it('never throws when event reads fail', async () => {
    const store = makeStore([]);
    (store.listWorkflowEvents as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('db unavailable')
    );

    await expect(emitRunTokenTotals(store, 'run-1')).resolves.toBeUndefined();
    expect(store.createWorkflowEvent).not.toHaveBeenCalled();
  });
});
