import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CURSOR_GROK_MODEL,
  executeRunWork,
  parseRunWorkRequest,
  type RunWorkConfig,
  type RunWorkRequest,
} from './run-work';

const sha = 'a'.repeat(40);
const remote = 'https://github.com/example/repo.git';

function config(worktreeRoot = 'C:/cursor-worker'): RunWorkConfig {
  return {
    enabled: true,
    cursor_binary: 'cursor-agent',
    repository_allowlist: [remote],
    worktree_root: worktreeRoot,
    wall_clock_ms: 60_000,
  };
}

function request(): RunWorkRequest {
  return {
    version: 'v1',
    correlation_id: 'run-1:plan',
    idempotency_key: 'run-1:plan:attempt-1',
    workflow_run_id: 'run-1',
    node_id: 'plan',
    provider_attempt_id: 'attempt-1',
    provider_attempt_number: 1,
    execution_mode: 'read_only',
    repository: { remote_url: remote, branch: 'cauldron/run-1', requested_sha: sha },
    model: CURSOR_GROK_MODEL,
    prompt: 'Read C:/server/artifacts/run-1 if needed.',
    artifacts: {
      source_root: 'C:/server/artifacts/run-1',
      inputs: [],
      outputs: [],
      max_file_bytes: 1_048_576,
      max_total_bytes: 4_194_304,
    },
  };
}

describe('run_work desktop worker', () => {
  test('rejects a repository outside the explicit allowlist', () => {
    const body = JSON.stringify({
      ...request(),
      repository: { ...request().repository, remote_url: 'https://github.com/evil/repo.git' },
    });
    expect(() => parseRunWorkRequest(body, config())).toThrow('run_work_request_rejected');
  });

  test('runs the exact Cursor model in plan mode for read-only work', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'cursor-run-work-test-'));
    const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const result = await executeRunWork(
      parseRunWorkRequest(JSON.stringify(request()), config(worktreeRoot)),
      config(worktreeRoot),
      { worker_id: 'cursor-1', fencing_token: 4 },
      {
        runCommand: async (command, args, options) => {
          calls.push({ command, args, stdin: options.stdin });
          if (command === 'cursor-agent') {
            return { exitCode: 0, stdout: 'Plan complete.', stderr: '' };
          }
          if (args.join(' ') === 'rev-parse HEAD') {
            return { exitCode: 0, stdout: sha, stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );

    const cursor = calls.find(call => call.command === 'cursor-agent');
    expect(cursor?.args).toContain(CURSOR_GROK_MODEL);
    expect(cursor?.args).toContain('plan');
    expect(cursor?.args).not.toContain('--force');
    expect(cursor?.stdin).not.toContain(request().artifacts.source_root);
    expect(result).toMatchObject({
      outcome: 'succeeded',
      requested_sha: sha,
      resulting_sha: sha,
      model: CURSOR_GROK_MODEL,
    });
  });

  test('requires a new commit and CAS-pushes only the assigned branch for write work', async () => {
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'cursor-run-work-write-test-'));
    const writeRequest = { ...request(), execution_mode: 'repository_write' as const };
    const resultingSha = 'b'.repeat(40);
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await executeRunWork(
      parseRunWorkRequest(JSON.stringify(writeRequest), config(worktreeRoot)),
      config(worktreeRoot),
      { worker_id: 'cursor-1', fencing_token: 5 },
      {
        runCommand: async (command, args) => {
          calls.push({ command, args });
          if (command === 'cursor-agent') {
            return { exitCode: 0, stdout: 'Implementation complete.', stderr: '' };
          }
          if (args.join(' ') === 'rev-parse HEAD') {
            return { exitCode: 0, stdout: resultingSha, stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }
    );

    const cursor = calls.find(call => call.command === 'cursor-agent');
    expect(cursor?.args).toContain('--force');
    expect(cursor?.args).not.toContain('plan');
    expect(calls).toContainEqual({
      command: 'git',
      args: [
        'push',
        `--force-with-lease=${writeRequest.repository.branch}:${sha}`,
        'origin',
        `HEAD:refs/heads/${writeRequest.repository.branch}`,
      ],
    });
    expect(result).toMatchObject({ outcome: 'succeeded', resulting_sha: resultingSha });
  });
});
