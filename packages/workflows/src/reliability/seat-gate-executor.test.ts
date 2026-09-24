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
import {
  resetSeatUsageCacheForTests,
  setSeatCutoffOverride,
  setSeatUsageReaderForTests,
  type SeatReading,
} from './seat-usage';

const prompts: string[] = [];
const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
const origChild = rootLogger.child.bind(rootLogger);

function reading(
  seat: SeatReading['seat'],
  windowName: string,
  used: number
): SeatReading {
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
  clearRegistry();
  registerBuiltinProviders();
  resetSeatUsageCacheForTests();
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  delete process.env.FUELGLASS_SEAT_GATE;
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
  delete process.env.FUELGLASS_SEAT_GATE;
  clearRegistry();
});

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
    const events = store.createWorkflowEvent.mock.calls.map(call => call[0] as {
      event_type: string;
      data: { reason?: string };
    });
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

  test('proceeds past the gate when usage is under the default cutoff', async () => {
    setSeatUsageReaderForTests(async () => ({
      claude: reading('claude', 'seven_day', 10),
      codex: reading('codex', 'primary', 95),
    }));
    setSeatCutoffOverride(null);
    const { result, store } = await runWorkflow();
    expect(result.error ?? '').not.toContain('seat_usage_refused');
    const events = store.createWorkflowEvent.mock.calls.map(call => call[0] as {
      event_type: string;
    });
    expect(events.some(event => event.event_type === 'workflow_started')).toBe(true);
  });
});
