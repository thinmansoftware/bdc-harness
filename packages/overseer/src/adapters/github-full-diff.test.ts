import { expect, test } from 'bun:test';
import {
  createRealFetchExactHeadPullRequestEvidence,
  type RealGitHubOctokitLike,
} from './github-real-deps';
import { inMemoryAttemptCounterStore } from './required-contexts';
import { evaluatePullRequest } from '../pr-review-evaluator';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40);
const request = { owner: 'synthetic', repo: 'fixture', prNumber: 1, headSha: head };
const textDiff =
  'diff --git a/spec.md b/spec.md\n--- a/spec.md\n+++ b/spec.md\n@@ -1 +1 @@\n-old\n+' +
  'large text\n+'.repeat(12000) +
  'real hunk\n';
function fixture(response: unknown, patch?: string | null, filename = 'spec.md') {
  const calls: Record<string, unknown>[] = [];
  const client = {
    pulls: {
      get: async () => ({ data: { head: { sha: head }, base: { sha: base, ref: 'dev' } } }),
    },
    checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
    repos: {
      compareCommits: async (input: Record<string, unknown>) => {
        calls.push(input);
        if (input.headers) {
          if (response instanceof Error) throw response;
          return { data: response };
        }
        return { data: { files: [{ filename, ...(patch === undefined ? {} : { patch }) }] } };
      },
      getAllStatusCheckContexts: async () => ({ data: ['test'] }),
    },
  } as unknown as RealGitHubOctokitLike;
  return {
    calls,
    fetch: createRealFetchExactHeadPullRequestEvidence(
      client,
      undefined,
      inMemoryAttemptCounterStore
    ),
  };
}

test('missing large text patch uses whole diff at immutable base and head', async () => {
  const f = fixture(textDiff);
  const result = await f.fetch(request);
  expect(result.diff).toBe(textDiff);
  expect(result.diff.length).toBeGreaterThan(105000);
  expect(f.calls[1]).toEqual({
    owner: request.owner,
    repo: request.repo,
    base,
    head,
    headers: { accept: 'application/vnd.github.diff' },
  });
});

test('ordinary listing patches preserve the existing path without fallback', async () => {
  const f = fixture(new Error('must not call'), '@@ -1 +1 @@\n-old\n+new');
  expect((await f.fetch(request)).diff).toContain('+new');
  expect(f.calls).toHaveLength(1);
});

test('null patch is missing evidence too', async () => {
  const f = fixture(textDiff, null);
  expect((await f.fetch(request)).diff).toBe(textDiff);
  expect(f.calls).toHaveLength(2);
});

test('binary whole diff retains the explicit unavailable marker', async () => {
  const f = fixture(
    'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n',
    undefined,
    'image.png'
  );
  expect((await f.fetch(request)).diff).toContain('[binary or patch unavailable]');
});

for (const response of [
  new Error('PRIVATE_HTTP_CANARY'),
  '',
  { files: [] },
  'diff --git a/spec.md b/spec.md\n',
  'diff --git a/other.md b/other.md\n@@ -1 +1 @@\n-old\n+new\n',
]) {
  test(`unavailable whole diff refuses evidence and never starts judge (${typeof response})`, async () => {
    const f = fixture(response);
    await expect(f.fetch(request)).rejects.toThrow('pr_review_diff_evidence_unavailable');
    let calls = 0;
    const result = await evaluatePullRequest(
      { owner: request.owner, repo: request.repo, pr_number: 1, head_sha: head },
      {
        reviewer: { provider: 'fixture', model: 'fixture' },
        fetchEvidence: async () => f.fetch(request),
        fetchAcceptanceCriteria: async () => null,
        invokeModel: async () => {
          calls++;
          throw new Error('judge must not start');
        },
      }
    );
    expect(calls).toBe(0);
    expect(result.verdict).toBe('TRANSPORT_ERROR');
    expect(result.retry_after_ms).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HTTP_CANARY');
  });
}
