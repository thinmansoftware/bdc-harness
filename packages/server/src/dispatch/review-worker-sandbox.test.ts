import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatchMessage } from '@archon/core/db/dispatch';
import type { RealGitHubOctokitLike } from '@archon/overseer/adapters/github-real-deps';
import { runAndSubmitReview } from '@archon/overseer/pr-review-submit';
import { createRealSubmitDeps, type ReviewRouteConfig } from '@archon/overseer/pr-review-wiring';
import { processJob } from '../../../../scripts/overseer-reviewer-broker';
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
      expect(await git(checkout, ['merge-base', head, base])).toBe(base);
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
