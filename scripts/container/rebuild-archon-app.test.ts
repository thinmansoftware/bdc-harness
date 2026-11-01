/**
 * Behavioral tests for scripts/container/rebuild-archon-app.sh.
 * Tests 3-5 stub git, docker, and sqlite3 on PATH so the script never touches
 * a real daemon or the host database. backupsOutsideCheckout uses real git
 * and stubs only docker and sqlite3. Skipped on win32 like build-app-image.
 *
 * The checkout path is the literal /opt/bdc/archon and is not an input.
 * Test 4 cannot create that directory here, so it installs a BASH_ENV cd
 * double that sends only that absolute path at a temp checkout. The script
 * does not read BASH_ENV.
 */
import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SKIP_ON_WINDOWS = process.platform === 'win32';

const SCRIPT = join(import.meta.dir, 'rebuild-archon-app.sh');
const GOOD_SHA = '0123456789abcdef0123456789abcdef01234567';

const GIT_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'log="${GIT_LOG:?}"',
  'printf \'%s\\n\' "$*" >> "$log"',
  'if [ "${1:-}" = "status" ]; then',
  '  if [ -n "${GIT_PORCELAIN:-}" ]; then',
  '    printf \'%s\\n\' "$GIT_PORCELAIN"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "rev-parse" ] && [ "${2:-}" = "HEAD" ]; then',
  '  printf \'%s\\n\' "${GIT_HEAD:?}"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "rev-parse" ]; then',
  '  printf \'%s\\n\' "${GIT_HEAD:?}"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "fetch" ]; then',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "checkout" ]; then',
  '  exit 0',
  'fi',
  'exit 1',
  '',
].join('\n');

const DOCKER_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'log="${DOCKER_LOG:?}"',
  'printf \'%s\\n\' "$*" >> "$log"',
  'if [ "${1:-}" = "tag" ]; then',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "compose" ] && [ "${2:-}" = "build" ]; then',
  '  if [ "${STOP_ON_BUILD:-}" = "1" ] && [ -n "${ARCHON_REBUILD_STOP_FILE:-}" ]; then',
  '    printf \'stopped during build\\n\' > "$ARCHON_REBUILD_STOP_FILE"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then',
  '  printf \'%s\\n\' "${DOCKER_INSPECT_LABEL:?}"',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "compose" ] && [ "${2:-}" = "up" ]; then',
  '  exit 0',
  'fi',
  'if [ "${1:-}" = "inspect" ]; then',
  '  printf \'%s\\n\' "${DOCKER_HEALTH:-healthy}"',
  '  exit 0',
  'fi',
  'exit 99',
  '',
].join('\n');

const SQLITE_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'log="${SQLITE_LOG:?}"',
  'printf \'%s\\n\' "$*" >> "$log"',
  'joined="$*"',
  'if [[ "$joined" == *remote_agent_workflow_runs* ]]; then',
  '  printf \'%s\\n\' "${SQLITE_RUNS:-0}"',
  '  exit 0',
  'fi',
  'if [[ "$joined" == *.backup* ]]; then',
  '  exit 0',
  'fi',
  'if [[ "$joined" == *quick_check* ]]; then',
  '  printf \'%s\\n\' "${SQLITE_CHECK:-ok}"',
  '  exit 0',
  'fi',
  'if [[ "$joined" == *agent_dispatch_messages* ]]; then',
  '  printf \'%s\\n\' "${SQLITE_CLAIMS:-0}"',
  '  exit 0',
  'fi',
  'exit 99',
  '',
].join('\n');

interface RebuildControls {
  target?: string;
  holdContents?: string;
  withComposeFiles?: boolean;
  stopOnBuild?: boolean;
  sqliteRuns?: string;
  head?: string;
}

interface RebuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  dockerLog: string;
  gitLog: string;
  sqliteLog: string;
}

function rebuildEnv(
  binDir: string,
  logs: { docker: string; git: string; sqlite: string },
  paths: { hold: string; stop: string },
  controls: RebuildControls
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }
  const head = controls.head ?? GOOD_SHA;
  const env: Record<string, string> = {
    ...base,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GIT_LOG: logs.git,
    DOCKER_LOG: logs.docker,
    SQLITE_LOG: logs.sqlite,
    GIT_PORCELAIN: '',
    GIT_HEAD: head,
    DOCKER_INSPECT_LABEL: head,
    DOCKER_HEALTH: 'healthy',
    SQLITE_RUNS: controls.sqliteRuns ?? '0',
    SQLITE_CHECK: 'ok',
    SQLITE_CLAIMS: '0',
    STOP_ON_BUILD: controls.stopOnBuild ? '1' : '0',
    ARCHON_REBUILD_HOLD_FILE: paths.hold,
    ARCHON_REBUILD_STOP_FILE: paths.stop,
    TARGET: controls.target ?? GOOD_SHA,
  };
  delete env.ARCHON_REBUILD_ROOT;
  delete env.BASH_ENV;
  delete env.REBUILD_TEST_ROOT;
  return env;
}

