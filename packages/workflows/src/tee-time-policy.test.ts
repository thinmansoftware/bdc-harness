import { describe, test, expect, mock } from 'bun:test';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers';
import { TEE_TIME_REPOSITORY } from '@archon/paths/tee-time-policy';
import { BUNDLED_WORKFLOWS } from './defaults/bundled-defaults';
import { parseWorkflow } from './loader';
import {
  guardTeeTimeProviders,
  resolveRestrictedRun,
  assertRestrictedResume,
  assertRestrictedAuthority,
} from './tee-time-policy';
import type { WorkflowDeps } from './deps';
import type { WorkflowRun } from './schemas';

registerBuiltinProviders();
registerCommunityProviders();
const parsed = parseWorkflow(
  BUNDLED_WORKFLOWS['bdc-teetime-foundation'],
  'bdc-teetime-foundation.yaml'
);
if (!parsed.workflow) throw new Error(JSON.stringify(parsed.error));
const workflow = parsed.workflow;
const codebase = {
  id: 'registered',
  name: TEE_TIME_REPOSITORY,
  repository_url: `https://github.com/${TEE_TIME_REPOSITORY}.git`,
  default_cwd: '/test',
};

function fixture(error?: string) {
  const query = mock(async function* () {
    if (error) throw new Error(error);
    yield { type: 'assistant' as const, content: 'verified' };
  });
  const factory = mock(() => ({
    getType: () => 'test',
    getCapabilities: () => ({}),
    sendQuery: query,
  }));
  const deps = {
    store: { getCodebase: async () => codebase },
    getAgentProvider: factory,
  } as unknown as WorkflowDeps;
  return { deps, query, factory };
}

describe('restricted workflow boundaries', () => {
  test.each([
    null,
    { woId: 'WO-OTHER-01' },
    { woId: 'WO-TEETIME-FOUNDATION-01', runId: 'other' },
    {
      woId: 'WO-TEETIME-FOUNDATION-01',
      runId: 'run',
      workflowName: workflow.name,
      codebaseId: 'other',
    },
    {
      woId: 'WO-TEETIME-FOUNDATION-01',
      runId: 'run',
      workflowName: workflow.name,
      codebaseId: 'registered',
      worktreePath: '/wrong',
    },
  ])(
    'rejects absent or mismatched persisted authority before provider invocation: %j',
    async authority => {
      const { deps, factory } = fixture();
      deps.store.getRunAuthority = mock(async () => authority) as typeof deps.store.getRunAuthority;
      const policy = { woId: 'WO-TEETIME-FOUNDATION-01' };
      const run = { id: 'run', codebase_id: 'registered' } as WorkflowRun;
      await expect(
        assertRestrictedAuthority(deps, run, policy, workflow.name, '/test', '/artifacts')
      ).rejects.toThrow('policy_blocked');
      expect(factory).toHaveBeenCalledTimes(0);
    }
  );
  test.each(['', 'WO-TEETIME-DEMO-01', 'WO-TEETIME-FOUNDATION-01 WO-OTHER-01'])(
    'rejects ambiguous or non-foundation WO: %s',
    async message => {
      const { deps, factory } = fixture();
      await expect(resolveRestrictedRun(deps, 'registered', message, workflow)).rejects.toThrow(
        'WO identity'
      );
      expect(factory).toHaveBeenCalledTimes(0);
    }
  );
  test('rejects factory before construction, including failover IDs', () => {
    const { deps, factory } = fixture();
    for (const id of ['claude', 'codex', 'fable', 'opr', 'glm']) {
      expect(() => guardTeeTimeProviders(deps).getAgentProvider(id)).toThrow('policy_blocked');
    }
    expect(factory).toHaveBeenCalledTimes(0);
  });
  test('allowed query preserves interface and invokes exactly once', async () => {
    const { deps, query } = fixture();
    const client = guardTeeTimeProviders(deps).getAgentProvider('codex-native-strict');
    for await (const chunk of client.sendQuery('test', '/test', undefined, {
      model: 'gpt-5.6-sol',
    }))
      expect(chunk.type).toBe('assistant');
    expect(query).toHaveBeenCalledTimes(1);
    expect(client.getType()).toBe('test');
  });
  test.each(['auth', 'quota', 'crash', 'timeout', 'review rejected'])(
    'propagates %s without constructing a fallback',
    async error => {
      const { deps, factory, query } = fixture(error);
      const client = guardTeeTimeProviders(deps).getAgentProvider('codex-native-strict');
      const run = async () => {
        for await (const _chunk of client.sendQuery('test', '/test', undefined, {
          model: 'gpt-5.6-sol',
        })) {
          /* drain */
        }
      };
      await expect(run()).rejects.toThrow(error);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith('codex-native-strict');
      expect(query).toHaveBeenCalledTimes(1);
    }
  );
  test('missing model and nested/fallback overrides never reach query', async () => {
    const { deps, query } = fixture();
    const client = guardTeeTimeProviders(deps).getAgentProvider('cursor');
    for (const options of [
      {},
      { model: 'claude' },
      { model: 'grok-4.7-high', fallbackModel: 'claude' },
      { model: 'grok-4.7-high', nodeConfig: { agents: {} } },
    ]) {
      await expect(
        (async () => {
          for await (const _chunk of client.sendQuery('test', '/test', undefined, options)) {
            /* drain */
          }
        })()
      ).rejects.toThrow('policy_blocked');
    }
    expect(query).toHaveBeenCalledTimes(0);
  });
  test('reviewed definition accepted and same-name shell drift rejected', async () => {
    const { deps } = fixture();
    expect(
      await resolveRestrictedRun(deps, 'registered', 'WO-TEETIME-FOUNDATION-01', workflow)
    ).not.toBeNull();
    await expect(
      resolveRestrictedRun(deps, 'registered', 'WO-TEETIME-FOUNDATION-01', {
        ...workflow,
        description: 'changed',
      })
    ).rejects.toThrow('definition');
  });
  test('every resumed run needs exact policy and original codebase', async () => {
    const { deps } = fixture();
    const policy = await resolveRestrictedRun(
      deps,
      'registered',
      'WO-TEETIME-FOUNDATION-01',
      workflow
    );
    for (const status of ['failed', 'paused', 'waiting_provider']) {
      const run = { codebase_id: 'registered', status, metadata: {} } as WorkflowRun;
      expect(() => assertRestrictedResume(run, policy)).toThrow('persisted');
      run.metadata.execution_policy = policy;
      expect(() => assertRestrictedResume(run, policy)).not.toThrow();
      expect(() => assertRestrictedResume({ ...run, codebase_id: 'other' }, policy)).toThrow(
        'codebase'
      );
      expect(() => assertRestrictedResume(run, null)).toThrow('without its policy');
    }
  });
});
