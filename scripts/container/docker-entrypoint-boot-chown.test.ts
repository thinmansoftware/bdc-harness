/**
 * docker-entrypoint.sh boot ownership and safe.directory bounds
 * (WO-HARNESS-BOOT-CHOWN-FAST-01).
 *
 * Sources the real entrypoint and drives archon_ownership_phase /
 * archon_register_safe_directories with PATH stubs. No root and no real
 * /.archon volume are required. chown, find, stat, and git are stubs that
 * record argv; bash, dirname, and printf stay real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRYPOINT = join(import.meta.dir, '../../docker-entrypoint.sh');

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

let tmp = '';
let stubDir = '';
let archonRoot = '';
let homeRoot = '';
let artifactsRoot = '';
let chownLog = '';
let findLog = '';
let gitLog = '';

function parseCalls(text: string): string[][] {
  const calls: string[][] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      if (current.length > 0) {
        calls.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) {
    calls.push(current);
  }
  return calls;
}

function isRecursiveChown(argv: string[]): boolean {
  return argv.some(arg => arg.startsWith('-R'));
}

async function readCalls(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8');
  return parseCalls(text);
}

async function writeStub(name: string, body: string): Promise<void> {
  const path = join(stubDir, name);
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

function recordHeader(logPath: string): string {
  return `#!/bin/bash
log="${logPath}"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$log"
done
printf '\\n' >> "$log"
`;
}

async function resetLogs(): Promise<void> {
  await writeFile(chownLog, '');
  await writeFile(findLog, '');
  await writeFile(gitLog, '');
}

function phaseEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: `${stubDir}:/usr/bin:/bin`,
    HOME: tmp,
    ...extra,
  };
}

async function runBash(
  script: string,
  args: string[],
  env: Record<string, string>
): Promise<CommandResult> {
  const proc = Bun.spawn(['bash', '-c', script, 'bash', ...args], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runOwnership(extra: Record<string, string> = {}): Promise<CommandResult> {
  return runBash(
    'source "$1"; archon_ownership_phase "$2" "$3" "$4"',
    [ENTRYPOINT, archonRoot, homeRoot, artifactsRoot],
    phaseEnv(extra)
  );
}

async function runSafeDirectories(extra: Record<string, string> = {}): Promise<CommandResult> {
  return runBash(
    'source "$1"; archon_register_safe_directories "$2"',
    [ENTRYPOINT, archonRoot],
    phaseEnv({ RUNNER: '', ...extra })
  );
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'archon-boot-chown-'));
  stubDir = join(tmp, 'stubs');
  archonRoot = join(tmp, '.archon');
  homeRoot = join(tmp, 'home');
  artifactsRoot = join(tmp, 'host-artifacts');
  chownLog = join(tmp, 'chown.log');
  findLog = join(tmp, 'find.log');
  gitLog = join(tmp, 'git.log');

  await mkdir(stubDir, { recursive: true });
  await mkdir(join(archonRoot, 'workspaces'), { recursive: true });
  await mkdir(join(archonRoot, 'worktrees'), { recursive: true });
  await mkdir(homeRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
  await resetLogs();

  await writeStub(
    'chown',
    `${recordHeader(chownLog)}exit "\${CHOWN_EXIT:-0}"
`
  );
  await writeStub(
    'find',
    `${recordHeader(findLog)}behavior="\${FIND_BEHAVIOR:-}"
if [ "$behavior" = "mismatch" ]; then
  has_bang=0
  has_user=0
  for arg in "$@"; do
    if [ "$arg" = "!" ]; then
      has_bang=1
    fi
    if [ "$arg" = "-user" ]; then
      has_user=1
    fi
  done
  case "$1" in
    */workspaces)
      if [ "$has_bang" = "1" ] && [ "$has_user" = "1" ]; then
        printf '%s\\n' "$1/not-appuser"
      fi
      ;;
  esac
elif [ "$behavior" = "gitpaths" ]; then
  for arg in "$@"; do
    if [ "$arg" = ".git" ]; then
      printf '%s' "\${FIND_GIT_PATHS:-}"
      break
    fi
  done
