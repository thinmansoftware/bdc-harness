import { describe, expect, test } from 'bun:test';
import { CursorGrokDispatchProvider } from './provider';
import type { ProviderExecutionContext } from '../types';

const sha = 'a'.repeat(40);

function context(): ProviderExecutionContext {
  return {
    workflowRunId: 'run-1',
    nodeId: 'plan',
    providerAttemptId: 'attempt-1',
    providerAttemptNumber: 1,
    executionMode: 'read_only',
    artifactsDir: 'C:/artifacts/run-1',
    artifactContract: {
      inputs: [],
      outputs: [],
      maxFileBytes: 1_048_576,
      maxTotalBytes: 4_194_304,
    },
  };
}

describe('CursorGrokDispatchProvider', () => {
  test('fails closed when the fenced execution context is absent', async () => {
    const provider = new CursorGrokDispatchProvider({
      serverUrl: 'http://archon.test',
      operatorToken: 'test-token',
    });
    const consume = async () => {
      for await (const _chunk of provider.sendQuery('plan', 'C:/repo')) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow('executionContext');
  });

  test('posts exact Cursor model work and returns the fenced result', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === 'POST') {
        return Response.json({ id: 'message-1', status: 'queued' });
      }
      return Response.json({
        id: 'message-1',
        task_type: 'run_work',
        status: 'done',
        result_body: JSON.stringify({
          version: 'v1',
          worker_id: 'cursor-1',
          fencing_token: 2,
          outcome: 'succeeded',
          requested_sha: sha,
          resulting_sha: sha,
          output: 'Plan complete.',
          model: 'cursor-grok-4.5-high',
          artifacts: { outputs: [] },
        }),
      });
    };
    const provider = new CursorGrokDispatchProvider({
      serverUrl: 'http://archon.test/',
      operatorToken: 'test-token',
      fetchFn,
      pollIntervalMs: 0,
      runGit: async args => {
        if (args.join(' ') === 'remote get-url origin')
          return 'https://github.com/example/repo.git';
        if (args.join(' ') === 'rev-parse HEAD') return sha;
        if (args.join(' ') === 'branch --show-current') return 'cauldron/run-1';
        if (args.join(' ') === 'status --porcelain') return '';
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    });

    const chunks = [];
    for await (const chunk of provider.sendQuery('Create a plan.', 'C:/repo', undefined, {
      model: 'cursor-grok-4.5-high',
      executionContext: context(),
    })) {
      chunks.push(chunk);
    }

    const posted = JSON.parse(String(requests[0]?.init?.body));
    expect(posted).toMatchObject({
      version: 'v1',
      workflow_run_id: 'run-1',
      node_id: 'plan',
      provider_attempt_id: 'attempt-1',
      execution_mode: 'read_only',
      model: 'cursor-grok-4.5-high',
    });
    expect(requests[0]?.url).toBe('http://archon.test/api/dispatch/work-requests');
    expect(new Headers(requests[0]?.init?.headers).get('x-archon-operator-token')).toBe(
      'test-token'
    );
    expect(chunks).toContainEqual({ type: 'assistant', content: 'Plan complete.' });
  });
});
