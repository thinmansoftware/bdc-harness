import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReviewPrompt, evaluatePullRequest } from '../pr-review-evaluator';
import {
  ARCHIVE_DIGEST,
  BUNDLE_PATH,
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
const stamp = '2026-11-18T16:00:00.000Z';
/** One timestamped receipt line; `sorted` builds it the way the producer does (sort_keys). */
function receiptLine(proof: Record<string, unknown>, sorted = false): string {
  const fields = sorted
    ? Object.fromEntries(Object.entries(proof).sort(([a], [b]) => (a < b ? -1 : 1)))
    : proof;
  return `${stamp} BUNDLE_PROOF_V1 ${Buffer.from(JSON.stringify(fields)).toString('base64')}\n`;
}

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
  // The base (dev) inventory is `anchor`; by default the merge base is the base itself.
  let mergeBaseSha = base;
  const inventories = new Map([
    [base, anchor],
    [head, h],
    [producer, p],
    [tested, t],
  ]);
  // compare/{x}...{y} statuses for the D3 base conditions (WO-HARNESS-BUNDLE-REVIEW-PROOF-REPAIR-01).
  const compares: Record<string, string> = {
    [`${base}...dev`]: 'ahead',
    [`${producer}...${base}`]: 'ahead',
  };
  // Per-attempt job lists and per-job logs; absent entries fall back to the defaults below.
  const jobsByAttempt = new Map<number, Record<string, unknown>[]>();
  const logsByJob = new Map<number, string>();
  const reads: string[] = [];
  const proof: Record<string, unknown> = {
    schema: 1,
    phase: 'preinstall',
    dependenciesInstalled: false,
    generator: '9cc028a6a440036c50aabd14dc385cabfa5d32520ea882779371863499c24220',
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
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': {
      head: { sha: head },
      base: { sha: base, ref: 'dev' },
    },
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
    reads.push(`${route}${args.headers ? ' [diff]' : ''}`);
    if (route.endsWith('/compare/{basehead}')) {
      if (args.headers) return diff;
      const status = compares[String(args.basehead)];
      return status ? { status } : { status: 'ahead', merge_base_commit: { sha: mergeBaseSha } };
    }
    if (route.endsWith('/attempts/{attempt_number}/jobs')) {
      const jobs = jobsByAttempt.get(Number(args.attempt_number));
      if (jobs) return { total_count: jobs.length, jobs };
    }
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
    if (route.endsWith('/logs')) return logsByJob.get(Number(args.job_id)) ?? receiptLine(proof);
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
    compares,
    jobsByAttempt,
    logsByJob,
    reads,
    /** Give the pull request a merge base distinct from its base (dev moved on). */
    setMergeBase(inventory: Inventory) {
      mergeBaseSha = 'e'.repeat(40);
      inventories.set(mergeBaseSha, inventory);
    },
    /** The head (and so the tested merge) changes one file; the diff gets its block. */
    change(path: string, after: string) {
      const before = anchor.get(path);
      const next = entry(after);
      h.set(path, next);
      t.set(path, next);
      const old = before ? blobs.get(before.sha)!.toString() : undefined;
      diff += old
        ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${old}+${after}`
        : `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${after}`;
    },
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
    expect(result.stderr).toContain('Ran 16 tests');
    expect(result.status).toBe(0);
  });
  test('authenticated new producer excludes only bundle and publishes complete provenance', async () => {
    const f = fixture();
    const result = await collectBundleCoverage(f.read, input, producer);
    expect(result.coverage?.notice).toContain('step 3');
    // D3: the anchor is the pull request's authenticated base on dev, not a fixed commit.
    expect(result.coverage?.notice).toContain(`Anchor ${base};`);
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
    'postinstall',
    'dependencies',
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
      if (guard === 'postinstall') f.proof.phase = 'postinstall';
      if (guard === 'dependencies') f.proof.dependenciesInstalled = true;
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
      // D3: a pull request that brings root runtime configuration changes a pre-receipt file.
      if (guard === 'config') f.change('bunfig.toml', 'preload=[]\n');
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
    // (mergeBase, base, producer, tested, head); here the merge base is the base.
    expect(producerClosureMatches(f.anchor, f.anchor, f.p, f.t, f.h)).toBe(true);
    f.h.set('.env.local', f.entry('BUN_OPTIONS=--preload bad'));
    expect(producerClosureMatches(f.anchor, f.anchor, f.p, f.t, f.h)).toBe(false);
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
  test('BRP-1 an unfinished Test Suite run returns bundleRunPending before any diff or blob read', async () => {
    const run = (f: ReturnType<typeof fixture>) =>
      f.responses['GET /repos/{owner}/{repo}/actions/runs/{run_id}'];
    const f = fixture();
    Object.assign(run(f), { status: 'in_progress', conclusion: null });
    const result = await collectBundleCoverage(f.read, input, producer);
    expect(result).toEqual({ bundleRunPending: true });
    expect(f.reads.some(r => r.includes('/git/blobs/'))).toBe(false);
    expect(f.reads.some(r => r.endsWith('[diff]'))).toBe(false);

    // The bundle path unchanged between merge base and head: never pending.
    const same = fixture();
    Object.assign(run(same), { status: 'in_progress', conclusion: null });
    same.h.set(BUNDLE_PATH, same.anchor.get(BUNDLE_PATH)!);
    same.t.set(BUNDLE_PATH, same.anchor.get(BUNDLE_PATH)!);
    same.diff = same.diff.slice(0, same.diff.indexOf(`diff --git a/${BUNDLE_PATH}`));
    const unchanged = await collectBundleCoverage(same.read, input, producer);
    expect('bundleRunPending' in unchanged).toBe(false);
    expect(unchanged).toMatchObject({ bundleProofUnavailable: true });

    // No run at all for the head: proof unavailable, full diff, as today.
    const none = fixture();
    none.responses['GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs'] = {
      total_count: 0,
      workflow_runs: [],
    };
    expect(await collectBundleCoverage(none.read, input, producer)).toEqual({
      diff: none.diff,
      bundleProofUnavailable: true,
    });
  });

  test('BRP-2 the evaluator defers bundleRunPending as CHECKS_PENDING on Test Suite', async () => {
    let calls = 0;
    const result = await evaluatePullRequest(
      { owner: input.owner, repo: input.repo, pr_number: 1609, head_sha: head },
      {
        reviewer: { provider: 'test', model: 'codex' },
        ladder: ['codex'],
        fetchEvidence: async () => ({
          diff: 'x'.repeat(2_000_000),
          bundleRunPending: true,
          checks: [{ name: 'docker-build', status: 'completed', conclusion: 'success' }],
        }),
        fetchAcceptanceCriteria: async () => null,
        invokeModel: async () => {
          calls++;
          throw new Error('must not invoke');
        },
      }
    );
    expect(result.verdict).toBe('CHECKS_PENDING');
    expect(result.error).toBe('checks_pending');
    expect(result.pendingChecks).toEqual(['Test Suite']);
    expect(result.findings).toEqual([]);
    expect(result.acceptance_criteria_available).toBe(false);
    expect(result.reviewed_head_sha).toBe(head);
    expect(calls).toBe(0);
  });

  describe('BRP-3 a carried-forward Ubuntu job from an earlier attempt', () => {
    const times = { started_at: '2026-11-19T13:39:28Z', completed_at: '2026-11-19T13:56:38Z' };
    function rerun() {
      const f = fixture();
      const template = (
        f.responses[
          'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs'
        ].jobs as Record<string, unknown>[]
      )[0];
      f.responses['GET /repos/{owner}/{repo}/actions/runs/{run_id}'].run_attempt = 2;
      const ja: Record<string, unknown> = { ...template, ...times, id: 30, run_attempt: 1 };
      const jl: Record<string, unknown> = { ...template, ...times, id: 31, run_attempt: 2 };
      f.jobsByAttempt.set(1, [ja]);
      f.jobsByAttempt.set(2, [jl]);
      return { f, ja, jl };
    }
    test('the copy validates against the attempt-1 job, with the attempt-1 receipt', async () => {
      const { f } = rerun();
      const result = await collectBundleCoverage(f.read, input, producer);
      expect(result.coverage?.notice).toContain('check/job 30');
      expect(f.reads.filter(r => r.endsWith('/logs'))).toHaveLength(2);
    });
    const refusals: [string, (c: ReturnType<typeof rerun>) => void][] = [
      [
        'JA step 3 not success',
        c => {
          c.ja.steps = [{ ...(c.ja.steps as object[])[0], conclusion: 'failure' }];
        },
      ],
      ['JA conclusion not success', c => (c.ja.conclusion = 'failure')],
      ['JL not success', c => (c.jl.conclusion = 'failure')],
      ['JL and JA times differ', c => (c.jl.completed_at = '2026-11-19T14:10:00Z')],
      [
        'JA times null',
        c => {
          for (const j of [c.ja, c.jl]) Object.assign(j, { started_at: null, completed_at: null });
        },
      ],
      ['two Ubuntu jobs in attempt 1', c => c.f.jobsByAttempt.set(1, [c.ja, { ...c.ja, id: 32 }])],
      ['receipt attempt 0', c => (c.f.proof.attempt = 0)],
      ['receipt attempt 3, above the latest attempt', c => (c.f.proof.attempt = 3)],
      ['receipt attempt not an integer', c => (c.f.proof.attempt = 1.5)],
    ];
    for (const [name, mutate] of refusals) {
      test(`refused: ${name}`, async () => {
        const c = rerun();
        mutate(c);
        const result = await collectBundleCoverage(c.f.read, input, producer);
        expect(result).toEqual({ diff: c.f.diff, bundleProofUnavailable: true });
      });
    }
  });

  test('BRP-4 dev drift and a workspace script edit are accepted with the base as anchor', async () => {
    const f = fixture();
    const smart = 'packages/smart-cauldron/package.json',
      workspace = 'packages/workflows/package.json';
    const before = '{"scripts":{"test":"bun test a"}}\n',
      after = '{"scripts":{"test":"bun test a b"}}\n';
    const mergeBase: Inventory = new Map(f.anchor);
    mergeBase.set('bun.lock', f.entry('lock at merge base\n'));
    mergeBase.set(smart, f.entry('{"name":"smart"}\n'));
    mergeBase.set(workspace, f.entry(before));
    // Dev (the base) moved on in bun.lock and one workspace manifest.
    f.anchor.set('bun.lock', f.entry('lock on dev\n'));
    f.anchor.set(smart, f.entry('{"name":"smart","version":"2"}\n'));
    f.anchor.set(workspace, mergeBase.get(workspace)!);
    // The head keeps the merge-base versions and edits only scripts.test.
    for (const path of ['bun.lock', smart]) f.h.set(path, mergeBase.get(path)!);
    f.h.set(workspace, f.entry(after));
    // The tested merge takes dev's versions plus the head's edit.
    for (const path of ['bun.lock', smart]) f.t.set(path, f.anchor.get(path)!);
    f.t.set(workspace, f.h.get(workspace)!);
    f.setMergeBase(mergeBase);
    f.diff += `diff --git a/${workspace} b/${workspace}\n--- a/${workspace}\n+++ b/${workspace}\n@@ -1 +1 @@\n-${before}+${after}`;
    const result = await collectBundleCoverage(f.read, input, producer);
    expect(result.coverage?.notice).toContain(`Anchor ${base};`);
    expect(result.diff).toContain('+{"scripts":{"test":"bun test a b"}}');
  });

  const preReceipt: [string, string][] = [
    ['root bun.lock', 'bun.lock'],
    ['added scripts/ci/base64.py', 'scripts/ci/base64.py'],
    ['root tsconfig.json', 'tsconfig.json'],
    ['scripts/tsconfig.json', 'scripts/tsconfig.json'],
    ['added scripts/package.json', 'scripts/package.json'],
    ['added nested .gitattributes', 'packages/workflows/.gitattributes'],
  ];
  for (const [name, path] of preReceipt) {
    test(`BRP-5 a pull-request change to a pre-receipt file is refused: ${name}`, async () => {
      const f = fixture();
      if (['bun.lock', 'tsconfig.json', 'scripts/tsconfig.json'].includes(path)) {
        // Present on the base and merge base, so this is a modification.
        const e = f.entry('{"original":true}\n');
        for (const inventory of [f.anchor, f.h, f.t]) inventory.set(path, e);
      }
      f.change(path, 'import os; os.system("forge")\n');
      const result = await collectBundleCoverage(f.read, input, producer);
      expect(result).toEqual({ diff: f.diff, bundleProofUnavailable: true });
    });
  }

  const offDev: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'base ref is not dev',
      f =>
        (f.responses['GET /repos/{owner}/{repo}/pulls/{pull_number}'].base = {
          sha: base,
          ref: 'main',
        }),
    ],
    ['base...dev diverged', f => (f.compares[`${base}...dev`] = 'diverged')],
    ['base...dev behind', f => (f.compares[`${base}...dev`] = 'behind')],
    ['producer...base behind', f => (f.compares[`${producer}...${base}`] = 'behind')],
  ];
  for (const [name, mutate] of offDev) {
    test(`BRP-6 a base that is not on dev is refused: ${name}`, async () => {
      const f = fixture();
      mutate(f);
      expect(await collectBundleCoverage(f.read, input, producer)).toEqual({
        diff: f.diff,
        bundleProofUnavailable: true,
      });
    });
  }

  test('BRP-7 D5 log rules: a valid forged line is refused beside an UNAVAILABLE or a genuine line', async () => {
    // Every field is valid for the fixture run, built the way the producer builds it.
    const forged = (f: ReturnType<typeof fixture>) => receiptLine(f.proof, true);
    const alone = fixture();
    alone.logsByJob.set(30, `${stamp} ##[group]Run tests\n${forged(alone)}`);
    // (a) Alone it validates: a receipt is authentic only by where its line came from.
    expect((await collectBundleCoverage(alone.read, input, producer)).coverage).toBeDefined();

    const unavailable = fixture();
    unavailable.logsByJob.set(
      30,
      `${stamp} BUNDLE_PROOF_UNAVAILABLE non_builtin_or_unadmitted_generator_config\n${forged(unavailable)}`
    );
    expect(await collectBundleCoverage(unavailable.read, input, producer)).toEqual({
      diff: unavailable.diff,
      bundleProofUnavailable: true,
    });

    const second = fixture();
    second.logsByJob.set(30, receiptLine(second.proof) + forged(second));
    expect(await collectBundleCoverage(second.read, input, producer)).toEqual({
      diff: second.diff,
      bundleProofUnavailable: true,
    });
  });

  const producerDrift: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      'tested workflow differs from the producer',
      f => f.t.set(workflow, f.entry('other workflow')),
    ],
    ['tested helper differs from the producer', f => f.t.set(helper, f.entry('other helper'))],
    [
      'head helper equals neither its merge base nor the producer',
      f => {
        f.change(helper, 'rogue helper\n');
        f.t.set(helper, f.p.get(helper)!);
      },
    ],
  ];
  for (const [name, mutate] of producerDrift) {
    test(`BRP-8 refused: ${name}`, async () => {
      const f = fixture();
      mutate(f);
      expect(await collectBundleCoverage(f.read, input, producer)).toEqual({
        diff: f.diff,
        bundleProofUnavailable: true,
      });
    });
  }

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
