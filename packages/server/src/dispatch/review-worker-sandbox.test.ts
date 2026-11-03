import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { RealGitHubOctokitLike } from '@archon/overseer/adapters/github-real-deps';
import { runAndSubmitReview } from '@archon/overseer/pr-review-submit';
import {
  createRealSubmitDeps,
  REVIEW_HEAD_TREE_EMPTY,
  reviewInspectionArgv,
  type ReviewRouteConfig,
} from '@archon/overseer/pr-review-wiring';
import { brokerLimits, processJob } from '../../../../scripts/overseer-reviewer-broker';
import {
  parseTrustedCheckPlan,
  prepareReviewCheckout,
  readTrustedCheckPlan,
  REVIEW_CHECK_PLAN_PATH,
  sealReviewCheckout,
  tickReviewWorkerClock,
  type ReviewWorkerDeps,
} from './review-worker-clock';

describe('trusted review check plan', () => {
  test('accepts only nonempty argv arrays', () => {
    expect(parseTrustedCheckPlan('[[' + '"bun","test"' + ']]')).toEqual({
      status: 'present',
      commands: [['bun', 'test']],
    });
    expect(parseTrustedCheckPlan('[]').status).toBe('unsafe');
    expect(parseTrustedCheckPlan('[["sh","-c","touch /tmp/pwned"]]').status).toBe('unsafe');
  });
  test('rejects malformed and NUL-bearing plans', () => {
    expect(parseTrustedCheckPlan('not-json').status).toBe('unsafe');
    expect(parseTrustedCheckPlan('[["bun","a\\u0000b"]]').status).toBe('unsafe');
  });
  test('reads only the source-controlled exact-head plan and distinguishes absence', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'review-plan-'));
    try {
      expect(await readTrustedCheckPlan(checkout)).toEqual({ status: 'absent', commands: [] });
      await mkdir(join(checkout, '.github'));
      await writeFile(join(checkout, REVIEW_CHECK_PLAN_PATH), '[["bun","test"]]');
      expect(await readTrustedCheckPlan(checkout)).toEqual({
        status: 'present',
        commands: [['bun', 'test']],
      });
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
});

test('checkout_sealed_not_group_writable and does not follow symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-seal-'));
  const checkout = join(root, 'checkout');
  const nested = join(checkout, 'nested');
  const outside = join(root, 'outside');
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'file'), 'candidate');
    await writeFile(outside, 'outside');
    await chmod(outside, 0o666);
    const outsideSize = (await lstat(outside)).size;
    await symlink(outside, join(checkout, 'outside-link'));
    await sealReviewCheckout(checkout);
    if (process.platform !== 'win32') {
      expect((await lstat(checkout)).mode & 0o022).toBe(0);
      expect((await lstat(nested)).mode & 0o022).toBe(0);
      expect((await lstat(join(nested, 'file'))).mode & 0o022).toBe(0);
      expect((await lstat(outside)).mode & 0o777).toBe(0o666);
    }
    expect((await lstat(join(checkout, 'outside-link'))).isSymbolicLink()).toBe(true);
    expect((await lstat(outside)).size).toBe(outsideSize);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('negative_probe_success_fails_closed', async () => {
  const script = "console.log('FAIL: forbidden probe succeeded'); process.exit(1)";
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).not.toBe(0);
  expect(output).toContain('FAIL: forbidden probe succeeded');
});

// ---------------------------------------------------------------------------
// Round-6 checkout regressions and S4 bounded-child regressions, driven through
// the actual preparation, worker, wiring, submit and broker callers with real
// temporary Git repositories. Model and GitHub I/O are the only fakes.
// ---------------------------------------------------------------------------

const linux = process.platform === 'linux';

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

async function gitExit(cwd: string, args: string[]): Promise<number> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  return child.exited;
}

/**
 * A remote with base B on main and PR head H (child of B). GitHub serves any
 * reachable commit by object id; uploadpack.allowAnySHA1InWant mirrors that.
 */
async function createRemote(
  root: string,
  files: Record<string, { content: string; executable?: boolean }> = {}
): Promise<{ remote: string; base: string; head: string }> {
  const remote = join(root, 'remote');
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '-b', 'main']);
  await git(remote, ['config', 'user.email', 'review@example.invalid']);
  await git(remote, ['config', 'user.name', 'review']);
  await git(remote, ['config', 'core.filemode', 'true']);
  await git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await writeFile(join(remote, 'README.md'), 'base\n');
  await git(remote, ['add', 'README.md']);
  await git(remote, ['commit', '-qm', 'base']);
  const base = await git(remote, ['rev-parse', 'HEAD']);
  await git(remote, ['checkout', '-q', '-b', 'pr']);
  for (const [name, file] of Object.entries(files)) {
    await mkdir(join(remote, name, '..'), { recursive: true });
    await writeFile(join(remote, name), file.content);
    // core.filemode=true: the worktree bit is what `git add` records as 100755.
    if (file.executable) await chmod(join(remote, name), 0o755);
    await git(remote, ['add', name]);
  }
  await writeFile(join(remote, 'change.txt'), 'pr change\n');
  await git(remote, ['add', 'change.txt']);
  await git(remote, ['commit', '-qm', 'pr head']);
  const head = await git(remote, ['rev-parse', 'HEAD']);
  await git(remote, ['checkout', '-q', 'main']);
  return { remote, base, head };
}

async function advanceBase(remote: string): Promise<string> {
  await writeFile(join(remote, 'README.md'), 'base advanced\n');
  await git(remote, ['commit', '-qam', 'base advanced']);
  return git(remote, ['rev-parse', 'HEAD']);
}

