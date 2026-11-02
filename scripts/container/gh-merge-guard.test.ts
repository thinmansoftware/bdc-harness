/**
 * gh-merge-guard behavioral tests (bdc-xo#1491).
 *
 * Spawns the real shim script with GH_GUARD_REAL_GH pointed at a stub that
 * records its argv, proving: merge verbs are BLOCKED (exit 86, loud stderr),
 * non-merge gh usage passes through untouched, and the operator escape hatch
 * works only when explicitly set.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = join(import.meta.dir, 'gh-merge-guard.sh');

let dir: string;
let stubGh: string;
let argvLog: string;

async function runGuard(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bash', GUARD, ...args], {
    env: { ...process.env, GH_GUARD_REAL_GH: stubGh, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stderr };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-guard-'));
  stubGh = join(dir, 'stub-gh.sh');
  argvLog = join(dir, 'argv.log');
  await writeFile(stubGh, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nexit 0\n`, {
    mode: 0o755,
  });
  await chmod(stubGh, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gh-merge-guard (bdc-xo#1491)', () => {
  it('blocks gh pr merge with exit 86 and a loud pointer to the incident', async () => {
    const { exitCode, stderr } = await runGuard(['pr', 'merge', '639', '--squash', '--auto']);
    expect(exitCode).toBe(86);
    expect(stderr).toContain('gh-merge-guard: BLOCKED');
    expect(stderr).toContain('bdc-xo#1491');
  });

  it('blocks the REST merge endpoint form', async () => {
    const { exitCode } = await runGuard([
      'api',
      'repos/thinmansoftware/bdc-harness/pulls/639/merge',
      '-X',
      'PUT',
    ]);
    expect(exitCode).toBe(86);
  });

  it('blocks the GraphQL mutation forms', async () => {
    for (const mutation of ['mergePullRequest', 'enablePullRequestAutoMerge']) {
      const { exitCode } = await runGuard([
        'api',
        'graphql',
        '-f',
        `query=mutation { ${mutation}(input: {}) { clientMutationId } }`,
      ]);
      expect(exitCode).toBe(86);
    }
  });

  it('passes through non-merge gh usage untouched, argv intact', async () => {
    const args = ['pr', 'view', '639', '--json', 'mergeable,mergeStateStatus'];
    const { exitCode } = await runGuard(args);
    expect(exitCode).toBe(0);
    const logged = (await readFile(argvLog, 'utf8')).trim().split('\n');
    expect(logged).toEqual(args);
  });

  it('does not block substring lookalikes (mergeable JSON field, branch names)', async () => {
    for (const args of [
      ['pr', 'view', '--json', 'mergeable'],
      ['pr', 'checks', '639', '--watch'],
      ['run', 'list', '--branch', 'feat/merge-tooling'],
    ]) {
      const { exitCode } = await runGuard(args);
      expect(exitCode).toBe(0);
    }
  });

  it('honors the explicit operator escape hatch', async () => {
    const { exitCode } = await runGuard(['pr', 'merge', '1'], { ARCHON_ALLOW_PR_MERGE: '1' });
    expect(exitCode).toBe(0);
    const logged = (await readFile(argvLog, 'utf8')).trim().split('\n');
    expect(logged).toEqual(['pr', 'merge', '1']);
  });
});
