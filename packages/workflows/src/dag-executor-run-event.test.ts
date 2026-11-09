import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import * as git from '@archon/git';
import { executeDagWorkflow } from './dag-executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas';

test('bash execution persists only allowlisted events, and never aborts on bad lines or store errors', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.run-event-test-'));
  const event = {
    event_type: 'duplicate_pr_suppressed',
    existing_pr: 7,
    kind: 'fallback',
    salvage_branch: 'salvage/fixture',
  };
  const output = [
    'normal output',
    `BDC_RUN_EVENT ${JSON.stringify(event)}`,
    'BDC_RUN_EVENT {"event_type":"node_completed","passed":true}',
    'BDC_RUN_EVENT {broken',
    'BDC_RUN_EVENT null',
    'BDC_RUN_EVENT []',
  ].join('\n');
  const exec = spyOn(git, 'execFileAsync').mockImplementation(async (command: string) => {
    expect(command).toBe('bash');
    return { stdout: output, stderr: '' };
  });
  try {
    for (const storeFails of [false, true]) {
      const events: {
        event_type: string;
        step_name?: string | null;
        data?: unknown;
        workflow_run_id: string;
      }[] = [];
      const createWorkflowEvent = mock(async (value: (typeof events)[number]) => {
        events.push(value);
        if (storeFails && value.event_type === 'duplicate_pr_suppressed')
          throw new Error('fixture store unavailable');
      });
      // Only persistence and lifecycle methods are needed by a deterministic bash DAG.
      const store = new Proxy(
        { createWorkflowEvent },
        {
          get(target, key) {
            if (key === 'createWorkflowEvent') return target.createWorkflowEvent;
            if (key === 'getWorkflowRunStatus') return async () => 'running';
            if (key === 'getCodebaseEnvVars') return async () => ({});
            if (key === 'listWorkflowEvents') return async () => [];
            return async () => null;
          },
        }
      ) as unknown as IWorkflowStore;
      const config: WorkflowConfig = {
        assistant: 'claude',
        assistants: { claude: {}, codex: {} },
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      };
      const deps: WorkflowDeps = {
        store,
        getAgentProvider: () => {
          throw new Error('no AI expected');
        },
        loadConfig: async () => config,
      };
      const platform: IWorkflowPlatform = {
        sendMessage: async () => {},
        getStreamingMode: () => 'batch',
        getPlatformType: () => 'test',
      };
      const run: WorkflowRun = {
        id: 'event-fixture',
        workflow_name: 'event-test',
        conversation_id: 'fixture',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running',
        user_message: '',
        metadata: {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: dir,
      };
      await executeDagWorkflow(
        deps,
        platform,
        'fixture',
        dir,
        { name: 'event-test', nodes: [{ id: 'salvage-fixture', bash: 'echo fixture' }] },
        run,
        'claude',
        undefined,
        join(dir, 'artifacts'),
        join(dir, 'logs'),
        'dev',
        'docs',
        config
      );
      const emitted = events.filter(value => value.event_type === 'duplicate_pr_suppressed');
      expect(emitted).toEqual([
        {
          workflow_run_id: run.id,
          event_type: 'duplicate_pr_suppressed',
          step_name: 'salvage-fixture',
          data: event,
        },
      ]);
      expect(events.filter(value => value.event_type === 'node_completed')).toHaveLength(1);
      expect(events.some(value => value.event_type === 'node_failed')).toBe(false);
    }
  } finally {
    exec.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