function checkoutInput(base: string, head: string) {
  return { owner: 'o', repo: 'r', prNumber: 1, headSha: head, baseRef: 'main', baseSha: base };
}

describe('round-6 exact-head checkout preparation', () => {
  test.skipIf(!linux)(
    'tracked_executable_survives_checkout_seal on fresh and cached checkouts',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'review-exec-'));
      try {
        const { remote, base, head } = await createRemote(root, {
          'scripts/run.sh': { content: '#!/bin/sh\necho ok\n', executable: true },
          'docs/plain.txt': { content: 'plain\n' },
        });
        const checkoutRoot = join(root, 'spool', 'checkouts');
        for (const pass of ['fresh', 'cached']) {
          const checkout = await prepareReviewCheckout(checkoutInput(base, head), {
            remoteUrl: remote,
            checkoutRoot,
          });
          expect(
            await gitExit(checkout, ['-c', 'core.filemode=true', 'diff', '--quiet', 'HEAD'])
          ).toBe(0);
          expect(await git(checkout, ['ls-files', '--stage', 'scripts/run.sh'])).toStartWith(
            '100755 '
          );
          const script = (await lstat(join(checkout, 'scripts/run.sh'))).mode & 0o777;
          const plain = (await lstat(join(checkout, 'docs/plain.txt'))).mode & 0o777;
          expect(script & 0o100).toBe(0o100);
          expect(script & 0o022).toBe(0);
          expect(script).toBe(0o750);
          expect(plain).toBe(0o640);
          expect((await lstat(checkout)).mode & 0o777).toBe(0o750);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  test('captured_base_survives_branch_advance and stays bound to B and H', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-base-'));
    try {
      const { remote, base, head } = await createRemote(root);
      const headTree = await git(remote, ['rev-parse', `${head}^{tree}`]);
      const advanced = await advanceBase(remote);
      expect(advanced).not.toBe(base);
      const checkout = await prepareReviewCheckout(checkoutInput(base, head), {
        remoteUrl: remote,
        checkoutRoot: join(root, 'spool', 'checkouts'),
      });
      expect(await git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
      expect(await git(checkout, ['rev-parse', 'HEAD^{tree}'])).toBe(headTree);
      expect(await gitExit(checkout, ['cat-file', '-e', `${base}^{commit}`])).toBe(0);
      // WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01: head and base are
      // fetched --depth 1, so their ancestry (merge-base) is deliberately not
      // present; what the review needs is the exact base..head diff.
      expect(await git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      expect(await git(checkout, ['diff', '--stat', base, head])).toContain('change.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('captured_base_unavailable_fails_closed for a missing or non-commit base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-base-missing-'));
    try {
      const { remote, head } = await createRemote(root);
      const blob = await git(remote, ['rev-parse', `${head}:change.txt`]);
      for (const captured of ['f'.repeat(40), blob]) {
        await expect(
          prepareReviewCheckout(checkoutInput(captured, head), {
            remoteUrl: remote,
            checkoutRoot: join(root, 'spool', 'checkouts'),
          })
        ).rejects.toThrow('review_checkout_identity_failure');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * A bdc-xo-shaped remote: `generations/` media with HISTORY (an older large
 * blob the head no longer references) plus docs the review needs. The remote
 * serves partial and by-id fetches the way GitHub does.
 */
async function createGenerationsRemote(
  root: string
): Promise<{ remote: string; base: string; head: string; oldMedia: string }> {
  const remote = join(root, 'remote');
  await mkdir(join(remote, 'generations'), { recursive: true });
  await mkdir(join(remote, 'docs'), { recursive: true });
  await git(remote, ['init', '-q', '-b', 'main']);
  await git(remote, ['config', 'user.email', 'review@example.invalid']);
  await git(remote, ['config', 'user.name', 'review']);
  await git(remote, ['config', 'core.autocrlf', 'false']);
  await git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(join(remote, 'generations', 'old.png'), 'o'.repeat(200_000));
  await writeFile(join(remote, 'docs', 'spec.md'), 'spec v1\n');
  await git(remote, ['add', '.']);
  await git(remote, ['commit', '-qm', 'history with old media']);
  const oldMedia = await git(remote, ['rev-parse', 'HEAD:generations/old.png']);
  await git(remote, ['rm', '-q', 'generations/old.png']);
  // `git rm` deletes the emptied directory; recreate it before writing.
  await mkdir(join(remote, 'generations'), { recursive: true });
  await writeFile(join(remote, 'generations', 'cover.png'), 'c'.repeat(100_000));
  await writeFile(join(remote, 'README.md'), 'base\n');
  await git(remote, ['add', '.']);
  await git(remote, ['commit', '-qm', 'base']);
  const base = await git(remote, ['rev-parse', 'HEAD']);
  await git(remote, ['checkout', '-q', '-b', 'pr']);
  await writeFile(join(remote, 'docs', 'spec.md'), 'spec v2\n');
  await writeFile(join(remote, 'generations', 'new.png'), 'n'.repeat(100_000));
  await git(remote, ['add', '.']);
  await git(remote, ['commit', '-qm', 'pr head']);
  const head = await git(remote, ['rev-parse', 'HEAD']);
  await git(remote, ['checkout', '-q', 'main']);
  return { remote, base, head, oldMedia };
}

describe('sparse and shallow review checkouts (WO-HARNESS-REVIEW-CHECKOUT-CACHE-EVICTION-01)', () => {
  const savedExcludes = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  beforeEach(() => {
    // The default (thinmansoftware/bdc-xo:generations/) is under test.
    delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  });
  afterEach(() => {
    if (savedExcludes === undefined) delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    else process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES = savedExcludes;
  });

  test('bdc-xo checkout leaves out generations/, is shallow, verifies, diffs offline and is reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-sparse-'));
    try {
      const { remote, base, head, oldMedia } = await createGenerationsRemote(root);
      const checkoutRoot = join(root, 'spool', 'checkouts');
      const input = {
        owner: 'thinmansoftware',
        repo: 'bdc-xo',
        prNumber: 4299,
        headSha: head,
        baseRef: 'main',
        baseSha: base,
      };
      const checkout = await prepareReviewCheckout(input, { remoteUrl: remote, checkoutRoot });
      expect(existsSync(join(checkout, 'generations'))).toBe(false);
      expect(readFileSync(join(checkout, 'docs', 'spec.md'), 'utf8').trim()).toBe('spec v2');
      // Tree identity is untouched by sparseness: generations/ is still in HEAD.
      expect(await git(checkout, ['ls-tree', '--name-only', 'HEAD'])).toContain('generations');
      expect(await git(checkout, ['sparse-checkout', 'list'])).toContain('!/generations/');
      expect(await git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      // protocol.allow=never forbids every transport, so no lazy (promisor)
      // fetch can mask what is local. Old history media and excluded head
      // media were never fetched.
      const offline = ['-c', 'protocol.allow=never'];
      expect(await gitExit(checkout, [...offline, 'cat-file', '-e', oldMedia])).not.toBe(0);
      expect(
        await gitExit(checkout, [...offline, 'cat-file', '-e', `${head}:generations/cover.png`])
      ).not.toBe(0);
      // Pristine (the verifier's own checks) and diffable offline.
      expect(
        await gitExit(checkout, [...offline, '-c', 'core.filemode=true', 'diff', '--quiet', 'HEAD'])
      ).toBe(0);
      expect(
        await git(checkout, [
          ...offline,
          '-c',
          'core.filemode=true',
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ])
      ).toBe('');
      const stat = await git(checkout, [...offline, 'diff', '--stat', base, head]);
      expect(stat).toContain('docs/spec.md');
      expect(stat).toContain('generations/new.png');
      // The cached checkout is reused: an unreachable remote proves no rebuild.
      const reused = await prepareReviewCheckout(input, {
        remoteUrl: join(root, 'no-such-remote'),
        checkoutRoot,
      });
      expect(reused).toBe(checkout);
      expect(
        readFileSync(join(checkoutRoot, 'thinmansoftware', 'bdc-xo', `${head}.pr`), 'utf8')
      ).toBe('4299\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('other repos keep generations/ (no sparse exclude) and still verify', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-nonsparse-'));
    try {
      const { remote, base, head } = await createGenerationsRemote(root);
      const checkout = await prepareReviewCheckout(
        {
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          prNumber: 1,
          headSha: head,
          baseRef: 'main',
          baseSha: base,
        },
        { remoteUrl: remote, checkoutRoot: join(root, 'spool', 'checkouts') }
      );
      expect(readFileSync(join(checkout, 'generations', 'new.png'), 'utf8')).toHaveLength(100_000);
      expect(readFileSync(join(checkout, 'generations', 'cover.png'), 'utf8')).toHaveLength(
        100_000
      );
      expect(await gitExit(checkout, ['sparse-checkout', 'list'])).not.toBe(0);
      expect(await git(checkout, ['rev-parse', 'HEAD'])).toBe(head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const WORKER_CONFIG: ReviewRouteConfig = {
  webhookSecret: 'secret',
  reviewerIdentity: 'thinman-overseer[bot]',
};

function queuedReview(id: string, body: Record<string, unknown>): DispatchMessage {
  return {
    id,
    correlation_id: `correlation-${id}`,
    idempotency_key: `review-${id}`,
    task_type: 'run_review',
    sender: 'overseer',
    recipient: 'overseer-reviewer',
    body: JSON.stringify(body),
    status: 'queued',
    result_body: null,
    created_at: new Date(0).toISOString(),
    claimed_at: null,
    completed_at: null,
    not_before: null,
    lease_owner: null,
    lease_expires_at: null,
    fencing_token: 0,
    recipient_alias: null,
    motion_id: null,
    motion_revision_sha: null,
    resolved_recipient: null,
    resolved_xo_lease_id: null,
    resolved_xo_fencing_token: null,
    resolved_at: null,
    priority: 'normal',
    task_outcome: null,
    acknowledged_at: null,
    acknowledged_by: null,
    addressed_at: null,
    addressed_by: null,
    escalated_tg_at: null,
    escalated_sms_at: null,
    subject_key: 'gh:o/r#1',
    route_disposition: null,
    supersedes_id: null,
    repeat_reason: null,
  } as DispatchMessage;
}

interface WorkerHarness {
  deps: ReviewWorkerDeps;
  queue: DispatchMessage[];
  posts: { event: string; body: string }[];
  results: { id: string; status?: string; task_outcome?: string; result_body?: string }[];
}

function workerHarness(input: {
  prepareCheckout: NonNullable<ReviewWorkerDeps['prepareCheckout']>;
  head: string;
}): WorkerHarness {
  const queue: DispatchMessage[] = [];
  const posts: { event: string; body: string }[] = [];
  const results: WorkerHarness['results'] = [];
  const done = new Set<string>();
  const stubOctokit = { pulls: {} } as unknown as RealGitHubOctokitLike;
  const deps: ReviewWorkerDeps = {
    registerWorker: async data =>
      ({
        ...data,
        status: 'available',
        registered_at: new Date(0).toISOString(),
        last_heartbeat_at: new Date(0).toISOString(),
      }) as Awaited<ReturnType<ReviewWorkerDeps['registerWorker']>>,
    heartbeatWorker: async data =>
      ({
        worker_id: data.worker_id,
        host: 'test',
        capabilities: {},
        max_concurrency: 1,
        status: 'available',
        registered_at: new Date(0).toISOString(),
        last_heartbeat_at: new Date(0).toISOString(),
      }) as Awaited<ReturnType<ReviewWorkerDeps['heartbeatWorker']>>,
    listMessages: async () => queue.filter(item => !done.has(item.id)),
    claimMessage: async ({ id, worker_id }) => {
      const found = queue.find(item => item.id === id);
      if (!found || done.has(id)) return null;
      return { ...found, status: 'claimed', lease_owner: worker_id, fencing_token: 3 };
    },
    postResult: async request => {
      done.add(request.id);
      results.push({
        id: request.id,
        status: request.status,
        task_outcome: request.task_outcome ?? undefined,
        result_body: request.result_body ?? undefined,
      });
      return null;
    },
    releaseMessage: async () => null,
    deferMessage: async () => null,
    runAndSubmitReview,
    prepareCheckout: input.prepareCheckout,
    // The single-writer spool lease is unit-tested in review-worker-clock.test.ts;
    // this harness is the only worker, so the lease is always granted to it.
    spoolLease: {
      acquire: async request => ({
        spool_key: request.spool_key,
        holder_id: request.holder_id,
        fencing_token: 1,
        acquired_at: new Date(0).toISOString(),
        heartbeat_at: new Date(0).toISOString(),
        expires_at: new Date(8.64e15).toISOString(),
      }),
      renew: async () => null,
      release: async () => true,
      check: async () => true,
    },
    spoolKey: 'review-spool:sandbox-test',
    createSubmitDeps: reviewerIdentity => ({
      ...createRealSubmitDeps(reviewerIdentity, {
        octokit: stubOctokit,
        patOctokit: null,
        evaluate: async () => ({
          verdict: 'APPROVE',
          findings: [],
          reviewed_head_sha: input.head,
          reviewer: { provider: 'cli', model: 'test' },
          acceptance_criteria_available: false,
        }),
      }),
      currentHeadSha: async () => input.head,
      hasCustody: async () => true,
      recordExecutionProof: async () => undefined,
      recordReceipt: async () => undefined,
      submitReview: async review => {
        posts.push({ event: review.event, body: review.body });
        return review.event === 'APPROVE'
          ? {
              submitted: true,
              review: {
                id: 1,
                url: 'https://example.invalid/1',
                commitSha: input.head,
                state: 'APPROVED',
              },
            }
          : { submitted: true };
      },
    }),
  };
  return { deps, queue, posts, results };
}

test('captured_base_unavailable_fails_closed through the worker as a review_incomplete COMMENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-worker-base-'));
  try {
    const { remote, head } = await createRemote(root);
    const harness = workerHarness({
      head,
      prepareCheckout: request =>
        prepareReviewCheckout(request, {
          remoteUrl: remote,
          checkoutRoot: join(root, 'spool', 'checkouts'),
        }),
    });
    harness.queue.push(
      queuedReview('missing-base', {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: head,
        baseRef: 'main',
        baseSha: 'e'.repeat(40),
        author: 'contributor',
      })
    );
    await tickReviewWorkerClock(WORKER_CONFIG, harness.deps);
    expect(harness.posts.map(post => post.event)).toEqual(['COMMENT']);
    expect(harness.posts[0]?.body).toStartWith(
      'Review incomplete: review_checkout_identity_failure'
    );
    expect(harness.results).toHaveLength(1);
    expect(harness.results[0]).toMatchObject({ status: 'failed', task_outcome: 'blocked' });
    expect(JSON.parse(harness.results[0]?.result_body ?? '{}').disposition).toBe(
      'review_incomplete'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * In-process stand-in for the broker LOOP only: each request is handled by the
 * real processJob (validation, identity check, minimal env, setsid group,
 * deadline and byte-bounded capture). Codex itself is not installed on the
 * test host, so the pinned `codex --version` probe answers 0.159.2 and a
 * `codex ... sandbox -- <argv>` launch runs <argv> under the same setsid
 * wrapper, env and cwd. Native Landlock enforcement is proven by Stop 7.
 */
function startProcessJobBroker(
  spool: string,
  limits: { timeoutMs: number; outputLimit: number }
): { results: Record<string, unknown>[]; stop: () => void } {
  const original = Bun.spawn;
  Bun.spawn = ((
    command: Parameters<typeof Bun.spawn>[0],
    options?: Parameters<typeof Bun.spawn>[1]
  ) => {
    const argv = Array.isArray(command) ? command.map(value => String(value)) : [];
    const codexAt = argv.findIndex(value => value.startsWith('@openai/codex@'));
    if (codexAt !== -1) {
      const prefix = argv[0] === 'setsid' ? ['setsid', '--'] : [];
      if (argv.includes('--version')) {
        return original(
          [...prefix, process.execPath, '-e', "process.stdout.write('codex-cli 0.159.2\\n')"],
          options
        );
      }
      const dash = argv.lastIndexOf('--');
      if (argv.includes('sandbox') && dash > codexAt) {
        return original([...prefix, ...argv.slice(dash + 1)], options);
      }
    }
    return original(command, options);
  }) as typeof Bun.spawn;
  const results: Record<string, unknown>[] = [];
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const requests = (await readdir(spool)).filter(name => name.endsWith('.request.json'));
      for (const name of requests) {
        const result = await processJob(join(spool, name), spool, limits);
        results.push(result as unknown as Record<string, unknown>);
        await writeFile(join(spool, `${result.id}.result.json`), JSON.stringify(result));
        await rm(join(spool, name), { force: true });
      }
    } finally {
      busy = false;
    }
  }, 10);
  return {
    results,
    stop() {
      clearInterval(timer);
      Bun.spawn = original;
    },
  };
}

function processAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

async function runBoundedCheckReview(input: {
  root: string;
  plan: string[][];
  limits: { timeoutMs: number; outputLimit: number };
}): Promise<{ harness: WorkerHarness; brokerResults: Record<string, unknown>[] }> {
  const spool = join(input.root, 'spool');
  await mkdir(spool, { recursive: true });
  await writeFile(join(spool, 'ready'), 'test\n');
  const { remote, base, head } = await createRemote(input.root, {
    '.github/overseer-review-check-plan.json': { content: JSON.stringify(input.plan) },
  });
  const previousSpool = process.env.OVERSEER_REVIEW_SPOOL;
  process.env.OVERSEER_REVIEW_SPOOL = spool;
  const broker = startProcessJobBroker(spool, input.limits);
  try {
    const harness = workerHarness({
      head,
      prepareCheckout: request =>
        prepareReviewCheckout(request, {
          remoteUrl: remote,
          checkoutRoot: join(spool, 'checkouts'),
        }),
    });
    harness.queue.push(
      queuedReview('bounded', {
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: head,
        baseRef: 'main',
        baseSha: base,
        author: 'contributor',
      })
    );
    await tickReviewWorkerClock(WORKER_CONFIG, harness.deps);
    // The worker is released: the next queued request is taken on the next tick.
    harness.queue.push(queuedReview('next', { not: 'a review body' }));
    await tickReviewWorkerClock(WORKER_CONFIG, harness.deps);
    return { harness, brokerResults: broker.results };
  } finally {
    broker.stop();
    if (previousSpool === undefined) delete process.env.OVERSEER_REVIEW_SPOOL;
    else process.env.OVERSEER_REVIEW_SPOOL = previousSpool;
  }
}

describe.serial('untrusted check children are bounded through worker, wiring and broker', () => {
  test.skipIf(!linux)(
    'untrusted_check_deadline_kills_tree and releases the worker',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'review-deadline-'));
      const pidFile = join(root, 'descendant.pid');
      const script = [
        "const child = Bun.spawn(['sleep', '300']);",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'setInterval(() => {}, 1000);',
      ].join(' ');
      try {
        const started = Date.now();
        const { harness, brokerResults } = await runBoundedCheckReview({
          root,
          plan: [[process.execPath, '-e', script]],
          limits: { timeoutMs: 2_000, outputLimit: 128 * 1024 },
        });
        expect(Date.now() - started).toBeLessThan(30_000);
        const checkResult = brokerResults.find(result => result.timedOut === true);
        expect(checkResult?.ok).toBe(false);
        expect(checkResult?.reason).toBe('execution_timeout');
        const descendant = Number(readFileSync(pidFile, 'utf8'));
        expect(descendant).toBeGreaterThan(0);
        for (let attempt = 0; attempt < 40 && processAlive(descendant); attempt += 1) {
          await Bun.sleep(50);
        }
        expect(processAlive(descendant)).toBe(false);
        expect(harness.posts.map(post => post.event)).toEqual(['COMMENT']);
        expect(harness.posts[0]?.body).toStartWith(
          'Review incomplete: untrusted_check_deadline_exceeded'
        );
        expect(harness.results.map(result => result.id)).toEqual(['bounded', 'next']);
        expect(harness.results[0]).toMatchObject({ status: 'failed', task_outcome: 'blocked' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000
  );

  test.skipIf(!linux)(
    'untrusted_check_output_bounded in bytes for a multibyte flood',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'review-flood-'));
      const limit = 4096;
      // Two-byte UTF-8 characters, written forever. Escaped to keep source ASCII.
      const script = "const s = '\\u00e9'.repeat(65536); for (;;) process.stdout.write(s);";
      try {
        const { harness, brokerResults } = await runBoundedCheckReview({
          root,
          plan: [[process.execPath, '-e', script]],
          limits: { timeoutMs: 10_000, outputLimit: limit },
        });
        const checkResult = brokerResults.find(result => result.outputTruncated === true);
        expect(checkResult?.ok).toBe(false);
        expect(checkResult?.timedOut).toBe(false);
        const retained =
          Buffer.byteLength(String(checkResult?.stdout ?? ''), 'utf8') +
          Buffer.byteLength(String(checkResult?.stderr ?? ''), 'utf8');
        expect(retained).toBeGreaterThan(0);
        expect(retained).toBeLessThanOrEqual(limit);
        expect(harness.posts.map(post => post.event)).toEqual(['COMMENT']);
        expect(harness.posts[0]?.body).toStartWith(
          'Review incomplete: untrusted_check_output_limit_exceeded'
        );
        expect(harness.results[0]).toMatchObject({ status: 'failed', task_outcome: 'blocked' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000
  );
});

// ---------------------------------------------------------------------------
// WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01: the supervisor inspection must
// succeed offline on the shallow, blob-filtered, sparse checkouts the preparer
// builds. Live: bdc-xo PR 4330 ended "Review incomplete:
// sandbox_execution_proof_missing_or_invalid" because `git show --stat <head>`
// needed blobs the sandbox could not fetch from the promisor remote.
// ---------------------------------------------------------------------------

/** The pre-fix inspection argv, kept here only to document the regression. */
function oldShowStatArgv(headSha: string): string[] {
  return [
    'git',
    '-c',
    'diff.external=',
    '-c',
    'core.fsmonitor=false',
    'show',
    '--stat',
    '--oneline',
    headSha,
  ];
}

async function runArgv(cwd: string, argv: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout };
}

/**
 * Point the checkout's promisor remote at a path that does not exist, so no
 * lazy blob fetch can succeed -- the condition inside the no-network sandbox.
 * (Re-pointing instead of renaming the remote avoids Windows EPERM on rename.)
 */
async function makePromisorUnreachable(checkout: string, root: string): Promise<void> {
  await git(checkout, ['remote', 'set-url', 'origin', join(root, 'unreachable-remote')]);
}

/** A real bdc-xo-shaped review checkout whose remote is then made unreachable. */
async function prepareOfflineSparseCheckout(
  root: string
): Promise<{ checkout: string; head: string }> {
  const { remote, base, head } = await createGenerationsRemote(root);
  const checkout = await prepareReviewCheckout(
    {
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 4330,
      headSha: head,
      baseRef: 'main',
      baseSha: base,
    },
    { remoteUrl: remote, checkoutRoot: join(root, 'spool', 'checkouts') }
  );
  await makePromisorUnreachable(checkout, root);
  return { checkout, head };
}

describe('review inspection on shallow sparse checkouts (WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01)', () => {
  const savedExcludes = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  beforeEach(() => {
    delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  });
  afterEach(() => {
    if (savedExcludes === undefined) delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    else process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES = savedExcludes;
  });

  test('inspection_succeeds_on_shallow_sparse_checkout_offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-inspect-sparse-'));
    try {
      const { checkout, head } = await prepareOfflineSparseCheckout(root);
      expect(await git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      expect(await git(checkout, ['config', 'remote.origin.partialclonefilter'])).toBe('blob:none');
      expect(existsSync(join(checkout, 'generations'))).toBe(false);
      const result = await runArgv(checkout, reviewInspectionArgv(head));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      // Top-level entries only (non-recursive, bounded output).
      expect(result.stdout.split('\n')).toContain('docs');
      expect(result.stdout).not.toContain('docs/spec.md');
      // Outside the sparse worktree and never fetched: listed from the tree alone.
      expect(result.stdout.split('\n')).toContain('generations');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('old_show_stat_inspection_fails_on_the_same_checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-inspect-old-'));
    try {
      const { checkout, head } = await prepareOfflineSparseCheckout(root);
      const result = await runArgv(checkout, oldShowStatArgv(head));
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('inspection_still_succeeds_on_a_full_checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-inspect-full-'));
    try {
      const { remote, head } = await createRemote(root);
      const checkout = join(root, 'full');
      await git(root, ['clone', '-q', '--no-checkout', remote, checkout]);
      await git(checkout, ['checkout', '-q', '--detach', head]);
      expect(await git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('false');
      const result = await runArgv(checkout, reviewInspectionArgv(head));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('change.txt');
      expect(result.stdout).toContain('README.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * One review through the real worker, preparer, wiring, submit and processJob
 * broker on an offline bdc-xo-shaped checkout. `inspection: 'show-stat'`
 * rewrites the inspection child back to the pre-fix argv so the same path
 * shows what the old inspection produced.
 */
async function runOfflineShallowReview(input: {
  root: string;
  inspection: 'current' | 'show-stat' | 'recursive';
  createFixture?: (root: string) => Promise<{ remote: string; base: string; head: string }>;
  outputLimit?: number;
}): Promise<WorkerHarness & { brokerResults: Record<string, unknown>[] }> {
  const spool = join(input.root, 'spool');
  await mkdir(spool, { recursive: true });
  await writeFile(join(spool, 'ready'), 'test\n');
  const { remote, base, head } = await (input.createFixture ?? createGenerationsRemote)(input.root);
  let offline = false;
  const original = Bun.spawn;
  Bun.spawn = ((
    command: Parameters<typeof Bun.spawn>[0],
    options?: Parameters<typeof Bun.spawn>[1]
  ) => {
    if (offline && input.inspection !== 'current' && Array.isArray(command)) {
      const argv = command.map(value => String(value));
      const at = argv.indexOf('ls-tree');
      if (at !== -1) {
        const headSha = argv[argv.length - 1] ?? '';
        const old =
          input.inspection === 'show-stat'
            ? ['show', '--stat', '--oneline', headSha]
            : ['ls-tree', '-r', '--name-only', headSha];
        return original([...argv.slice(0, at), ...old], options);
      }
    }
    return original(command, options);
  }) as typeof Bun.spawn;
  const previousSpool = process.env.OVERSEER_REVIEW_SPOOL;
  process.env.OVERSEER_REVIEW_SPOOL = spool;
  const broker = startProcessJobBroker(spool, {
    timeoutMs: 20_000,
    outputLimit: input.outputLimit ?? 1024 * 1024,
  });
  try {
    const harness = workerHarness({
      head,
      prepareCheckout: async request => {
        const checkout = await prepareReviewCheckout(request, {
          remoteUrl: remote,
          checkoutRoot: join(spool, 'checkouts'),
        });
        await makePromisorUnreachable(checkout, input.root);
        offline = true;
        return checkout;
      },
    });
    harness.queue.push(
      queuedReview('offline-shallow', {
        owner: 'thinmansoftware',
        repo: 'bdc-xo',
        prNumber: 4330,
        headSha: head,
        baseRef: 'main',
        baseSha: base,
        author: 'contributor',
      })
    );
    await tickReviewWorkerClock(WORKER_CONFIG, harness.deps);
    return { ...harness, brokerResults: broker.results };
  } finally {
    broker.stop();
    Bun.spawn = original;
    if (previousSpool === undefined) delete process.env.OVERSEER_REVIEW_SPOOL;
    else process.env.OVERSEER_REVIEW_SPOOL = previousSpool;
  }
}

describe.serial(
  'offline shallow review qualifies end to end (WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01)',
  () => {
    const savedExcludes = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    beforeEach(() => {
      delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    });
    afterEach(() => {
      if (savedExcludes === undefined) delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
      else process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES = savedExcludes;
    });

    test.skipIf(!linux)(
      'worker_review_of_offline_shallow_checkout_qualifies_with_new_inspection_and_not_old',
      async () => {
        const current = await mkdtemp(join(tmpdir(), 'review-offline-current-'));
        const old = await mkdtemp(join(tmpdir(), 'review-offline-old-'));
        try {
          const fixed = await runOfflineShallowReview({ root: current, inspection: 'current' });
          expect(fixed.posts.map(post => post.event)).toEqual(['APPROVE']);
          const before = await runOfflineShallowReview({ root: old, inspection: 'show-stat' });
          expect(before.posts.map(post => post.event)).toEqual(['COMMENT']);
          expect(before.posts[0]?.body).toStartWith(
            'Review incomplete: sandbox_execution_proof_missing_or_invalid'
          );
        } finally {
          await rm(current, { recursive: true, force: true });
          await rm(old, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);

// ---------------------------------------------------------------------------
// WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01 amendment (2026-11-03): the
// inspection must stay NON-RECURSIVE. The broker keeps at most 128 KiB of a
// check job's output and kills the job past it. Live: the recursive listing
// of bdc-xo is 7,167 paths = 442,357 bytes, so PR 4330 at head fb091356 ended
// "Review incomplete: sandbox_execution_proof_missing_or_invalid".
// ---------------------------------------------------------------------------

/** The broker's default check-job output cap (OUTPUT_LIMIT, 128 KiB). */
const BROKER_CHECK_OUTPUT_LIMIT = brokerLimits({}).outputLimit;

/** Enough long nested paths that a recursive listing exceeds the broker cap. */
const LARGE_TREE_FILES = 3_200;

/** The pre-amendment recursive inspection argv, kept to document the regression. */
function recursiveLsTreeArgv(headSha: string): string[] {
  return [
    'git',
    '-c',
    'diff.external=',
    '-c',
    'core.fsmonitor=false',
    'ls-tree',
    '-r',
    '--name-only',
    headSha,
  ];
}

async function gitWithStdin(cwd: string, args: string[], input: string): Promise<string> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(input);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

/** A partial-clone-capable remote with base B (README.md only) on main. */
async function initBaseRemote(root: string): Promise<{ remote: string; base: string }> {
  const remote = join(root, 'remote');
  await mkdir(remote, { recursive: true });
  await git(remote, ['init', '-q', '-b', 'main']);
  await git(remote, ['config', 'user.email', 'review@example.invalid']);
  await git(remote, ['config', 'user.name', 'review']);
  await git(remote, ['config', 'core.autocrlf', 'false']);
  await git(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  await writeFile(join(remote, 'README.md'), 'base\n');
  await git(remote, ['add', 'README.md']);
  await git(remote, ['commit', '-qm', 'base']);
  return { remote, base: await git(remote, ['rev-parse', 'HEAD']) };
}

/**
 * PR head H adds LARGE_TREE_FILES long nested paths (one shared blob, so the
 * fixture is fast) whose recursive name listing is well over the broker cap.
 */
async function createLargeTreeRemote(
  root: string
): Promise<{ remote: string; base: string; head: string }> {
  const { remote, base } = await initBaseRemote(root);
  const blob = await gitWithStdin(remote, ['hash-object', '-w', '--stdin'], 'shared\n');
  const lines: string[] = [];
  for (let index = 0; index < LARGE_TREE_FILES; index += 1) {
    const module = String(index % 40).padStart(2, '0');
    const name = String(index).padStart(5, '0');
    lines.push(
      `100644 ${blob}\tdeeply/nested/module-${module}/component-with-a-deliberately-long-file-name-${name}.md`
    );
  }
  await gitWithStdin(remote, ['update-index', '--index-info'], `${lines.join('\n')}\n`);
  const tree = await git(remote, ['write-tree']);
  const head = await git(remote, ['commit-tree', tree, '-p', base, '-m', 'large pr head']);
  await git(remote, ['update-ref', 'refs/heads/pr', head]);
  await git(remote, ['read-tree', 'HEAD']);
  return { remote, base, head };
}

/** PR head H is a commit whose tree is git's empty tree (made from an empty index). */
async function createEmptyTreeRemote(
  root: string
): Promise<{ remote: string; base: string; head: string }> {
  const { remote, base } = await initBaseRemote(root);
  const tree = await gitWithStdin(remote, ['mktree'], '');
  expect(tree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const head = await git(remote, ['commit-tree', tree, '-p', base, '-m', 'empty pr head']);
  await git(remote, ['update-ref', 'refs/heads/pr', head]);
  return { remote, base, head };
}

async function prepareOfflineCheckoutFrom(
  root: string,
  fixture: { remote: string; base: string; head: string }
): Promise<string> {
  const checkout = await prepareReviewCheckout(
    {
      owner: 'thinmansoftware',
      repo: 'bdc-xo',
      prNumber: 4330,
      headSha: fixture.head,
      baseRef: 'main',
      baseSha: fixture.base,
    },
    { remoteUrl: fixture.remote, checkoutRoot: join(root, 'spool', 'checkouts') }
  );
  await makePromisorUnreachable(checkout, root);
  return checkout;
}

/**
 * The preparer's exact fetch (`--depth 1 --filter=blob:none` of head and base)
 * without a worktree checkout, so thousands of fixture files are never
 * written (Windows rename of a large fresh tree can hit EPERM). ls-tree needs
 * only tree objects, so the inspection runs here exactly as in a checkout.
 */
async function shallowBlobFreeFetch(
  root: string,
  fixture: { remote: string; base: string; head: string }
): Promise<string> {
  const checkout = join(root, 'shallow');
  await mkdir(checkout, { recursive: true });
  await git(checkout, ['init', '-q']);
  await git(checkout, ['remote', 'add', 'origin', fixture.remote]);
  await git(checkout, [
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    '--depth',
    '1',
    '--filter=blob:none',
    'origin',
    fixture.head,
    fixture.base,
  ]);
  await makePromisorUnreachable(checkout, root);
  return checkout;
}

describe('review inspection output stays under the broker cap (WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01 amendment)', () => {
  const savedExcludes = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  beforeEach(() => {
    delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
  });
  afterEach(() => {
    if (savedExcludes === undefined) delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    else process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES = savedExcludes;
  });

  test('inspection_is_non_recursive', () => {
    const argv = reviewInspectionArgv('a'.repeat(40));
    expect(argv).toContain('ls-tree');
    expect(argv).toContain('--name-only');
    expect(argv).not.toContain('-r');
    expect(argv[argv.length - 1]).toBe('a'.repeat(40));
  });

  test('inspection_output_bounded_on_large_tree while the recursive listing exceeds the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-inspect-large-'));
    try {
      const fixture = await createLargeTreeRemote(root);
      const checkout = await shallowBlobFreeFetch(root, fixture);
      expect(await git(checkout, ['rev-parse', '--is-shallow-repository'])).toBe('true');
      expect(await git(checkout, ['config', 'remote.origin.partialclonefilter'])).toBe('blob:none');
      const fixed = await runArgv(checkout, reviewInspectionArgv(fixture.head));
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout.trim().length).toBeGreaterThan(0);
      expect(fixed.stdout).toContain('README.md');
      expect(fixed.stdout).toContain('deeply');
      expect(Buffer.byteLength(fixed.stdout, 'utf8')).toBeLessThan(BROKER_CHECK_OUTPUT_LIMIT);
      const recursive = await runArgv(checkout, recursiveLsTreeArgv(fixture.head));
      expect(recursive.exitCode).toBe(0);
      expect(Buffer.byteLength(recursive.stdout, 'utf8')).toBeGreaterThan(
        BROKER_CHECK_OUTPUT_LIMIT
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('inspection_prints_nothing_for_an_empty_tree_head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-inspect-empty-'));
    try {
      const fixture = await createEmptyTreeRemote(root);
      const checkout = await prepareOfflineCheckoutFrom(root, fixture);
      expect(await git(checkout, ['rev-parse', 'HEAD^{tree}'])).toBe(
        '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
      );
      const result = await runArgv(checkout, reviewInspectionArgv(fixture.head));
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.serial(
  'large-tree and empty-tree reviews through the real broker (WO-HARNESS-REVIEW-PROOF-SHALLOW-CHECKOUT-01 amendment)',
  () => {
    const savedExcludes = process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    beforeEach(() => {
      delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
    });
    afterEach(() => {
      if (savedExcludes === undefined) delete process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES;
      else process.env.OVERSEER_REVIEW_SPARSE_EXCLUDES = savedExcludes;
    });

    test.skipIf(!linux)(
      'worker_review_of_large_tree_qualifies_under_the_broker_cap_and_recursive_is_truncated',
      async () => {
        const current = await mkdtemp(join(tmpdir(), 'review-large-current-'));
        const old = await mkdtemp(join(tmpdir(), 'review-large-old-'));
        try {
          const fixed = await runOfflineShallowReview({
            root: current,
            inspection: 'current',
            createFixture: createLargeTreeRemote,
            outputLimit: BROKER_CHECK_OUTPUT_LIMIT,
          });
          expect(fixed.posts.map(post => post.event)).toEqual(['APPROVE']);
          expect(fixed.brokerResults.some(result => result.outputTruncated === true)).toBe(false);
          const before = await runOfflineShallowReview({
            root: old,
            inspection: 'recursive',
            createFixture: createLargeTreeRemote,
            outputLimit: BROKER_CHECK_OUTPUT_LIMIT,
          });
          const truncated = before.brokerResults.find(result => result.outputTruncated === true);
          expect(truncated?.ok).toBe(false);
          expect(before.posts.map(post => post.event)).toEqual(['COMMENT']);
          expect(before.posts[0]?.body).toStartWith(
            'Review incomplete: sandbox_execution_proof_missing_or_invalid'
          );
        } finally {
          await rm(current, { recursive: true, force: true });
          await rm(old, { recursive: true, force: true });
        }
      },
      120_000
    );

    test.skipIf(!linux)(
      'worker_review_of_empty_tree_head_fails_loudly_with_review_head_tree_empty',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'review-empty-tree-'));
        try {
          const harness = await runOfflineShallowReview({
            root,
            inspection: 'current',
            createFixture: createEmptyTreeRemote,
            outputLimit: BROKER_CHECK_OUTPUT_LIMIT,
          });
          expect(harness.posts.map(post => post.event)).toEqual(['COMMENT']);
          expect(harness.posts[0]?.body).toStartWith(
            `Review incomplete: ${REVIEW_HEAD_TREE_EMPTY}`
          );
          expect(harness.posts[0]?.body).not.toContain(
            'sandbox_execution_proof_missing_or_invalid'
          );
          expect(harness.results[0]).toMatchObject({ status: 'failed', task_outcome: 'blocked' });
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      60_000
    );
  }
);
