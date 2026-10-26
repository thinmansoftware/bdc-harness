import { describe, expect, test } from 'bun:test';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RealGitHubOctokitLike } from '../adapters/github-real-deps';
import { createRealSubmitDeps, observeReviewExecution } from '../pr-review-wiring';
import { buildPrReviewTransport } from '../judge-transport';
import { runBrokerProcess } from '../../../../scripts/overseer-reviewer-broker';
import {
  runAndSubmitReview,
  type ReviewExecutionContext,
  type ReviewExecutionProof,
  type ReviewWorkItem,
  type SubmitDeps,
} from '../pr-review-submit';

const head = 'a'.repeat(40);
const context = {
  requestId: 'request-1',
  workerId: 'worker-1',
  fencingToken: 7,
  owner: 'o',
  repo: 'r',
  prNumber: 1,
  headSha: head,
  checkoutPath: '/tmp/checkout',
  reviewerIdentity: 'bot',
  rung: 'pr-review',
  checkPlan: [['bun', 'test']] as const,
};
const proof: ReviewExecutionProof = {
  requestId: 'request-1',
  headSha: head,
  treeSha: 'b'.repeat(40),
  cwd: '/tmp/checkout',
  nativePolicy: 'codex_legacy_landlock',
  nativeVersion: '0.153.3',
  runtimeUid: 1001,
  inspectionObserved: true,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  checks: [
    {
      argv: ['bun', 'test'],
      cwd: '/tmp/checkout',
      exitCode: 0,
      outputDigest: 'sha256:ok',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
    },
  ],
};
const work: ReviewWorkItem = {
  correlationId: 'c',
  messageId: 'request-1',
  owner: 'o',
  repo: 'r',
  prNumber: 1,
  headSha: head,
  author: 'author',
  executionContext: context,
};

function deps(executionProof?: ReviewExecutionProof): {
  value: SubmitDeps;
  posts: string[];
  receipts: string[];
} {
  const posts: string[] = [];
  const receipts: string[] = [];
  return {
    posts,
    receipts,
    value: {
      reviewerIdentity: 'bot',
      runReviewer: async () => ({
        approved: true,
        summary: 'ok',
        reviewedHeadSha: head,
        executionProof,
      }),
      currentHeadSha: async () => head,
      hasCustody: async () => true,
      recordExecutionProof: async ({ proof }) => {
        receipts.push(`proof:${proof.requestId}`);
      },
      submitReview: async input => {
        posts.push(input.event);
        return input.event === 'APPROVE'
          ? {
              submitted: true,
              review: {
                id: 9,
                url: 'https://example.invalid/9',
                commitSha: head,
                state: 'APPROVED',
              },
            }
          : { submitted: true };
      },
      recordReceipt: async input => {
        receipts.push(input.disposition);
      },
    },
  };
}

describe('sandbox-qualified submit', () => {
  test('PR transport disables model-side web retrieval with the pinned supported setting', async () => {
    const transport = await buildPrReviewTransport('codex', 'review', {
      kind: 'pr-review',
      cwd: '/tmp/checkout',
      expectedHeadSha: head,
      nativePolicy: 'codex_legacy_landlock',
    });
    expect(transport.argv).toContain('web_search="disabled"');
    expect(transport.argv).toContain('--json');
  });
  test('durable exact-head proof permits one approval with response identity', async () => {
    const d = deps(proof);
    const result = await runAndSubmitReview(work, d.value);
    expect(result.disposition).toBe('approved');
    expect(d.posts).toEqual(['APPROVE']);
    expect(result.githubReview?.id).toBe(9);
    expect(d.receipts).toEqual(['proof:request-1', 'approved']);
  });
  test('model approval without supervisor proof becomes review_incomplete comment', async () => {
    const d = deps();
    const result = await runAndSubmitReview(work, d.value);
    expect(result.disposition).toBe('review_incomplete');
    expect(d.posts).toEqual(['COMMENT']);
    expect(result.summary?.startsWith('Review incomplete:')).toBe(true);
  });
  test('credential-shaped review body fails closed before approval', async () => {
    const d = deps(proof);
    d.value.runReviewer = async () => ({
      approved: true,
      summary: `leaked ghp_${'x'.repeat(32)}`,
      reviewedHeadSha: head,
      executionProof: proof,
    });
    const result = await runAndSubmitReview(work, d.value);
    expect(result.disposition).toBe('review_incomplete');
    expect(result.reason).toBe('review_body_credential_leak');
    expect(d.posts).toEqual(['COMMENT']);
  });
});

