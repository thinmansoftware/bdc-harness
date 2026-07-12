import { describe, expect, mock, test } from 'bun:test';
import type { IAgentProvider, MessageChunk } from '@archon/providers/types';
import { runFireTimeProbe, type FireTimeProbeStore } from './fire-time-probe';
import type { WorkflowConfig } from '../deps';
import type { WorkflowDefinition } from '../schemas';

async function* ok(): AsyncGenerator<MessageChunk> {
  yield { type: 'assistant', content: 'OK' };
}

function fakeProvider(sendQuery: IAgentProvider['sendQuery']): IAgentProvider {
  return {
    sendQuery,
    getType: () => 'codex-opr',
    getCapabilities: () => ({
      execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    }),
  };
}

const workflow: WorkflowDefinition = {
  name: 'test-workflow',
  description: 'test',
  provider: 'codex-opr',
  model: 'qwen/qwen3-coder',
  nodes: [{ id: 'plan', type: 'prompt', prompt: 'plan' }],
};

const config: WorkflowConfig = {
  assistant: 'codex-opr',
  commands: {},
  assistants: {
    'codex-opr': { model: 'qwen/qwen3-coder' },
    claude: {},
    codex: {},
  },
};

describe('runFireTimeProbe', () => {
  test('structural rejection blocks and writes known bad binding', async () => {
    const sendQuery = mock(() => {
      throw Object.assign(
        new Error('The qwen/qwen3-coder model is not supported when using Codex with a ChatGPT account.'),
        { status: 400 }
      );
    });
    const upsert = mock(async () => ({}));
    const alert = mock(async () => {});
    const decision = await runFireTimeProbe({
      workflow,
      config,
      workflowProvider: 'codex-opr',
      workflowModel: 'qwen/qwen3-coder',
      cwd: '/tmp',
      getAgentProvider: () => fakeProvider(sendQuery),
      store: { upsertKnownBadBinding: upsert },
      alert,
      retryDelayMs: 0,
    });
    expect(decision.status).toBe('block');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'red' }));
  });

  test('classified transient retries once and proceeds with warn', async () => {
    const sendQuery = mock(() => {
      throw Object.assign(new Error('429 rate limit'), { status: 429 });
    });
    const upsert = mock(async () => ({}));
    const alert = mock(async () => {});
    const decision = await runFireTimeProbe({
      workflow,
      config,
      workflowProvider: 'codex-opr',
      workflowModel: 'qwen/qwen3-coder',
      cwd: '/tmp',
      getAgentProvider: () => fakeProvider(sendQuery),
      store: { upsertKnownBadBinding: upsert },
      alert,
      retryDelayMs: 0,
    });
    expect(decision.status).toBe('warn');
    expect(sendQuery).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  test('unknown 400 retries once and proceeds with warn as its own case', async () => {
    const sendQuery = mock(() => {
      throw Object.assign(new Error('bad request: malformed payload'), { status: 400 });
    });
    const upsert = mock(async () => ({}));
    const alert = mock(async () => {});
    const decision = await runFireTimeProbe({
      workflow,
      config,
      workflowProvider: 'codex-opr',
      workflowModel: 'qwen/qwen3-coder',
      cwd: '/tmp',
      getAgentProvider: () => fakeProvider(sendQuery),
      store: { upsertKnownBadBinding: upsert },
      alert,
      retryDelayMs: 0,
    });
    expect(decision.status).toBe('warn');
    expect(decision.failures).toHaveLength(0);
    expect(sendQuery).toHaveBeenCalledTimes(2);
    expect(upsert).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  test('active known bad binding can clear on successful fire reprobe', async () => {
    const sendQuery = mock(() => ok());
    const store: FireTimeProbeStore = {
      getActiveKnownBadBinding: mock(async () => ({
        binding_key: 'known',
        error_body_excerpt: 'old',
        hit_count: 1,
      })),
      clearKnownBadBinding: mock(async () => ({})),
    };
    const decision = await runFireTimeProbe({
      workflow,
      config,
      workflowProvider: 'codex-opr',
      workflowModel: 'qwen/qwen3-coder',
      cwd: '/tmp',
      getAgentProvider: () => fakeProvider(sendQuery),
      store,
      retryDelayMs: 0,
    });
    expect(decision.status).toBe('pass');
    expect(store.clearKnownBadBinding).toHaveBeenCalledWith(expect.any(String), 'fire_reprobe');
  });
});
