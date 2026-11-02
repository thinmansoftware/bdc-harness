/**
 * Behavioral tests for scripts/container/rebuild-archon-app.sh.
 * Tests 3-5 stub git, docker, sqlite3, and curl on PATH so the script never
 * touches a real daemon, the host database, or the live drain API.
 * backupsOutsideCheckout uses real git and stubs docker, sqlite3, and curl.
 * Skipped on win32 like build-app-image.
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
  '  exit "${DOCKER_BUILD_STATUS:-0}"',
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
  'if [ "${1:-}" = "exec" ]; then',
  '  printf \'%s\\n\' "${DOCKER_OPERATOR_TOKEN:-drain-token-sentinel}"',
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

const CURL_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'log="${CURL_LOG:?}"',
  'printf \'%s\\n\' "$*" >> "$log"',
  'out="/dev/null"',
  'write_format=""',
  'url=""',
  'method="GET"',
  'data=""',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -sS|-s|-S|-f|-k)',
  '      shift',
  '      ;;',
  '    -o)',
  '      out="$2"',
  '      shift 2',
  '      ;;',
  '    -w)',
  '      write_format="$2"',
  '      shift 2',
  '      ;;',
  '    -H)',
  '      shift 2',
  '      ;;',
  '    -d|--data|--data-raw)',
  '      data="$2"',
  '      method="POST"',
  '      shift 2',
  '      ;;',
  '    -X)',
  '      method="$2"',
  '      shift 2',
  '      ;;',
  '    *)',
  '      url="$1"',
  '      shift',
  '      ;;',
  '  esac',
  'done',
  'code="500"',
  'body=""',
  'if [[ "$url" == *"/api/health"* ]]; then',
  '  code="${CURL_HEALTH_CODE:-200}"',
  'elif [[ "$url" == *"/api/admin/drain"* ]]; then',
  '  if [ "$method" = "POST" ]; then',
  '    if printf \'%s\\n\' "$data" | grep -Eq \'"draining": true|"draining":true\'; then',
  '      code="${CURL_DRAIN_ENABLE_CODE:-200}"',
  '    elif printf \'%s\\n\' "$data" | grep -Eq \'"draining": false|"draining":false\'; then',
  '      code="${CURL_DRAIN_DISABLE_CODE:-200}"',
  '    else',
  '      code="400"',
  '    fi',
  '  else',
  '    if [ "${STOP_ON_DRAIN_GET:-}" = "1" ] && [ -n "${ARCHON_REBUILD_STOP_FILE:-}" ]; then',
  '      printf \'stopped during drain\\n\' > "$ARCHON_REBUILD_STOP_FILE"',
  '    fi',
  '    if [ "${HOLD_ON_DRAIN_GET:-}" = "1" ] && [ -n "${ARCHON_REBUILD_HOLD_FILE:-}" ]; then',
  '      printf \'held during drain\\n\' > "$ARCHON_REBUILD_HOLD_FILE"',
  '    fi',
  '    code="${CURL_DRAIN_GET_CODE:-200}"',
  '    body="$(printf \'{"activeRunCount":%s,"activeLeaseCount":%s}\' "${CURL_ACTIVE_RUNS:-0}" "${CURL_ACTIVE_LEASES:-0}")"',
  '  fi',
  'fi',
  'if [ -n "$out" ]; then',
  '  printf \'%s\' "$body" > "$out"',
  'fi',
  'if [ "$write_format" = \'%{http_code}\' ]; then',
  '  printf \'%s\' "$code"',
  'fi',
  'exit 0',
  '',
].join('\n');

interface RebuildControls {
  target?: string;
  holdContents?: string;
  withComposeFiles?: boolean;
  stopOnBuild?: boolean;
  stopOnDrainGet?: boolean;
  holdOnDrainGet?: boolean;
  sqliteRuns?: string;
  head?: string;
  dockerBuildStatus?: string;
  curlActiveRuns?: string;
  curlActiveLeases?: string;
  curlHealthCode?: string;
  curlDrainEnableCode?: string;
  curlDrainDisableCode?: string;
  curlDrainGetCode?: string;
}

interface RebuildResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  dockerLog: string;
  gitLog: string;
  sqliteLog: string;
  curlLog: string;
}

function rebuildEnv(
  binDir: string,
  logs: { docker: string; git: string; sqlite: string; curl: string },
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
    CURL_LOG: logs.curl,
    DOCKER_BUILD_STATUS: controls.dockerBuildStatus ?? '0',
    CURL_HEALTH_CODE: controls.curlHealthCode ?? '200',
    CURL_DRAIN_ENABLE_CODE: controls.curlDrainEnableCode ?? '200',
    CURL_DRAIN_DISABLE_CODE: controls.curlDrainDisableCode ?? '200',
    CURL_DRAIN_GET_CODE: controls.curlDrainGetCode ?? '200',
    CURL_ACTIVE_RUNS: controls.curlActiveRuns ?? '0',
    CURL_ACTIVE_LEASES: controls.curlActiveLeases ?? '0',
    GIT_PORCELAIN: '',
    GIT_HEAD: head,
    DOCKER_INSPECT_LABEL: head,
    DOCKER_HEALTH: 'healthy',
    SQLITE_RUNS: controls.sqliteRuns ?? '0',
    SQLITE_CHECK: 'ok',
    SQLITE_CLAIMS: '0',
    STOP_ON_BUILD: controls.stopOnBuild ? '1' : '0',
    STOP_ON_DRAIN_GET: controls.stopOnDrainGet ? '1' : '0',
    HOLD_ON_DRAIN_GET: controls.holdOnDrainGet ? '1' : '0',
    ARCHON_REBUILD_HOLD_FILE: paths.hold,
    ARCHON_REBUILD_STOP_FILE: paths.stop,
    TARGET: controls.target ?? GOOD_SHA,
  };
  delete env.ARCHON_REBUILD_ROOT;
  delete env.BASH_ENV;
  delete env.REBUILD_TEST_ROOT;
  delete env.DOCKER_OPERATOR_TOKEN;
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
    const curlLog = join(dir, 'curl.log');
    const holdFile = join(dir, 'hold');
    const stopFile = join(dir, 'stop');
    await mkdir(binDir);
    await mkdir(root);
    await writeFile(dockerLog, '');
    await writeFile(gitLog, '');
    await writeFile(sqliteLog, '');
    await writeFile(curlLog, '');
    if (controls.holdContents !== undefined) {
      await writeFile(holdFile, controls.holdContents);
    }
    const env = rebuildEnv(
      binDir,
      { docker: dockerLog, git: gitLog, sqlite: sqliteLog, curl: curlLog },
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
    const curlPath = join(binDir, 'curl');
    await writeFile(gitPath, GIT_STUB, { mode: 0o755 });
    await writeFile(dockerPath, DOCKER_STUB, { mode: 0o755 });
    await writeFile(sqlitePath, SQLITE_STUB, { mode: 0o755 });
    await writeFile(curlPath, CURL_STUB, { mode: 0o755 });
    await chmod(gitPath, 0o755);
    await chmod(dockerPath, 0o755);
    await chmod(sqlitePath, 0o755);
    await chmod(curlPath, 0o755);

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
    const curlLogged = await readFile(curlLog, 'utf8');
    return {
      exitCode,
      stdout,
      stderr,
      dockerLog: dockerLogged,
      gitLog: gitLogged,
      sqliteLog: sqliteLogged,
      curlLog: curlLogged,
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
      expect(result.curlLog).toBe('');
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
      const curlLog = join(dir, 'curl.log');
      const marker = 'compose-marker-backups-outside-checkout';
      try {
        await mkdir(backupDir);
        await mkdir(binDir);
        await writeFile(dockerLog, '');
        await writeFile(sqliteLog, '');
        await writeFile(curlLog, '');

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
        const curlPath = join(binDir, 'curl');
        await writeFile(dockerPath, DOCKER_STUB, { mode: 0o755 });
        await writeFile(sqlitePath, SQLITE_STUB, { mode: 0o755 });
        await writeFile(curlPath, CURL_STUB, { mode: 0o755 });
        await chmod(dockerPath, 0o755);
        await chmod(sqlitePath, 0o755);
        await chmod(curlPath, 0o755);

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
          CURL_LOG: curlLog,
          DOCKER_BUILD_STATUS: '0',
          CURL_HEALTH_CODE: '200',
          CURL_DRAIN_ENABLE_CODE: '200',
          CURL_DRAIN_DISABLE_CODE: '200',
          CURL_DRAIN_GET_CODE: '200',
          CURL_ACTIVE_RUNS: '0',
          CURL_ACTIVE_LEASES: '0',
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
        delete env.DOCKER_OPERATOR_TOKEN;

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
    expect(result.curlLog).toBe('');
  });

  it.skipIf(SKIP_ON_WINDOWS)(
    'drainGateRechecksHold: a stop or hold file created during the drain GET refuses compose up',
    async () => {
      const stopped = await runRebuild({
        target: GOOD_SHA,
        withComposeFiles: true,
        sqliteRuns: '0',
        head: GOOD_SHA,
        stopOnDrainGet: true,
      });

      expect(stopped.exitCode).toBe(11);
      expect(stopped.stderr).toContain('hold or stop file present');
      expect(stopped.stderr).toContain('stopped during drain');
      expect(stopped.dockerLog).toContain('compose build');
      expect(stopped.dockerLog).not.toContain('compose up');
      expect(stopped.curlLog).toContain('/api/admin/drain');

      const held = await runRebuild({
        target: GOOD_SHA,
        withComposeFiles: true,
        sqliteRuns: '0',
        head: GOOD_SHA,
        holdOnDrainGet: true,
      });

      expect(held.exitCode).toBe(11);
      expect(held.stderr).toContain('hold or stop file present');
      expect(held.stderr).toContain('held during drain');
      expect(held.dockerLog).toContain('compose build');
      expect(held.dockerLog).not.toContain('compose up');
      expect(held.curlLog).toContain('/api/admin/drain');
    }
  );

  it.skipIf(SKIP_ON_WINDOWS)(
    'drainBlocksAdmission: active runs at the pre-restart check refuse compose up',
    async () => {
      const result = await runRebuild({
        target: GOOD_SHA,
        withComposeFiles: true,
        sqliteRuns: '0',
        head: GOOD_SHA,
        curlActiveRuns: '1',
      });

      expect(result.exitCode).toBe(12);
      expect(result.dockerLog).toContain('compose build');
      expect(result.dockerLog).not.toContain('compose up');
      expect(result.stderr).toContain('drain_disabled');
      expect(result.stdout).not.toContain('drain-token-sentinel');
      expect(result.stderr).not.toContain('drain-token-sentinel');
    }
  );

  it.skipIf(SKIP_ON_WINDOWS)(
    'drainReleasedOnAbort: a failed build releases drain from the trap',
    async () => {
      const result = await runRebuild({
        target: GOOD_SHA,
        withComposeFiles: true,
        sqliteRuns: '0',
        head: GOOD_SHA,
        dockerBuildStatus: '1',
      });

      expect(result.dockerLog).toContain('compose build');
      expect(result.dockerLog).not.toContain('compose up');
      expect(result.stderr).toContain('drain_enabled');
      expect(result.stderr).toContain('drain_disabled');
      expect(result.curlLog).toContain('/api/admin/drain');
      expect(result.curlLog).not.toContain('/api/health');
    }
  );
});
