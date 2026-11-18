import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReviewPrompt, evaluatePullRequest } from '../pr-review-evaluator';
import {
  ARCHIVE_DIGEST,
  BUNDLE_PATH,
  PRODUCER_ANCHOR,
  collectBundleCoverage,
  configuredBundleProducer,
  inputInventoriesMatch,
  producerClosureMatches,
  reconcileDiff,
  reconcilesText,
  type Inventory,
  type ProofRead,
} from '../bundle-review-proof';

const head = 'a'.repeat(40),
  base = 'b'.repeat(40),
  tested = 'c'.repeat(40),
  producer = 'd'.repeat(40);
const source = '.archon/workflows/defaults/lane.yaml';
const workflow = '.github/workflows/test.yml',
  helper = 'scripts/ci/verified-bundle-proof.py';
const hash = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function fixture() {
  const blobs = new Map<string, Buffer>();
  const entry = (raw: string | Buffer) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(sha, bytes);
    return { mode: '100644', sha };
  };
  const oldBundle = 'old bundle\n',
    newBundle = 'new bundle\n';
  const anchor: Inventory = new Map([
    [workflow, entry('old workflow')],
    ['package.json', entry('{"scripts":{"prepare":"husky"}}')],
    ['scripts/generate-bundled-defaults.ts', entry('trusted generator')],
    [source, entry('old source\n')],
    [BUNDLE_PATH, entry(oldBundle)],
  ]);
  const h: Inventory = new Map(anchor);
  h.set(source, entry('new source\n'));
  h.set(BUNDLE_PATH, entry(newBundle));
  const p: Inventory = new Map(anchor);
  p.set(workflow, entry('new admitted workflow'));
  p.set(helper, entry('new admitted helper'));
  const t: Inventory = new Map(h);
  t.set(workflow, p.get(workflow)!);
  t.set(helper, p.get(helper)!);
  const inventories = new Map([
    [base, anchor],
    [PRODUCER_ANCHOR, anchor],
    [head, h],
    [producer, p],
    [tested, t],
  ]);
  const proof: Record<string, unknown> = {
    schema: 1,
    repository: 'thinmansoftware/bdc-harness',
    run: 10,
    attempt: 1,
    pr: 1609,
    head,
    base,
    checkout: tested,
    tree: hash(tested).slice(0, 40),
    archive: ARCHIVE_DIGEST,
    runtime: '1'.repeat(64),
    bundle: hash(newBundle),
    platform: 'linux-x64',
    image: 'ubuntu24',
    imageVersion: 'approved image',
    workflow: tested,
    workflowRef: `thinmansoftware/bdc-harness/${workflow}@refs/pull/1609/merge`,
    python: '3.12',
    git: 'git 2',
    pythonSha256: '2'.repeat(64),
    gitSha256: '3'.repeat(64),
    nodeSha256: '4'.repeat(64),
  };
  let diff =
    `diff --git a/${source} b/${source}\n--- a/${source}\n+++ b/${source}\n@@ -1 +1 @@\n-old source\n+new source\n` +
    `diff --git a/${BUNDLE_PATH} b/${BUNDLE_PATH}\n--- a/${BUNDLE_PATH}\n+++ b/${BUNDLE_PATH}\n@@ -1 +1 @@\n-old bundle\n+new bundle\n`;
  const responses: Record<string, Record<string, unknown>> = {
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': { head: { sha: head }, base: { sha: base } },
    'GET /repos/{owner}/{repo}': { id: 1233963411 },
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}': { id: 273810118, path: workflow },
    'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs': {
      total_count: 1,
      workflow_runs: [{ id: 10 }],
    },
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}': {
      id: 10,
      workflow_id: 273810118,
      event: 'pull_request',
      path: workflow,
      head_sha: head,
      status: 'completed',
      conclusion: 'success',
      repository: { id: 1233963411 },
      run_attempt: 1,
      check_suite_id: 20,
      pull_requests: [{ number: 1609, head: { sha: head }, base: { sha: base } }],
    },
    'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs': {
      total_count: 1,
      jobs: [
        {
          id: 30,
          name: 'test (ubuntu-latest)',
          run_id: 10,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          steps: [
            {
              number: 3,
              name: 'Verified bundle producer',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      ],
    },
    'GET /repos/{owner}/{repo}/check-runs/{check_run_id}': {
      id: 30,
      head_sha: head,
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368 },
      check_suite: { id: 20 },
    },
    'GET /repos/{owner}/{repo}/check-suites/{check_suite_id}': {
      id: 20,
      head_sha: head,
      app: { id: 15368 },
    },
  };
  const read: ProofRead = async (route, args) => {
    if (route.endsWith('/compare/{basehead}'))
      return args.headers ? diff : { merge_base_commit: { sha: base } };
    if (route.endsWith('/git/commits/{commit_sha}')) {
      const sha = String(args.commit_sha);
      return {
        tree: { sha: hash(sha).slice(0, 40) },
        parents: sha === tested ? [{ sha: base }, { sha: head }] : [],
      };
    }
    if (route.endsWith('/git/trees/{tree_sha}')) {
      const pair = [...inventories].find(([sha]) => hash(sha).slice(0, 40) === args.tree_sha)!;
      return {
        truncated: false,
        tree: [...pair[1]].map(([path, e]) => ({ path, type: 'blob', ...e })),
      };
    }
    if (route.endsWith('/git/blobs/{file_sha}'))
      return {
        sha: args.file_sha,
        encoding: 'base64',
        content: blobs.get(String(args.file_sha))!.toString('base64'),
      };
    if (route.endsWith('/logs'))
      return `2026-11-18T16:00:00.000Z BUNDLE_PROOF_V1 ${Buffer.from(JSON.stringify(proof)).toString('base64')}\n`;
    if (!(route in responses)) throw new Error('unexpected API read');
    return responses[route];
  };
  return {
    read,
    responses,
    anchor,
    h,
    p,
    t,
    proof,
    entry,
    get diff() {
      return diff;
    },
    set diff(v: string) {
      diff = v;
    },
  };
}
const input = {
  owner: 'thinmansoftware',
  repo: 'bdc-harness',
  prNumber: 1609,
  headSha: head,
  baseSha: base,
};

