/**
 * Behavioral tests for scripts/container/build-app-image.sh.
 * Stub git and docker sit first on PATH so the wrapper never touches a real daemon.
 */
import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Tests 2-5 drive build-app-image.sh with bash and extensionless PATH stubs
// (git, docker). Windows cannot exec extensionless stubs from PATH and has no
// reliable bash on PATH for Bun.spawn, so these tests are skipped on win32 only.
// They still run on Linux CI, where the stubs and bash are real.
const SKIP_ON_WINDOWS = process.platform === 'win32';

const SCRIPT = join(import.meta.dir, 'build-app-image.sh');
const GOOD_SHA = '0123456789abcdef0123456789abcdef01234567';
const MISMATCH_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

const GIT_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'if [ "${1:-}" = "status" ] && [ "${2:-}" = "--porcelain" ]; then',
  '  printf \'%s\\n\' "${GIT_PORCELAIN:-}"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "HEAD" ]; then',
  '  printf \'%s\\n\' "${GIT_HEAD:-}"',
  '  exit 0',
  'fi',
  'exit 1',
  '',
].join('\n');

const DOCKER_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'log="${DOCKER_LOG:?}"',
  '{',
  '  printf \'ARCHON_BUILD_SHA=%s --\' "${ARCHON_BUILD_SHA-}"',
  '  for arg in "$@"; do',
  '    printf \' %s\' "$arg"',
  '  done',
  "  printf '\\n'",
  '} >> "$log"',
  'if [ "${1:-}" = "compose" ] && [ "${2:-}" = "build" ] && [ "${3:-}" = "app" ] && [ "$#" -eq 3 ]; then',
  '  exit "${DOCKER_BUILD_EXIT:-0}"',
  'fi',
  'if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then',
  '  printf \'%s\\n\' "${DOCKER_INSPECT_LABEL:-}"',
  '  exit 0',
  'fi',
  'exit 99',
  '',
].join('\n');

interface BuildControls {
  porcelain?: string;
  head?: string;
  buildExit?: string;
  inspectLabel?: string;
  extraEnv?: Record<string, string>;
}

interface BuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  dockerLog: string;
}

function buildEnv(
  binDir: string,
  dockerLog: string,
  controls: BuildControls
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  return {
    ...base,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GIT_PORCELAIN: controls.porcelain ?? '',
    GIT_HEAD: controls.head ?? '',
    DOCKER_LOG: dockerLog,
    DOCKER_BUILD_EXIT: controls.buildExit ?? '0',
    DOCKER_INSPECT_LABEL: controls.inspectLabel ?? '',
    ...controls.extraEnv,
  };
}

async function runBuild(controls: BuildControls): Promise<BuildResult> {
  const dir = await mkdtemp(join(tmpdir(), 'build-app-image-'));
  try {
    const binDir = join(dir, 'bin');
    const dockerLog = join(dir, 'docker.log');
    await mkdir(binDir);
    await writeFile(dockerLog, '');
    const gitPath = join(binDir, 'git');
    const dockerPath = join(binDir, 'docker');
    await writeFile(gitPath, GIT_STUB, { mode: 0o755 });
    await writeFile(dockerPath, DOCKER_STUB, { mode: 0o755 });
    await chmod(gitPath, 0o755);
    await chmod(dockerPath, 0o755);

    const proc = Bun.spawn(['bash', SCRIPT], {
      env: buildEnv(binDir, dockerLog, controls),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const logged = await readFile(dockerLog, 'utf8');
    return { exitCode, stdout, stderr, dockerLog: logged };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('build-app-image', () => {
  it.skipIf(SKIP_ON_WINDOWS)('Test 2: clean tree builds with the real SHA', async () => {
    const result = await runBuild({
      porcelain: '',
      head: GOOD_SHA,
      inspectLabel: GOOD_SHA,
      buildExit: '0',
      extraEnv: { ARCHON_BUILD_SHA: 'not-the-sha' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`built archon revision=${GOOD_SHA}`);
    expect(result.dockerLog).toContain(`ARCHON_BUILD_SHA=${GOOD_SHA} -- compose build app`);
    expect(result.dockerLog).not.toContain('ARCHON_BUILD_SHA=not-the-sha');
  });

  it.skipIf(SKIP_ON_WINDOWS)('Test 3: dirty tree refuses before building', async () => {
    const result = await runBuild({
      porcelain: ' M Dockerfile',
      head: GOOD_SHA,
      inspectLabel: GOOD_SHA,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('dirty tree');
    expect(result.dockerLog).toBe('');
  });

  it.skipIf(SKIP_ON_WINDOWS)('Test 4: label mismatch after build fails loudly', async () => {
    const result = await runBuild({
      porcelain: '',
      head: GOOD_SHA,
      inspectLabel: MISMATCH_SHA,
    });

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain(GOOD_SHA);
    expect(result.stderr).toContain(MISMATCH_SHA);
    expect(result.stderr).toContain(
      `revision label mismatch: expected ${GOOD_SHA} found ${MISMATCH_SHA}`
    );
  });

  it.skipIf(SKIP_ON_WINDOWS)('Test 5: unusable HEAD or failed build', async () => {
    const badHead = await runBuild({
      porcelain: '',
      head: 'unknown',
      inspectLabel: GOOD_SHA,
    });
    expect(badHead.exitCode).toBe(3);
    expect(badHead.dockerLog).toBe('');

    const failedBuild = await runBuild({
      porcelain: '',
      head: GOOD_SHA,
      buildExit: '17',
      inspectLabel: GOOD_SHA,
    });
    expect(failedBuild.exitCode).toBe(17);
    expect(failedBuild.dockerLog).toContain('compose build app');
    expect(failedBuild.dockerLog).not.toContain('image inspect');
  });
});
