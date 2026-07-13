import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { runFireTimeProbe } from './fire-time-probe';
import type { WorkflowConfig } from '../deps';
import type { WorkflowDefinition } from '../schemas';

const upsert = mock(async () => ({}));
const clear = mock(async () => ({}));
const find = mock(async () => null);
const increment = mock(async () => ({}));

mock.module('@archon/core/db/known-bad-bindings', () => ({
  upsertKnownBadBinding: upsert,
  clearKnownBadBinding: clear,
  findActiveByBindingKey: find,
  incrementKnownBadBindingHit: increment,
}));

// Use the REAL provider registry (register builtins, clear after) rather than
// mock.module('@archon/providers') -- bun module mocks are process-global and
// leak into every later test file in the same run, which broke the
// capability-audit tests in CI (isRegisteredProvider stubbed always-true).
// Matches the hygiene pattern in workflow-capability-audit.test.ts.
beforeEach(() => {
  clearRegistry();
  registerBuiltinProviders();
});
afterEach(clearRegistry);

const workflow: WorkflowDefinition = {
  name: 'probe-test',
  description: 'probe test',
  nodes: [{ id: 'plan', prompt: 'hello', provider: 'codex', model: 'qwen/qwen3-coder' }],
};

const config: WorkflowConfig = {
  assistant: 'codex',
  commands: {},
  assistants: { claude: {}, codex: { model: 'qwen/qwen3-coder' } },
};

function provider(errors: readonly Error[]): IAgentProvider {
  let index = 0;
  return {
    getType: () => 'codex',
    getCapabilities: () => ({}) as ReturnType<IAgentProvider['getCapabilities']>,
    sendQuery: async function* (): AsyncGenerator<MessageChunk> {
      const error = errors[index++];
      if (error) throw error;
      yield { type: 'assistant', content: 'OK' };
    },
  };
}

async function run(errors: readonly Error[]) {
  return runFireTimeProbe(
    { getAgentProvider: () => provider(errors), sleep: async () => {} },
    {
      workflow,
      workflowProvider: 'codex',
      workflowModel: 'qwen/qwen3-coder',
      config,
      cwd: '/tmp',
      source: 'fire_probe',
    }
  );
}

describe('fire-time probe', () => {
  beforeEach(() => {
    upsert.mockClear();
    find.mockClear();
    clear.mockClear();
    increment.mockClear();
  });

  test('structural 400 blocks the fire and writes known-bad', async () => {
    const err = Object.assign(new Error('model is not supported'), { httpStatus: 400 });
    const decision = await run([err, err]);
    expect(decision.blocked).toBe(true);
    expect(upsert).toHaveBeenCalled();
  });

  test('transient 400 retries once and does not block', async () => {
    const err = Object.assign(new Error('overloaded'), { httpStatus: 400 });
    const decision = await run([err, err]);
    expect(decision.blocked).toBe(false);
    expect(decision.warnings).toHaveLength(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('unknown 400 retries through its distinct fail-open path', async () => {
    const err = Object.assign(new Error('bad request'), { httpStatus: 400 });
    const decision = await run([err]);
    expect(decision.blocked).toBe(false);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]?.ok).toBe(false);
  });
});