describe('#6357 producer and exhaustive proof guards', () => {
  test('exclusion is OFF without both the explicit enable and immutable producer admission', () => {
    expect(configuredBundleProducer({})).toBeNull();
    expect(configuredBundleProducer({ OVERSEER_BUNDLE_EXCLUSION_ENABLED: '1' })).toBeNull();
    expect(configuredBundleProducer({ OVERSEER_BUNDLE_PRODUCER_COMMIT: producer })).toBeNull();
    expect(
      configuredBundleProducer({
        OVERSEER_BUNDLE_EXCLUSION_ENABLED: '1',
        OVERSEER_BUNDLE_PRODUCER_COMMIT: 'dev',
      })
    ).toBeNull();
    expect(
      configuredBundleProducer({
        OVERSEER_BUNDLE_EXCLUSION_ENABLED: '1',
        OVERSEER_BUNDLE_PRODUCER_COMMIT: producer,
      })
    ).toBe(producer);
  });
  test('coverage reaches the prompt and result independently of model cooperation', async () => {
    const coverage = { notice: 'Protected complete coverage', baseSha: base, producer };
    let observed = '';
    const result = await evaluatePullRequest(
      { owner: input.owner, repo: input.repo, pr_number: 1609, head_sha: head },
      {
        reviewer: { provider: 'test', model: 'codex' },
        ladder: ['codex'],
        fetchEvidence: async () => ({
          diff: '+authored source',
          coverage,
          checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
        }),
        fetchAcceptanceCriteria: async () => null,
        invokeModel: async (_binary, prompt) => {
          observed = prompt;
          return {
            exitCode: 0,
            timedOut: false,
            stdout: JSON.stringify({
              verdict: 'APPROVE',
              findings: [],
              reviewed_head_sha: head,
              coverage: { notice: 'forged' },
            }),
          };
        },
      }
    );
    expect(observed).toContain(coverage.notice);
    expect(observed).toContain('+authored source');
    expect(result.coverage).toEqual(coverage);
  });
  test('coverage notice is part of the final byte cap with zero model calls', async () => {
    const request = { owner: input.owner, repo: input.repo, pr_number: 1609, head_sha: head };
    const checks = [{ name: 'test', status: 'completed', conclusion: 'success' }];
    const header = buildReviewPrompt({
      request,
      diff: '',
      checkPartition: { gating: checks, nonRequired: [] },
      acceptanceCriteria: null,
    });
    const diff = 'x'.repeat(1_048_576 - Buffer.byteLength(header, 'utf8'));
    const coverage = { notice: 'Additional protected notice', baseSha: base, producer };
    let calls = 0;
    const result = await evaluatePullRequest(request, {
      reviewer: { provider: 'test', model: 'codex' },
      ladder: ['codex'],
      fetchEvidence: async () => ({ diff, checks, coverage }),
      fetchAcceptanceCriteria: async () => null,
      invokeModel: async () => {
        calls++;
        throw new Error('must not invoke');
      },
    });
    expect(result.verdict).toBe('INDETERMINATE');
    expect(result.error).toStartWith('prompt_too_large:');
    expect(result.coverage).toEqual(coverage);
    expect(result.retry_after_ms).toBeUndefined();
    expect(calls).toBe(0);
  });
  test('controlled producer rejects bad digest, cache, mutation, links and untracked config', () => {
    const script = fileURLToPath(
      new URL('../../../../scripts/ci/verified-bundle-proof.test.py', import.meta.url)
    );
    const result = spawnSync(
      process.platform === 'win32' ? 'python' : '/usr/bin/python3',
      [script],
      { encoding: 'utf8' }
    );
    expect(result.stderr).toContain('Ran 8 tests');
    expect(result.status).toBe(0);
  });
  test('authenticated new producer excludes only bundle and publishes complete provenance', async () => {
    const f = fixture();
    const result = await collectBundleCoverage(f.read, input, producer);
    expect(result.coverage?.notice).toContain('step 3');
    expect(result.coverage?.notice).toContain(PRODUCER_ANCHOR);
    expect(result.diff).toContain('+new source');
    expect(result.diff).not.toContain('+new bundle');
  });
  test('a one-MB single-line bundle is removed while the complete authored hunk remains', async () => {
    const f = fixture();
    const old = 'a'.repeat(1_000_000) + '\n',
      next = 'b'.repeat(1_000_000) + '\n';
    f.anchor.set(BUNDLE_PATH, f.entry(old));
    f.h.set(BUNDLE_PATH, f.entry(next));
    f.t.set(BUNDLE_PATH, f.h.get(BUNDLE_PATH)!);
    f.diff = f.diff.replace('-old bundle\n+new bundle\n', `-${old}+${next}`);
    f.proof.bundle = hash(next);
    const result = await collectBundleCoverage(f.read, input, producer);
    expect(result.coverage).toBeDefined();
    expect(Buffer.byteLength(result.diff, 'utf8')).toBeLessThan(1_048_576);
    expect(result.diff).toContain('-old source\n+new source\n');
  });
  for (const guard of [
    'missing',
    'failed',
    'old',
    'unreadable',
    'app',
    'attempt',
    'checkout',
    'LF',
    'input',
    'mode',
    'config',
    'base',
    'workflow',
  ] as const) {
    test(`${guard} proof retains full diff`, async () => {
      const f = fixture();
      let read = f.read;
      if (guard === 'missing')
        f.responses['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = {
          total_count: 0,
          workflow_runs: [],
        };
      if (guard === 'failed')
        f.responses['GET /repos/{owner}/{repo}/actions/runs/{run_id}'].conclusion = 'failure';
      if (guard === 'old') f.t.set(workflow, f.anchor.get(workflow)!);
      if (guard === 'unreadable')
        read = async (r, a) => {
          if (r.includes('/actions/')) throw new Error('403');
          return f.read(r, a);
        };
      if (guard === 'app')
        f.responses['GET /repos/{owner}/{repo}/check-runs/{check_run_id}'].app = { id: 666 };
      if (guard === 'attempt') f.proof.attempt = 2;
      if (guard === 'checkout') f.proof.checkout = head;
      if (guard === 'workflow') f.proof.workflow = head;
      if (guard === 'base')
        f.responses['GET /repos/{owner}/{repo}/pulls/{pull_number}'].base = { sha: producer };
      if (guard === 'LF') {
        const raw = 'new bundle\r\n';
        const e = f.entry(raw);
        f.h.set(BUNDLE_PATH, e);
        f.t.set(BUNDLE_PATH, e);
        f.proof.bundle = hash(raw);
        f.diff = f.diff.replace('+new bundle\n', '+new bundle\r\n');
      }
      if (guard === 'input') f.t.set(source, f.entry('different input\n'));
      if (guard === 'mode') f.t.set(source, { ...f.h.get(source)!, mode: '100755' });
      if (guard === 'config') {
        const e = f.entry('preload=[]');
        f.h.set('bunfig.toml', e);
        f.t.set('bunfig.toml', e);
        f.anchor.set('bunfig.toml', e); /* producer absent is a closure mismatch */
      }
      // Config is not a changed path relative to comparison scope in this isolated closure test.
      const result = await collectBundleCoverage(read, input, producer);
      expect(result.coverage).toBeUndefined();
      expect(result.diff).toBe(f.diff);
    });
  }
  test('input inventory detects additions, deletion and unsupported modes', () => {
    const f = fixture();
    expect(inputInventoriesMatch(f.t, f.h)).toBe(true);
    f.t.set(source + '.new', f.entry('new'));
    expect(inputInventoriesMatch(f.t, f.h)).toBe(false);
    f.t.delete(source + '.new');
    f.t.delete(source);
    expect(inputInventoriesMatch(f.t, f.h)).toBe(false);
    f.t.set(source, { ...f.h.get(source)!, mode: '120000' });
    expect(inputInventoriesMatch(f.t, f.h)).toBe(false);
  });
  test('new lifecycle/preload configuration and producer code changes disable eligibility', () => {
    const f = fixture();
    expect(producerClosureMatches(f.anchor, f.p, f.t, f.h)).toBe(true);
    f.h.set('.env.local', f.entry('BUN_OPTIONS=--preload bad'));
    expect(producerClosureMatches(f.anchor, f.p, f.t, f.h)).toBe(false);
  });
  for (const corrupt of ['missing', 'duplicate', 'partial'] as const) {
    test(`${corrupt} diff never passes as complete source`, async () => {
      const f = fixture();
      if (corrupt === 'missing')
        f.diff = f.diff.slice(f.diff.indexOf(`diff --git a/${BUNDLE_PATH}`));
      if (corrupt === 'duplicate') f.diff += f.diff;
      if (corrupt === 'partial') f.diff = f.diff.replace('+new source', '+truncated source');
      await expect(collectBundleCoverage(f.read, input, producer)).rejects.toThrow();
    });
  }
  test('binary marker preserved alongside full-text fallback', async () => {
    const f = fixture();
    f.anchor.set('image.png', f.entry(Buffer.from([0, 1])));
    f.h.set('image.png', f.entry(Buffer.from([0, 2])));
    f.diff +=
      'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
    const result = await collectBundleCoverage(f.read, input, '');
    expect(result.diff).toContain(
      'Binary files a/image.png and b/image.png differ\n[binary or patch unavailable]'
    );
    expect(result.diff).toContain('+new source');
  });
  test('hunk application checks no-newline, empty add, multiple hunks and rejects missing text', () => {
    expect(
      reconcilesText(
        'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n',
        Buffer.from('a'),
        Buffer.from('b')
      )
    ).toBe(true);
    expect(
      reconcilesText('diff --git a/x b/x\n@@ -0,0 +1 @@\n+b\n', Buffer.alloc(0), Buffer.from('b\n'))
    ).toBe(true);
    expect(
      reconcilesText(
        'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n',
        Buffer.from('a\nx\nc\n'),
        Buffer.from('b\nx\nd\n')
      )
    ).toBe(true);
  });
  test('complete tree inventory does not trust an omitted compare files array', async () => {
    const f = fixture();
    const result = await reconcileDiff(f.read, f.diff, f.anchor, f.h);
    expect(result).toHaveLength(2);
  });
  test('empty-file creation must include its complete mode metadata, not just a header', async () => {
    const f = fixture();
    f.h.set('empty.txt', f.entry(''));
    f.diff += 'diff --git a/empty.txt b/empty.txt\n';
    await expect(collectBundleCoverage(f.read, input, '')).rejects.toThrow();
    f.diff += 'new file mode 100644\n';
    expect((await collectBundleCoverage(f.read, input, '')).diff).toContain('new file mode 100644');
  });
  test('a truncated recursive inventory is expanded through a complete nonrecursive tree', async () => {
    const f = fixture();
    let fallbackReads = 0;
    const read: ProofRead = async (route, args) => {
      if (route.endsWith('/git/trees/{tree_sha}') && args.recursive)
        return { truncated: true, tree: [] };
      if (route.endsWith('/git/trees/{tree_sha}')) fallbackReads++;
      return f.read(route, args);
    };
    expect((await collectBundleCoverage(read, input, producer)).coverage).toBeDefined();
    expect(fallbackReads).toBeGreaterThan(0);
  });
  test('unrecoverably truncated inventory never reaches a model with partial source', async () => {
    const f = fixture();
    await expect(
      collectBundleCoverage(
        async (route, args) =>
          route.endsWith('/git/trees/{tree_sha}')
            ? { truncated: true, tree: [] }
            : f.read(route, args),
        input,
        producer
      )
    ).rejects.toThrow();
  });
});