async function runRebuild(controls: RebuildControls): Promise<RebuildResult> {
  const dir = await mkdtemp(join(tmpdir(), 'rebuild-archon-app-'));
  try {
    const binDir = join(dir, 'bin');
    const root = join(dir, 'root');
    const dockerLog = join(dir, 'docker.log');
    const gitLog = join(dir, 'git.log');
    const sqliteLog = join(dir, 'sqlite.log');
    const holdFile = join(dir, 'hold');
    const stopFile = join(dir, 'stop');
    await mkdir(binDir);
    await mkdir(root);
    await writeFile(dockerLog, '');
    await writeFile(gitLog, '');
    await writeFile(sqliteLog, '');
    if (controls.holdContents !== undefined) {
      await writeFile(holdFile, controls.holdContents);
    }
    const env = rebuildEnv(
      binDir,
      { docker: dockerLog, git: gitLog, sqlite: sqliteLog },
      {
        hold: controls.holdContents !== undefined ? holdFile : join(dir, 'hold-absent'),
        stop: stopFile,
      },
      controls
    );
    if (controls.withComposeFiles) {
      await writeFile(join(root, 'docker-compose.yml'), 'services: {}\n');
      await writeFile(join(root, 'docker-compose.override.yml'), 'services: {}\n');
      const composeBackup = join(dir, 'compose-backup');
      await mkdir(composeBackup);
      env.ARCHON_REBUILD_BACKUP_DIR = composeBackup;
      const bashEnv = join(dir, 'bash-env.sh');
      await writeFile(
        bashEnv,
        [
          'cd() {',
          '  if [ "${1:-}" = "/opt/bdc/archon" ]; then',
          '    set -- "${REBUILD_TEST_ROOT:?}"',
          '  fi',
          '  builtin cd -- "$@"',
          '}',
          '',
        ].join('\n')
      );
      env.BASH_ENV = bashEnv;
      env.REBUILD_TEST_ROOT = root;
    }

    const gitPath = join(binDir, 'git');
    const dockerPath = join(binDir, 'docker');
    const sqlitePath = join(binDir, 'sqlite3');
    await writeFile(gitPath, GIT_STUB, { mode: 0o755 });
    await writeFile(dockerPath, DOCKER_STUB, { mode: 0o755 });
    await writeFile(sqlitePath, SQLITE_STUB, { mode: 0o755 });
    await chmod(gitPath, 0o755);
    await chmod(dockerPath, 0o755);
    await chmod(sqlitePath, 0o755);

    const proc = Bun.spawn(['bash', SCRIPT], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const dockerLogged = await readFile(dockerLog, 'utf8');
    const gitLogged = await readFile(gitLog, 'utf8');
    const sqliteLogged = await readFile(sqliteLog, 'utf8');
    return {
      exitCode,
      stdout,
      stderr,
      dockerLog: dockerLogged,
      gitLog: gitLogged,
      sqliteLog: sqliteLogged,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function worktreeFilenames(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    names.push(entry.name);
    if (entry.isDirectory()) {
      names.push(...(await worktreeFilenames(join(dir, entry.name))));
    }
  }
  return names;
}

describe('rebuild-archon-app', () => {
  it.skipIf(SKIP_ON_WINDOWS)(
    'Test 3: the rebuild script refuses on hold before touching anything',
    async () => {
      const result = await runRebuild({
        target: GOOD_SHA,
        holdContents: 'held by test\n',
      });

      expect(result.exitCode).toBe(10);
      expect(result.stderr).toContain('rebuild hold present');
      expect(result.stderr).toContain('held by test');
      expect(result.sqliteLog).toBe('');
      expect(result.gitLog).toBe('');
      expect(result.dockerLog).toBe('');
    }
  );

  it.skipIf(SKIP_ON_WINDOWS)(
    'Test 4: a stop file placed mid-run prevents the restart',
    async () => {
      const source = await readFile(SCRIPT, 'utf8');
      expect(source).toContain('root="/opt/bdc/archon"');
      expect(source).not.toContain('ARCHON_REBUILD_ROOT');

      const result = await runRebuild({
        target: GOOD_SHA,
        withComposeFiles: true,
        stopOnBuild: true,
        sqliteRuns: '0',
        head: GOOD_SHA,
      });

      expect(result.exitCode).toBe(11);
      expect(result.stderr).toContain('hold or stop file present');
      expect(result.dockerLog).toContain('compose build');
      expect(result.dockerLog).not.toContain('compose up');
    }
  );

  it.skipIf(SKIP_ON_WINDOWS)(
    'backupsOutsideCheckout: compose copies leave the real git checkout clean',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rebuild-archon-outside-'));
      const repo = join(dir, 'repo');
      const origin = join(dir, 'origin.git');
      const backupDir = join(dir, 'compose-backup');
      const binDir = join(dir, 'bin');
      const dockerLog = join(dir, 'docker.log');
      const sqliteLog = join(dir, 'sqlite.log');
      const marker = 'compose-marker-backups-outside-checkout';
      try {
        await mkdir(backupDir);
        await mkdir(binDir);
        await writeFile(dockerLog, '');
        await writeFile(sqliteLog, '');

        const runGit = async (args: string[]): Promise<string> => {
          const proc = Bun.spawn(['git', ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const exitCode = await proc.exited;
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          if (exitCode !== 0) {
            throw new Error(`git ${args.join(' ')} exited ${exitCode}: ${stderr}`);
          }
          return stdout;
        };

        await runGit(['init', '-b', 'dev', repo]);
        await runGit(['-C', repo, 'config', 'user.email', 'rebuild-test@example.com']);
        await runGit(['-C', repo, 'config', 'user.name', 'Rebuild Test']);
        const composeBody = `services:\n  app:\n    image: ${marker}\n`;
        await writeFile(join(repo, 'docker-compose.yml'), composeBody);
        await writeFile(join(repo, 'docker-compose.override.yml'), composeBody);
        await runGit(['-C', repo, 'add', 'docker-compose.yml', 'docker-compose.override.yml']);
        await runGit([
          '-C',
          repo,
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          'add compose files',
        ]);
        await runGit(['init', '--bare', origin]);
        await runGit(['-C', repo, 'remote', 'add', 'origin', origin]);
        await runGit(['-C', repo, 'push', '-u', 'origin', 'dev']);

        const head = (await runGit(['-C', repo, 'rev-parse', 'HEAD'])).trim();
        const bashEnv = join(dir, 'bash-env.sh');
        await writeFile(
          bashEnv,
          [
            'cd() {',
            '  if [ "${1:-}" = "/opt/bdc/archon" ]; then',
            '    set -- "${REBUILD_TEST_ROOT:?}"',
            '  fi',
            '  builtin cd -- "$@"',
            '}',
            '',
          ].join('\n')
        );

        const dockerPath = join(binDir, 'docker');
        const sqlitePath = join(binDir, 'sqlite3');
        await writeFile(dockerPath, DOCKER_STUB, { mode: 0o755 });
        await writeFile(sqlitePath, SQLITE_STUB, { mode: 0o755 });
        await chmod(dockerPath, 0o755);
        await chmod(sqlitePath, 0o755);

        const base: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) {
            base[key] = value;
          }
        }
        const env: Record<string, string> = {
          ...base,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          DOCKER_LOG: dockerLog,
          SQLITE_LOG: sqliteLog,
          DOCKER_INSPECT_LABEL: head,
          DOCKER_HEALTH: 'healthy',
          SQLITE_RUNS: '0',
          SQLITE_CHECK: 'ok',
          SQLITE_CLAIMS: '0',
          STOP_ON_BUILD: '0',
          ARCHON_REBUILD_HOLD_FILE: join(dir, 'hold-absent'),
          ARCHON_REBUILD_STOP_FILE: join(dir, 'stop-absent'),
          ARCHON_REBUILD_BACKUP_DIR: backupDir,
          BASH_ENV: bashEnv,
          REBUILD_TEST_ROOT: repo,
          TARGET: head,
        };
        delete env.ARCHON_REBUILD_ROOT;

        const proc = Bun.spawn(['bash', SCRIPT], {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        await new Response(proc.stdout).text();
        const dockerLogged = await readFile(dockerLog, 'utf8');
        const porcelain = await runGit(['-C', repo, 'status', '--porcelain']);
        const backupNames = await readdir(backupDir);
        const composeBackup = backupNames.find(name =>
          /^docker-compose\.yml\.pre-rebuild-\d{8}T\d{6}Z$/.test(name)
        );
        const overrideBackup = backupNames.find(name =>
          /^docker-compose\.override\.yml\.pre-rebuild-\d{8}T\d{6}Z$/.test(name)
        );
        const worktreeNames = await worktreeFilenames(repo);

        expect(porcelain).toBe('');
        expect(composeBackup).toBeDefined();
        expect(overrideBackup).toBeDefined();
        expect(await readFile(join(backupDir, composeBackup ?? ''), 'utf8')).toContain(marker);
        expect(await readFile(join(backupDir, overrideBackup ?? ''), 'utf8')).toContain(marker);
        expect(worktreeNames.some(name => name.includes('pre-rebuild'))).toBe(false);
        expect(dockerLogged).toContain('compose build');
        expect(stderr).not.toContain('dirty tree');
        expect(exitCode).not.toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(SKIP_ON_WINDOWS)('Test 5: in-flight runs refuse', async () => {
    const result = await runRebuild({
      target: GOOD_SHA,
      sqliteRuns: '1',
    });

    expect(result.exitCode).toBe(13);
    expect(`${result.stdout}\n${result.stderr}`).toContain('1');
    expect(result.dockerLog).not.toContain('build');
    expect(result.dockerLog).toBe('');
  });
});
