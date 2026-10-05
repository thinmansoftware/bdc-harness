import { describe, expect, mock, test } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mockLogger = {
  info: mock(() => undefined),
  warn: mock(() => undefined),
  error: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  fatal: mock(() => undefined),
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: () => ['.archon/commands'],
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { executeDagWorkflow } from './dag-executor';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas/workflow-run';

function workflowRun(id: string): WorkflowRun {
  return {
    id,
    workflow_name: 'canonical-provider',
    conversation_id: 'conv',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'canonical provider test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

function storeCapturingAttempts(): {
  store: IWorkflowStore;
  attempts: Array<Parameters<IWorkflowStore['createProviderAttempt']>[0]>;
} {
  const attempts: Array<Parameters<IWorkflowStore['createProviderAttempt']>[0]> = [];
  const store = {
    createWorkflowRun: mock(() => Promise.resolve(workflowRun('unused'))),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createRunAuthority: mock(() => Promise.resolve('created' as const)),
    getRunAuthority: mock(() => Promise.resolve(null)),
    claimRunLease: mock(() => Promise.resolve(null)),
    heartbeatRunLease: mock(() => Promise.resolve(false)),
    releaseRunLease: mock(() => Promise.resolve(false)),
    createProviderAttempt: mock(async (attempt: (typeof attempts)[number]) => {
      attempts.push(attempt);
      return true;
    }),
    completeProviderAttempt: mock(() => Promise.resolve(true)),
    listProviderAttempts: mock(() => Promise.resolve([])),
    upsertRunOutcome: mock(() => Promise.resolve(false)),
    getRunOutcome: mock(() => Promise.resolve(null)),
    scheduleProviderWait: mock(() => Promise.resolve(false)),
    listDueProviderWaits: mock(() => Promise.resolve([])),
    claimProviderWait: mock(() => Promise.resolve(false)),
    cancelProviderWaits: mock(() => Promise.resolve(0)),
    completeProviderWait: mock(() => Promise.resolve(false)),
    createWorkflowEvent: mock(() => Promise.resolve()),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  } as unknown as IWorkflowStore;
  return { store, attempts };
}

const config: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {}, grok: { model: 'should-not-be-used' } },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

function platform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

describe('provider id canonicalization', () => {
  test('attempt rows record openrouter when YAML or the override says grok', async () => {
    registerBuiltinProviders();
    registerCommunityProviders();
    const cwd = join(tmpdir(), `openrouter-canon-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    const provider = {
      sendQuery: mock(function* () {
        yield { type: 'assistant' as const, content: 'done' };
        yield { type: 'result' as const, sessionId: 's' };
      }),
      getType: () => 'openrouter',
      getCapabilities: () => ({
        execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
        sessionResume: false,
        mcp: false,
        hooks: false,
        skills: false,
        agents: false,
        toolRestrictions: false,
        structuredOutput: true,
        envInjection: true,
        costControl: false,
        effortControl: true,
        thinkingControl: false,
        fallbackModel: false,
        sandbox: false,
      }),
    };
    try {
      const yaml = storeCapturingAttempts();
      await executeDagWorkflow(
        { store: yaml.store, getAgentProvider: () => provider } as unknown as WorkflowDeps,
        platform(),
        'conv-yaml',
        cwd,
        {
          name: 'canon-yaml',
          nodes: [
            {
              id: 'draft',
              prompt: 'Write a note',
              provider: 'grok',
              model: 'deepseek/deepseek-v4.1-flash',
              allowed_tools: [],
            },
          ],
        },
        workflowRun('yaml-run'),
        'claude',
        undefined,
        join(cwd, 'artifacts'),
        join(cwd, 'logs'),
        'main',
        'docs/',
        config
      );
      expect(yaml.attempts).toHaveLength(1);
      expect(yaml.attempts[0]?.provider).toBe('openrouter');
      expect(yaml.attempts[0]?.declaredProvider).toBe('openrouter');
      expect(yaml.attempts[0]?.model).toBe('deepseek/deepseek-v4.1-flash');

      const overridden = storeCapturingAttempts();
      await executeDagWorkflow(
        { store: overridden.store, getAgentProvider: () => provider } as unknown as WorkflowDeps,
        platform(),
        'conv-override',
        cwd,
        {
          name: 'canon-override',
          nodes: [
            {
              id: 'draft',
              prompt: 'Write a note',
              provider: 'claude',
              model: 'sonnet',
              allowed_tools: [],
            },
          ],
        },
        workflowRun('override-run'),
        'claude',
        undefined,
        join(cwd, 'artifacts'),
        join(cwd, 'logs'),
        'main',
        'docs/',
        config,
        undefined,
        undefined,
        undefined,
        { nodes: { draft: { provider: 'grok', model: 'deepseek/deepseek-v4.1-flash' } } }
      );
      expect(overridden.attempts).toHaveLength(1);
      expect(overridden.attempts[0]?.provider).toBe('openrouter');
      expect(overridden.attempts[0]?.declaredProvider).toBe('openrouter');
      expect(overridden.attempts[0]?.model).toBe('deepseek/deepseek-v4.1-flash');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
