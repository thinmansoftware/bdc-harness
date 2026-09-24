import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { rootLogger } from '@archon/paths';
import { executeWorkflow } from '../executor';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '../deps';
import type { IWorkflowStore } from '../store';
import type { WorkflowDefinition, WorkflowRun } from '../schemas';
import type { CreateAuthenticatedMessageData } from '@archon/core/db/dispatch';
import {
  resetSeatUsageCacheForTests,
  setSeatAlertSendForTests,
  setSeatCutoffOverride,
  setSeatUsageReaderForTests,
  unknownSeatReading,
  type SeatReading,
} from './seat-usage';

const prompts: string[] = [];
const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const alerts: CreateAuthenticatedMessageData[] = [];
const origChild = rootLogger.child.bind(rootLogger);

function reading(seat: SeatReading['seat'], windowName: string, used: number): SeatReading {
  return {
    seat,
    limit_source: 'measured',
    windows: [
      {
        name: windowName,
        used_percent: used,
        remaining_percent: 100 - used,
        resets_at: '2026-09-28T00:00:00Z',
        ...(seat === 'codex' ? { window_seconds: 604800 } : {}),
      },
    ],
    seven_day:
      seat === 'cursor'
        ? 'NOT_APPLICABLE'
        : { used_percent: used, remaining_percent: 100 - used, resets_at: '2026-09-28T00:00:00Z' },
    gate_windows: seat === 'claude' ? ['five_hour', 'seven_day'] : ['primary', 'secondary'],
    note: '',
    probed_at: '2026-09-24T00:00:00Z',
    endpoint: 'https://example.invalid',
    limit_reached: false,
  };
}

function makeRun(): WorkflowRun {
  return {
    id: 'run-seat-gate',
    workflow_name: 'seat-gate-wf',
    conversation_id: 'conv-1',
    status: 'pending',
    started_at: new Date().toISOString(),
    metadata: {},
  };
}

function makeStore(): IWorkflowStore & {
  createWorkflowEvent: ReturnType<typeof mock>;
  failWorkflowRun: ReturnType<typeof mock>;
} {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => makeRun()),
    getWorkflowRunStatus: mock(async () => 'pending' as const),
    createWorkflowEvent: mock(async () => {}),
    listWorkflowEvents: mock(async () => []),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    createRunAuthority: mock(async () => 'created' as const),
    getRunAuthority: mock(async () => null),
  } as unknown as IWorkflowStore & {
    createWorkflowEvent: ReturnType<typeof mock>;
    failWorkflowRun: ReturnType<typeof mock>;
  };
}

function provider(): IAgentProvider {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    sendQuery: async function* (prompt: string): AsyncGenerator<MessageChunk> {
      prompts.push(prompt);
      yield { type: 'assistant', content: 'OK' };
    },
  };
}

function workflow(): WorkflowDefinition {
  return {
    name: 'seat-gate-wf',
    description: 'seat gate',
    mutates_checkout: false,
    nodes: [
      { id: 'a', prompt: 'node-claude', provider: 'claude', model: 'sonnet' },
      { id: 'b', prompt: 'node-codex', provider: 'codex', model: 'gpt-5' },
    ],
  };
}

beforeEach(() => {
  prompts.length = 0;
  warnings.length = 0;
  alerts.length = 0;
  clearRegistry();
  registerBuiltinProviders();
  resetSeatUsageCacheForTests();
  setSeatAlertSendForTests(async (_context, data) => {
    alerts.push(data);
    return null;
  });
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  rootLogger.child = ((bindings?: object) => {
    const child = origChild(bindings as never);
    const origWarn = child.warn.bind(child);
    child.warn = ((obj: unknown, msg?: string) => {
      if (typeof msg === 'string') {
        warnings.push({ obj: (obj ?? {}) as Record<string, unknown>, msg });
      }
      return origWarn(obj as never, msg as never);
    }) as typeof child.warn;
    return child;
  }) as typeof rootLogger.child;
});

afterEach(() => {
  rootLogger.child = origChild as typeof rootLogger.child;
  resetSeatUsageCacheForTests();
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  clearRegistry();
});

function eventTypes(store: ReturnType<typeof makeStore>): string[] {
  return store.createWorkflowEvent.mock.calls.map(
    call => (call[0] as { event_type: string }).event_type
  );
}

async function runWorkflow(): Promise<{
  result: Awaited<ReturnType<typeof executeWorkflow>>;
  store: ReturnType<typeof makeStore>;
}> {
  const store = makeStore();
  const cwd = await mkdtemp(join(tmpdir(), 'seat-gate-exec-'));
  const deps = {
    store,
    loadConfig: async (): Promise<WorkflowConfig> =>
      ({
        assistant: 'claude',
        assistants: { claude: { model: 'sonnet' }, codex: { model: 'gpt-5' } },
        commands: { folder: '' },
        baseBranch: 'dev',
      }) as WorkflowConfig,
    getAgentProvider: () => provider(),
  } as unknown as WorkflowDeps;
  const platform = {
    sendMessage: async () => {},
    getPlatformType: () => 'test',
  } as unknown as IWorkflowPlatform;
  const result = await executeWorkflow(
    deps,
    platform,
    'conv-1',
    cwd,
    workflow(),
    'hello',
    'db-conv-1',
    undefined,
    undefined,
    undefined,
    makeRun()
  );
  return { result, store };
}

