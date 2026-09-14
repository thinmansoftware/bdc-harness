import { afterEach, describe, expect, test } from 'bun:test';
import { resetRequiredContextsAttemptCounters } from '@archon/overseer/adapters/required-contexts';
import { runGateNotDeadCanary, type GateNotDeadGitHub } from './gate-not-dead-canary';

const HEAD = 'd'.repeat(40);

function github(conclusion: string): GateNotDeadGitHub {
  return {
    getAllStatusCheckContexts: async () => ({ data: ['docker-build', 'test (ubuntu-latest)'] }),
    listCheckRunsForRef: async () => ({
      data: {
        check_runs: [
          { name: 'docker-build', status: 'completed', conclusion },
          { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'success' },
        ],
      },
    }),
    getBranch: async () => ({ data: { protected: true, commit: { sha: HEAD } } }),
  };
}

afterEach(() => {
  resetRequiredContextsAttemptCounters();
});

describe('C6 gate-not-dead canary', () => {
  test('GREEN: every required check is green on the branch HEAD', async () => {
    const result = await runGateNotDeadCanary({
      github: github('success'),
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD,
      env: {},
    });
    expect(result.verdict).toBe('passed');
    expect(result.reasonCodes).toEqual([]);
  });

  test('RED: a required check failing on HEAD fails the canary', async () => {
    const result = await runGateNotDeadCanary({
      github: github('failure'),
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD,
      env: {},
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toContain('c6_required_check_red_on_head:docker-build');
  });
});
