import { afterEach, describe, expect, test } from 'bun:test';
import { resetRequiredContextsAttemptCounters } from '@archon/overseer/adapters/required-contexts';
import type { RealGitHubOctokitLike } from '@archon/overseer/adapters/github-real-deps';
import {
  createGateNotDeadGitHubAdapter,
  runGateNotDeadCanary,
  type GateNotDeadGitHub,
} from './gate-not-dead-canary';

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

  test('RED: a base with no required checks is a dead gate, not a pass', async () => {
    const result = await runGateNotDeadCanary({
      github: {
        ...github('success'),
        getAllStatusCheckContexts: async () => ({ data: [] }),
      },
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD,
      env: {},
    });
    expect(result.verdict).toBe('failed');
    expect(result.reasonCodes).toEqual(['c6_no_required_checks_on_base']);
    expect(result.evidenceRefs).toContain('required_contexts=0');
  });

  test('missing github client is blocked, not failed', async () => {
    const result = await runGateNotDeadCanary({ env: {} });
    expect(result.verdict).toBe('blocked');
    expect(result.reasonCodes).toEqual(['c6_github_client_unavailable']);
  });

  test('adapter maps octokit shapes onto GateNotDeadGitHub', async () => {
    const octokit = {
      pulls: {
        list: async () => ({ data: [] }),
        get: async () => ({
          data: {
            number: 1,
            title: 't',
            state: 'open',
            html_url: 'https://example.invalid',
            head: { sha: HEAD },
          },
        }),
        merge: async () => ({ data: { merged: false } }),
      },
      search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
      checks: {
        listForRef: async (input: { ref: string }) => {
          expect(input.ref).toBe(HEAD);
          return {
            data: {
              check_runs: [{ name: 'docker-build', status: 'completed', conclusion: 'success' }],
            },
          };
        },
      },
      repos: {
        getAllStatusCheckContexts: async () => ({ data: ['docker-build'] }),
        getBranch: async () => ({ data: { protected: true, commit: { sha: HEAD } } }),
      },
    } as unknown as RealGitHubOctokitLike;
    const github = createGateNotDeadGitHubAdapter(octokit);
    const contexts = await github.getAllStatusCheckContexts({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
    });
    expect(contexts.data).toEqual(['docker-build']);
    const listed = await github.listCheckRunsForRef({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      ref: HEAD,
    });
    expect(listed.data.check_runs[0]?.name).toBe('docker-build');
    const branch = await github.getBranch?.({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
    });
    expect(branch?.data.commit?.sha).toBe(HEAD);
    const result = await runGateNotDeadCanary({
      github,
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      branch: 'dev',
      headSha: HEAD,
      env: {},
    });
    expect(result.verdict).toBe('passed');
  });
});
