import { describe, expect, test } from 'bun:test';
import { getRun } from './inspect.js';

describe('inspect tools', () => {
  test('returns the API run JSON unchanged', async () => {
    const run = { id: 'run-1', status: 'completed', workflow_name: 'major-build' };
    const result = await getRun(
      { runId: 'run-1' },
      { token: 'inspect-token', fetch: async () => Response.json(run) }
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual(run);
  });
});