fi
exit 0
`
  );
  await writeStub(
    'stat',
    `#!/bin/bash
printf 'appuser\\n'
exit "\${STAT_EXIT:-0}"
`
  );
  await writeStub(
    'git',
    `${recordHeader(gitLog)}if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "--global" ] && [ "\${3:-}" = "--get-all" ] && [ "\${4:-}" = "safe.directory" ]; then
  exit 1
fi
exit 0
`
  );
});

beforeEach(async () => {
  await resetLogs();
});

afterAll(async () => {
  if (tmp.length > 0) {
    await rm(tmp, { recursive: true, force: true });
  }
});

describe('docker-entrypoint boot chown (WO-HARNESS-BOOT-CHOWN-FAST-01)', () => {
  it('owned_tree_no_recursive_chown', async () => {
    const { exitCode, stderr } = await runOwnership();
    const chownCalls = await readCalls(chownLog);

    expect(exitCode).toBe(0);
    expect(chownCalls.length).toBeGreaterThan(0);
    for (const argv of chownCalls) {
      for (const arg of argv) {
        expect(arg).not.toMatch(/^-R/);
      }
    }
    expect(stderr).toContain('boot-phase ownership');
  });

  it('mismatched_child_gets_recursive_chown_only_there', async () => {
    const workspaces = join(archonRoot, 'workspaces');
    const { exitCode } = await runOwnership({ FIND_BEHAVIOR: 'mismatch' });
    const chownCalls = await readCalls(chownLog);
    const recursive = chownCalls.filter(isRecursiveChown);

    expect(exitCode).toBe(0);
    expect(recursive).toHaveLength(1);
    const only = recursive[0] ?? [];
    expect(only[only.length - 1]).toBe(workspaces);
    const targetsRoot = recursive.filter(argv => argv[argv.length - 1] === archonRoot);
    expect(targetsRoot).toHaveLength(0);
  });

  it('full_chown_opt_in', async () => {
    const { exitCode } = await runOwnership({ ARCHON_FULL_CHOWN: '1' });
    const chownCalls = await readCalls(chownLog);
    const matched = chownCalls.filter(
      argv => argv.includes('-Rh') && argv.includes('appuser:appuser') && argv.includes(archonRoot)
    );

    expect(exitCode).toBe(0);
    expect(matched.length).toBeGreaterThan(0);
  });

  it('chown_failure_still_fails_closed', async () => {
    const { exitCode, stderr } = await runOwnership({ CHOWN_EXIT: '1' });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Failed to fix ownership of /.archon');
  });

  it('safe_directory_walk_is_depth_bounded', async () => {
    const { exitCode } = await runSafeDirectories();
    const findCalls = await readCalls(findLog);
    const rooted = findCalls.filter(argv => argv[0] === archonRoot);

    expect(exitCode).toBe(0);
    expect(rooted.length).toBeGreaterThan(0);
    for (const argv of rooted) {
      expect(argv).toContain('-maxdepth');
      expect(argv).toContain('7');
    }
  });

  it('safe_directory_list_read_once', async () => {
    const repos = [
      join(archonRoot, 'workspaces/owner/repo/source'),
      join(archonRoot, 'workspaces/owner/repo/worktrees/branch'),
      join(archonRoot, 'workspaces/owner/repo/worktrees/lane/task'),
    ];
    const gitPaths = `${repos.map(repo => join(repo, '.git')).join('\n')}\n`;
    const { exitCode } = await runSafeDirectories({
      FIND_BEHAVIOR: 'gitpaths',
      FIND_GIT_PATHS: gitPaths,
    });
    const gitCalls = await readCalls(gitLog);
    const listReads = gitCalls.filter(
      argv =>
        argv[0] === 'config' &&
        argv[1] === '--global' &&
        argv[2] === '--get-all' &&
        argv[3] === 'safe.directory'
    );
    const adds = gitCalls.filter(
      argv =>
        argv[0] === 'config' &&
        argv[1] === '--global' &&
        argv[2] === '--add' &&
        argv[3] === 'safe.directory'
    );

    expect(exitCode).toBe(0);
    expect(listReads).toHaveLength(1);
    expect(adds).toHaveLength(3);
  });
});
