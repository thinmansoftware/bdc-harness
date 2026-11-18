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
function fixture(response: unknown, patch?: string | null, filename = 'spec.md', metadata = {}) {
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
        return {
          data: { files: [{ filename, ...metadata, ...(patch === undefined ? {} : { patch }) }] },
        };
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

for (const [name, body, metadata] of [
  [
    'rename',
    'similarity index 100%\nrename from old.md\nrename to spec.md\n',
    { status: 'renamed', previous_filename: 'old.md', changes: 0 },
  ],
  ['mode', 'old mode 100644\nnew mode 100755\n', { status: 'modified', changes: 0 }],
  [
    'empty addition',
    'new file mode 100644\nindex 0000000..e69de29\n',
    { status: 'added', changes: 0 },
  ],
  [
    'empty deletion',
    'deleted file mode 100644\nindex e69de29..0000000\n',
    { status: 'removed', changes: 0 },
  ],
] as const) {
  test(`complete metadata-only ${name} is reviewable`, async () => {
    const diff = `diff --git a/${name === 'rename' ? 'old.md' : 'spec.md'} b/spec.md\n${body}`;
    expect((await fixture(diff, undefined, 'spec.md', metadata).fetch(request)).diff).toBe(diff);
    const mixed = diff + textDiff.replaceAll('spec.md', 'other.md');
    expect((await fixture(mixed, undefined, 'spec.md', metadata).fetch(request)).diff).toBe(mixed);
  });
}

test('metadata-only evidence with contradictory change metadata refuses', async () => {
  const diff = 'diff --git a/spec.md b/spec.md\nold mode 100644\nnew mode 100755\n';
  await expect(
    fixture(diff, undefined, 'spec.md', { status: 'modified', changes: 3 }).fetch(request)
  ).rejects.toThrow('pr_review_diff_evidence_unavailable');
});

const renameModeMetadata = { status: 'renamed', previous_filename: 'old.sh', changes: 0 };
const renameLines = 'similarity index 100%\nrename from old.sh\nrename to new.sh\n';
test('complete Git rename plus chmod is reviewable alone and in a mixed diff', async () => {
  const diff = 'diff --git a/old.sh b/new.sh\nold mode 100644\nnew mode 100755\n' + renameLines;
  expect((await fixture(diff, undefined, 'new.sh', renameModeMetadata).fetch(request)).diff).toBe(
    diff
  );
  const mixed = diff + textDiff;
  expect((await fixture(mixed, undefined, 'new.sh', renameModeMetadata).fetch(request)).diff).toBe(
    mixed
  );
});

for (const modes of [
  'old mode 100644\n',
  'new mode 100755\n',
  'old mode invalid\nnew mode 100755\n',
  'new mode 100755\nold mode 100644\n',
  'old mode 100644\nnew mode 100755\nunexpected metadata\n',
]) {
  test('rename plus malformed or incomplete mode metadata refuses', async () => {
    await expect(
      fixture(
        'diff --git a/old.sh b/new.sh\n' + modes + renameLines,
        undefined,
        'new.sh',
        renameModeMetadata
      ).fetch(request)
    ).rejects.toThrow('pr_review_diff_evidence_unavailable');
  });
}

test('rename plus chmod with contradictory API source refuses', async () => {
  const diff = 'diff --git a/old.sh b/new.sh\nold mode 100644\nnew mode 100755\n' + renameLines;
  await expect(
    fixture(diff, undefined, 'new.sh', {
      ...renameModeMetadata,
      previous_filename: 'wrong.sh',
    }).fetch(request)
  ).rejects.toThrow('pr_review_diff_evidence_unavailable');
});

for (const [body, metadata] of [
  [
    'similarity index 100%\nrename from wrong.md\nrename to spec.md\n',
    { status: 'renamed', previous_filename: 'old.md', changes: 0 },
  ],
  ['old mode 100644\n', { status: 'modified', changes: 0 }],
  ['new file mode 100644\nindex 0000000..1234567\n', { status: 'added', changes: 0 }],
  ['old mode 100644\nnew mode 100755\n', { status: 'modified' }],
] as const) {
  test('incomplete or mismatched metadata-only evidence refuses', async () => {
    await expect(
      fixture(`diff --git a/spec.md b/spec.md\n${body}`, undefined, 'spec.md', metadata).fetch(
        request
      )
    ).rejects.toThrow('pr_review_diff_evidence_unavailable');
  });
}

test('non-rate-limit permission failure stays sanitized evidence failure', async () => {
  const error = Object.assign(new Error('PRIVATE_HTTP_CANARY'), { status: 403 });
  await expect(fixture(error).fetch(request)).rejects.toThrow(
    'pr_review_diff_evidence_unavailable'
  );
});

for (const status of [429, 403]) {
  test(`whole-diff ${status} preserves Retry-After without starting judge or leaking error`, async () => {
    const error = Object.assign(new Error('PRIVATE_HTTP_CANARY'), {
      status,
      response: { headers: { 'retry-after': '900' } },
    });
    const f = fixture(error);
    let calls = 0;
    const result = await evaluatePullRequest(
      { owner: request.owner, repo: request.repo, pr_number: 1, head_sha: head },
      {
        reviewer: { provider: 'fixture', model: 'fixture' },
        fetchEvidence: async () => f.fetch(request),
        fetchAcceptanceCriteria: async () => null,
        invokeModel: async () => {
          calls++;
          throw new Error('must not start');
        },
      }
    );
    expect(calls).toBe(0);
    expect(result.verdict).toBe('RATE_LIMITED');
    expect(result.retry_after_ms).toBe(900000);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_HTTP_CANARY');
  });
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