describe('bounded broker process capture', () => {
  test('terminates a hanging descendant within the deadline', async () => {
    const started = Date.now();
    const result = await runBrokerProcess(
      ['/bin/sh', '-c', '(sleep 30) & exit 0'],
      process.cwd(),
      { PATH: '/usr/bin:/bin' },
      undefined,
      { timeoutMs: 100 }
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('bounds an output flood and makes it nonqualifying', async () => {
    const result = await runBrokerProcess(
      ['/bin/sh', '-c', 'yes x | head -c 1048576'],
      process.cwd(),
      { PATH: '/usr/bin:/bin' },
      undefined,
      { timeoutMs: 2_000, outputLimit: 1024 }
    );
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(1024);
  });
});

const CANARIES: Record<string, string> = {
  BDC_REVIEW_CANARY: 'canary-bdc-review',
  GH_TOKEN: 'canary-gh-token',
  GITHUB_TOKEN: 'canary-github-token',
  OPENAI_API_KEY: 'canary-openai',
  GITHUB_APP_PRIVATE_KEY: 'canary-app-key',
  OVERSEER_REVIEW_WEBHOOK_SECRET: 'canary-webhook',
};

/**
 * Test simulation, not native enforcement. Real git still runs. A
 * `codex ... sandbox --` spawn is replaced by its inner argv, using that
 * spawn's exact env and cwd, so caller tests can observe checkout mutation.
 */
function installSandboxSimulation(simulate: boolean): {
  sandboxSpawns: { argv: string[]; env: Record<string, string> }[];
  restore: () => void;
} {
  const original = Bun.spawn;
  const sandboxSpawns: { argv: string[]; env: Record<string, string> }[] = [];
  const wrapped = ((
    command: Parameters<typeof Bun.spawn>[0],
    options?: Parameters<typeof Bun.spawn>[1]
  ) => {
    const argv = Array.isArray(command) ? command.map(value => String(value)) : [];
    const dash = argv.lastIndexOf('--');
    const sandboxAt = argv.indexOf('sandbox');
    const isCodexSandbox =
      sandboxAt !== -1 && dash > sandboxAt && argv.some(value => value.includes('codex'));
    if (isCodexSandbox) {
      const rawEnv = options && 'env' in options ? options.env : undefined;
      const env: Record<string, string> = {};
      if (rawEnv) {
        for (const [key, value] of Object.entries(rawEnv)) {
          if (typeof value === 'string') env[key] = value;
        }
      }
      sandboxSpawns.push({ argv, env });
      if (simulate) {
        const inner = argv.slice(dash + 1);
        return original(inner as Parameters<typeof Bun.spawn>[0], options);
      }
    }
    return original(command, options);
  }) as typeof Bun.spawn;
  Bun.spawn = wrapped;
  return {
    sandboxSpawns,
    restore() {
      Bun.spawn = original;
    },
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

async function initCheckout(): Promise<{ dir: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'overseer-review-checkout-'));
  await runGit(dir, ['init', '-q']);
  await runGit(dir, ['config', 'user.email', 'smoke@example.invalid']);
  await runGit(dir, ['config', 'user.name', 'smoke']);
  await writeFile(join(dir, 'allowed.txt'), 'allowed\n');
  await runGit(dir, ['add', 'allowed.txt']);
  await runGit(dir, ['commit', '-qm', 'fixture']);
  return { dir, head: await runGit(dir, ['rev-parse', 'HEAD']) };
}

function approveResult(headSha: string): {
  verdict: 'APPROVE';
  findings: [];
  reviewed_head_sha: string;
  reviewer: { provider: string; model: string };
  acceptance_criteria_available: false;
} {
  return {
    verdict: 'APPROVE',
    findings: [],
    reviewed_head_sha: headSha,
    reviewer: { provider: 'cli', model: 'test' },
    acceptance_criteria_available: false,
  };
}

const stubOctokit = { pulls: {} } as unknown as RealGitHubOctokitLike;

async function startFakeBroker(): Promise<{ stop: () => Promise<void> }> {
  const spool = await mkdtemp(join(tmpdir(), 'overseer-review-spool-'));
  await writeFile(join(spool, 'ready'), 'test\n');
  const previous = process.env.OVERSEER_REVIEW_SPOOL;
  process.env.OVERSEER_REVIEW_SPOOL = spool;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const requests = (await readdir(spool)).filter(name => name.endsWith('.request.json'));
      for (const name of requests) {
        const job = JSON.parse(await readFile(join(spool, name), 'utf8')) as {
          id: string;
          checkout: string;
          argv: string[];
          prompt?: string;
        };
        let exitCode = 0;
        let stdout = '';
        let stderr = '';
        if (job.prompt === undefined) {
          const child = Bun.spawn(job.argv, {
            cwd: job.checkout,
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: spool, TMPDIR: spool },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
        }
        await writeFile(
          join(spool, `${job.id}.result.json`),
          JSON.stringify({ id: job.id, ok: exitCode === 0, exitCode, stdout, stderr, uid: 1002 })
        );
        await rm(join(spool, name), { force: true });
      }
    } finally {
      busy = false;
    }
  }, 5);
  return {
    async stop() {
      clearInterval(timer);
      if (previous === undefined) delete process.env.OVERSEER_REVIEW_SPOOL;
      else process.env.OVERSEER_REVIEW_SPOOL = previous;
      await rm(spool, { recursive: true, force: true });
    },
  };
}

async function reviewObservedCheckout(input: {
  dir: string;
  head: string;
  checkPlan: ReadonlyArray<readonly string[]>;
  evaluate?: () => Promise<ReturnType<typeof approveResult>>;
  broker?: boolean;
}): Promise<{ disposition: string; posts: string[]; proofRecords: number; evaluated: boolean }> {
  const broker = input.broker === false ? undefined : await startFakeBroker();
  const posts: string[] = [];
  let proofRecords = 0;
  let evaluated = false;
  const executionContext: ReviewExecutionContext = {
    requestId: 'request-1',
    workerId: 'worker-1',
    fencingToken: 7,
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    headSha: input.head,
    checkoutPath: input.dir,
    reviewerIdentity: 'bot',
    rung: 'pr-review',
    checkPlan: input.checkPlan,
  };
  const item: ReviewWorkItem = {
    correlationId: 'c',
    messageId: 'request-1',
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    headSha: input.head,
    author: 'author',
    executionContext,
  };
  const wired = createRealSubmitDeps('bot', {
    octokit: stubOctokit,
    patOctokit: null,
    evaluate: async () => {
      evaluated = true;
      return input.evaluate ? input.evaluate() : approveResult(input.head);
    },
  });
  try {
    const result = await runAndSubmitReview(item, {
      ...wired,
      currentHeadSha: async () => input.head,
      hasCustody: async () => true,
      recordExecutionProof: async () => {
        proofRecords += 1;
      },
      submitReview: async review => {
        posts.push(review.event);
        return review.event === 'APPROVE'
          ? {
              submitted: true,
              review: {
                id: 9,
                url: 'https://example.invalid/9',
                commitSha: input.head,
                state: 'APPROVED',
              },
            }
          : { submitted: true };
      },
      recordReceipt: async () => undefined,
    });
    return { disposition: result.disposition, posts, proofRecords, evaluated };
  } finally {
    await broker?.stop();
  }
}

describe.serial('observed checkout integrity and check environment', () => {
  test('reviewer_broker_unavailable fails closed with a Review incomplete comment', async () => {
    const checkout = await initCheckout();
    const previous = process.env.OVERSEER_REVIEW_SPOOL;
    process.env.OVERSEER_REVIEW_SPOOL = join(checkout.dir, 'missing-spool');
    try {
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head: checkout.head,
        checkPlan: [['/usr/bin/true']],
        broker: false,
      });
      expect(result.evaluated).toBe(false);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      if (previous === undefined) delete process.env.OVERSEER_REVIEW_SPOOL;
      else process.env.OVERSEER_REVIEW_SPOOL = previous;
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('tracked modification prevents sandbox spawn and approval', async () => {
    const checkout = await initCheckout();
    const tracker = installSandboxSimulation(false);
    try {
      await writeFile(join(checkout.dir, 'allowed.txt'), 'changed\n');
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head: checkout.head,
        checkPlan: [['/usr/bin/true']],
      });
      expect(tracker.sandboxSpawns).toHaveLength(0);
      expect(result.evaluated).toBe(false);
      expect(result.proofRecords).toBe(0);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      tracker.restore();
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('untracked file prevents sandbox spawn and approval', async () => {
    const checkout = await initCheckout();
    const tracker = installSandboxSimulation(false);
    try {
      await writeFile(join(checkout.dir, 'injected.ts'), 'console.log(1)\n');
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head: checkout.head,
        checkPlan: [['/usr/bin/true']],
      });
      expect(tracker.sandboxSpawns).toHaveLength(0);
      expect(result.evaluated).toBe(false);
      expect(result.proofRecords).toBe(0);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      tracker.restore();
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('gitignored untracked file prevents sandbox spawn and approval', async () => {
    const checkout = await initCheckout();
    const tracker = installSandboxSimulation(false);
    try {
      await writeFile(join(checkout.dir, '.gitignore'), 'secret.txt\n');
      await runGit(checkout.dir, ['add', '.gitignore']);
      await runGit(checkout.dir, ['commit', '-qm', 'ignore']);
      const head = await runGit(checkout.dir, ['rev-parse', 'HEAD']);
      await writeFile(join(checkout.dir, 'secret.txt'), 'nope\n');
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head,
        checkPlan: [['/usr/bin/true']],
      });
      expect(tracker.sandboxSpawns).toHaveLength(0);
      expect(result.evaluated).toBe(false);
      expect(result.proofRecords).toBe(0);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      tracker.restore();
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('a zero-exit check that edits a tracked file cannot qualify the head', async () => {
    const checkout = await initCheckout();
    const tracker = installSandboxSimulation(true);
    try {
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head: checkout.head,
        checkPlan: [['/bin/sh', '-c', 'printf x >> allowed.txt']],
      });
      expect(tracker.sandboxSpawns).toHaveLength(0);
      expect(await readFile(join(checkout.dir, 'allowed.txt'), 'utf8')).toContain('x');
      expect(result.evaluated).toBe(false);
      expect(result.proofRecords).toBe(0);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      tracker.restore();
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('mutation during model execution cannot qualify an otherwise clean head', async () => {
    const checkout = await initCheckout();
    const tracker = installSandboxSimulation(true);
    try {
      const result = await reviewObservedCheckout({
        dir: checkout.dir,
        head: checkout.head,
        checkPlan: [['/usr/bin/true']],
        evaluate: async () => {
          await appendFile(join(checkout.dir, 'allowed.txt'), 'mutated\n');
          return approveResult(checkout.head);
        },
      });
      expect(result.evaluated).toBe(true);
      expect(await readFile(join(checkout.dir, 'allowed.txt'), 'utf8')).toContain('mutated');
      expect(result.proofRecords).toBe(0);
      expect(result.disposition).toBe('review_incomplete');
      expect(result.posts).toEqual(['COMMENT']);
    } finally {
      tracker.restore();
      await rm(checkout.dir, { recursive: true, force: true });
    }
  });

  test('git and sandbox spawns omit parent secrets and leave the parent env unchanged', async () => {
    const checkout = await initCheckout();
    const binParent = await mkdtemp(join(tmpdir(), 'overseer-review-bin-'));
    const binDir = join(binParent, 'bin');
    await mkdir(binDir);
    const recordPath = join(binParent, 'env-record');
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('git_missing');
    await writeFile(
      join(binDir, 'git'),
      `#!/bin/sh\n/usr/bin/env >> '${recordPath}'\nprintf '\\n#\\n' >> '${recordPath}'\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    );
    const saved: Record<string, string | undefined> = { ...process.env };
    const tracker = installSandboxSimulation(true);
    try {
      for (const [key, value] of Object.entries(CANARIES)) process.env[key] = value;
      process.env.PATH = `${binDir}:${saved.PATH ?? ''}`;
      const during = Object.entries(process.env).map(([key, value]) => `${key}=${value ?? ''}`);
      const broker = await startFakeBroker();
      await observeReviewExecution({
        requestId: 'request-1',
        workerId: 'worker-1',
        fencingToken: 7,
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: checkout.head,
        checkoutPath: checkout.dir,
        reviewerIdentity: 'bot',
        rung: 'pr-review',
        checkPlan: [['git', 'rev-parse', 'HEAD']],
      });
      await broker.stop();
      const after = Object.entries(process.env).map(([key, value]) => `${key}=${value ?? ''}`);
      expect(after.sort()).toEqual(during.sort());
      const recorded = await readFile(recordPath, 'utf8');
      expect(recorded.length).toBeGreaterThan(0);
      expect(tracker.sandboxSpawns).toHaveLength(0);
      for (const [key, value] of Object.entries(CANARIES)) {
        expect(recorded.includes(`${key}=`)).toBe(false);
        expect(recorded.includes(value)).toBe(false);
        for (const spawn of tracker.sandboxSpawns) {
          expect(spawn.env[key]).toBeUndefined();
          expect(spawn.env.PATH?.length ?? 0).toBeGreaterThan(0);
          expect(Object.values(spawn.env).join('\n').includes(value)).toBe(false);
        }
      }
    } finally {
      tracker.restore();
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(checkout.dir, { recursive: true, force: true });
      await rm(binParent, { recursive: true, force: true });
    }
  });
});