describe('executor seat gate', () => {
  test('refuses before the first node and names the seat', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 95),
    }));
    setSeatCutoffOverride(90);
    const { result, store } = await runWorkflow();
    expect(result.success).toBe(false);
    expect(result.error).toBe('seat_usage_refused:codex:primary:95:90');
    const events = store.createWorkflowEvent.mock.calls.map(
      call =>
        call[0] as {
          event_type: string;
          data: { reason?: string };
        }
    );
    expect(
      events.some(
        event =>
          event.event_type === 'dag_workflow_failed' && event.data.reason === 'seat_usage_refused'
      )
    ).toBe(true);
    expect(store.failWorkflowRun).toHaveBeenCalled();
    expect(
      warnings.some(
        entry => entry.msg === 'workflow.seat_usage_refused' && entry.obj.seat === 'codex'
      )
    ).toBe(true);
    expect(prompts.filter(prompt => prompt !== 'Reply with exactly: OK')).toEqual([]);
  });

  test('default cutoff 90 refuses a seat at 91 and names it', async () => {
    let reads = 0;
    setSeatUsageReaderForTests(async () => {
      reads += 1;
      return {
        claude: reading('claude', 'seven_day', 91),
        codex: reading('codex', 'primary', 10),
      };
    });
    const { result, store } = await runWorkflow();
    expect(reads).toBe(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe('seat_usage_refused:claude:seven_day:91:90');
    expect(eventTypes(store)).toContain('dag_workflow_failed');
    expect(eventTypes(store)).not.toContain('workflow_started');
    expect(store.failWorkflowRun).toHaveBeenCalledWith(
      'run-seat-gate',
      'seat_usage_refused:claude:seven_day:91:90'
    );
    expect(
      warnings.some(
        entry =>
          entry.msg === 'workflow.seat_usage_refused' &&
          entry.obj.seat === 'claude' &&
          entry.obj.cutoffPercent === 90
      )
    ).toBe(true);
    expect(prompts.filter(prompt => prompt !== 'Reply with exactly: OK')).toEqual([]);
    expect(alerts).toHaveLength(0);
  });

  test('UNKNOWN proceeds and enqueues exactly one operator alert per seat per hour', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: unknownSeatReading('claude', 'Claude limit probe rejected (HTTP 401)', 401),
      codex: reading('codex', 'primary', 10),
    }));
    const first = await runWorkflow();
    expect(first.result.error ?? '').not.toContain('seat_usage_refused');
    expect(eventTypes(first.store)).toContain('workflow_started');
    expect(
      warnings.some(
        entry =>
          entry.msg === 'workflow.seat_usage_unknown' &&
          entry.obj.seat === 'claude' &&
          entry.obj.note === 'Claude limit probe rejected (HTTP 401)'
      )
    ).toBe(true);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert?.recipient).toBe('operator');
    expect(alert?.task_type).toBe('agent_message');
    expect(alert?.idempotency_key).toMatch(
      /^fuelglass-seat-unknown:claude:\d{4}-\d{2}-\d{2}T\d{2}$/
    );
    expect(alert?.body.split('\n')[0]).toBe('Fuelglass seat gate could not measure seat claude');
    expect(alert?.body).toContain('Claude limit probe rejected (HTTP 401)');
    expect(alert?.body).toContain('run-seat-gate');

    // A second UNKNOWN in the same hour: the run still proceeds, no new alert.
    const second = await runWorkflow();
    expect(eventTypes(second.store)).toContain('workflow_started');
    expect(
      warnings.filter(
        entry => entry.msg === 'workflow.seat_usage_unknown' && entry.obj.seat === 'claude'
      )
    ).toHaveLength(2);
    expect(alerts).toHaveLength(1);
  });

  test('a hanging seat read falls back to UNKNOWN at the 12s ceiling', async () => {
    setSeatUsageReaderForTests(() => new Promise(() => {}));
    setSeatCutoffOverride(90);
    const started = Date.now();
    const { result, store } = await runWorkflow();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(16_000);
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const events = store.createWorkflowEvent.mock.calls.map(
      call =>
        call[0] as {
          event_type: string;
        }
    );
    expect(events.some(event => event.event_type === 'workflow_started')).toBe(true);
    expect(
      warnings.some(
        entry =>
          entry.msg === 'workflow.seat_usage_unknown' && entry.obj.note === 'seat read timed out'
      )
    ).toBe(true);
  }, 20_000);

  test('a thrown seat read is labeled with the error, not a timeout', async () => {
    setSeatUsageReaderForTests(async () => {
      throw new Error('reader exploded');
    });
    setSeatCutoffOverride(90);
    const { result, store } = await runWorkflow();
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const events = store.createWorkflowEvent.mock.calls.map(
      call =>
        call[0] as {
          event_type: string;
        }
    );
    expect(events.some(event => event.event_type === 'workflow_started')).toBe(true);
    expect(
      warnings.some(
        entry => entry.msg === 'workflow.seat_usage_unknown' && entry.obj.note === 'reader exploded'
      )
    ).toBe(true);
    // Both bound seats are unmeasured: one operator alert each.
    expect(alerts.map(alert => alert.idempotency_key.split(':')[1]).sort()).toEqual([
      'claude',
      'codex',
    ]);
    expect(alerts.every(alert => alert.body.includes('reader exploded'))).toBe(true);
    expect(
      warnings.some(
        entry =>
          entry.msg === 'workflow.seat_usage_unknown' && entry.obj.note === 'seat read timed out'
      )
    ).toBe(false);
  });

  test('a seat at 89 proceeds past the default cutoff 90', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 89),
    }));
    setSeatCutoffOverride(null);
    const { result, store } = await runWorkflow();
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    expect(eventTypes(store)).toContain('workflow_started');
    expect(warnings.some(entry => entry.msg === 'workflow.seat_usage_refused')).toBe(false);
    expect(alerts).toHaveLength(0);
  });
});
