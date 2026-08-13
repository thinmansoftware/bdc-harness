import { describe, expect, test } from 'bun:test';
import {
  createDispatchMessageBodySchema,
  dispatchMessageSchema,
  runWorkRequestBodySchema,
  runWorkResultBodySchema,
} from './dispatch.schemas';

const sha = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);

function validRequest() {
  return {
    version: 'v1' as const,
    correlation_id: 'run-1:implement',
    idempotency_key: 'run-1:implement:attempt-1',
    workflow_run_id: 'run-1',
    node_id: 'implement',
    provider_attempt_id: 'attempt-1',
    provider_attempt_number: 1,
    execution_mode: 'repository_write' as const,
    repository: {
      remote_url: 'https://github.com/example/repo.git',
      branch: 'cauldron/run-1',
      requested_sha: sha,
    },
    model: 'cursor-grok-4.5-high' as const,
    prompt: 'Implement the approved change.',
    artifacts: {
      source_root: 'C:/server/artifacts/run-1',
      inputs: [
        {
          path: 'diff.patch',
          sha256,
          content_base64: Buffer.from('patch').toString('base64'),
          size_bytes: 5,
        },
      ],
      outputs: ['implement.env'],
      max_file_bytes: 1_048_576,
      max_total_bytes: 4_194_304,
    },
  };
}

describe('run_work dispatch contract', () => {
  test('accepts run_work in stored messages but not generic create', () => {
    expect(dispatchMessageSchema.shape.task_type.parse('run_work')).toBe('run_work');
    expect(() => createDispatchMessageBodySchema.shape.task_type.parse('run_work')).toThrow();
  });

  test('accepts the exact v1 request and rejects traversal or the wrong model', () => {
    expect(runWorkRequestBodySchema.parse(validRequest()).version).toBe('v1');
    expect(() =>
      runWorkRequestBodySchema.parse({
        ...validRequest(),
        artifacts: { ...validRequest().artifacts, outputs: ['../escape.txt'] },
      })
    ).toThrow();
    expect(() =>
      runWorkRequestBodySchema.parse({ ...validRequest(), model: 'x-ai/grok-4.5' })
    ).toThrow();
  });

  test('accepts a fenced result and rejects inconsistent artifact sizes', () => {
    const result = {
      version: 'v1' as const,
      worker_id: 'cursor-desktop-1',
      fencing_token: 3,
      outcome: 'succeeded' as const,
      requested_sha: sha,
      resulting_sha: sha,
      output: 'Complete.',
      model: 'cursor-grok-4.5-high' as const,
      artifacts: {
        outputs: [
          {
            path: 'implement.env',
            sha256,
            content_base64: Buffer.from('hello').toString('base64'),
            size_bytes: 5,
          },
        ],
      },
    };
    expect(runWorkResultBodySchema.parse(result).outcome).toBe('succeeded');
    expect(() =>
      runWorkResultBodySchema.parse({
        ...result,
        artifacts: {
          outputs: [{ ...result.artifacts.outputs[0], size_bytes: 6 }],
        },
      })
    ).toThrow();
  });
});
