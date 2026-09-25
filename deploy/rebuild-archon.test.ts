/**
 * Stub-PATH tests for deploy/rebuild-archon.sh.
 * docker, curl, git, sqlite3, df, and flock record every invocation.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'rebuild-archon.sh');

let root: string;
let bin: string;
let log: string;
let curlCount: string;

async function writeStub(name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function setup(opts: {
  lockHeld?: boolean;
  changed?: boolean;
  readyOn?: number;
  dirty?: boolean;
  postUpDraining?: boolean;
  upFails?: boolean;
  userName?: string;
  initialMode?: 'normal' | 'draining';
  initialWhitespace?: boolean;
  drainStatus?: number;
  healthOk?: boolean;
}): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'rebuild-archon-'));
  bin = join(root, 'bin');
  log = join(root, 'calls.log');
  curlCount = join(root, 'curl.count');
  const getCount = join(root, 'get.count');
  const bodyFile = join(root, 'last-drain-body.json');
  await mkdir(bin);
  await writeFile(curlCount, '0');
  await writeFile(getCount, '0');
  const readyOn = opts.readyOn ?? 3;
  const changed = opts.changed === false ? 'false' : 'true';
  const lockHeld = opts.lockHeld ? '1' : '0';
  const dirty = opts.dirty ? '1' : '0';
  const postUp = opts.postUpDraining === false ? 'normal' : 'draining';
  const upFails = opts.upFails ? '1' : '0';
  const initialMode = opts.initialMode ?? 'normal';
  const initialWhitespace = opts.initialWhitespace ? '1' : '0';
  const drainStatus = opts.drainStatus ?? 200;
  const healthCode = opts.healthOk === false ? '503' : '200';

  await writeStub(
    'flock',
    `#!/usr/bin/env bash
printf '%s\\n' "flock $*" >> "${log}"
if [ "${lockHeld}" = "1" ]; then exit 1; fi
exit 0
`
  );
  await writeStub(
    'docker',
    `#!/usr/bin/env bash
printf '%s\\n' "docker $*" >> "${log}"
if [[ "$*" == *printenv* ]]; then printf '%s\\n' 'tok-SENTINEL-123'; exit 0; fi
if [[ "$*" == *inspect* ]]; then printf '%s\\n' 'sha256:img'; exit 0; fi
if [[ "$*" == *"compose up -d app"* ]] && [ "${upFails}" = "1" ]; then exit 1; fi
exit 0
`
  );
  await writeStub(
    'curl',
    `#!/usr/bin/env bash
printf '%s\\n' "curl $*" >> "${log}"
out=""
want_code=0
data=""
is_health=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; prev=""; continue; fi
  if [ "$prev" = "-d" ]; then data="$arg"; prev=""; continue; fi
  if [ "$prev" = "-w" ]; then want_code=1; prev=""; continue; fi
  if [ "$prev" = "-H" ] || [ "$prev" = "-X" ] || [ "$prev" = "--max-time" ]; then prev=""; continue; fi
  case "$arg" in
    -o|-d|-w|-H|-X|--max-time) prev="$arg"; continue ;;
    *"/api/health"*) is_health=1 ;;
  esac
done
if [ "$is_health" = "1" ]; then printf '%s' ${healthCode}; exit 0; fi
if [ -n "$data" ]; then
  if [[ "$data" == *clearOnBoot* ]]; then printf '%s' "$data" > "${bodyFile}"; fi
  status=200
  if [[ "$data" == *'clearOnBoot":true'* || "$data" == *'clearOnBoot:true'* ]]; then
    status=${drainStatus}
    resp='{"changed":${changed},"mode":"draining"}'
  elif [[ "$data" == *'draining":false'* || "$data" == *'draining": false'* ]]; then
    resp='{"changed":true,"mode":"normal"}'
  else
    resp='{"changed":${changed},"mode":"draining"}'
  fi
  if [ -n "$out" ] && [ "$out" != "/dev/null" ]; then printf '%s' "$resp" > "$out"; fi
  if [ "$want_code" = "1" ]; then printf '%s' "$status"; else printf '%s' "$resp"; fi
  exit 0
fi
seen=$(cat "${getCount}")
if [ "$seen" = "0" ]; then
  printf '%s' 1 > "${getCount}"
  if [ "${initialWhitespace}" = "1" ]; then
    cat <<EOF
{
  "mode": "${initialMode}",
  "recreateSafe": false,
  "runningRunCount": 0,
  "pendingRunCount": 0,
  "activeRunIds": []
}
EOF
  else
    printf '%s' '{"mode":"${initialMode}","recreateSafe":false,"runningRunCount":0,"pendingRunCount":0,"activeRunIds":[]}'
  fi
  exit 0
fi
printf '%s\\n' POLL_LOOP >> "${log}"
n=$(cat "${curlCount}")
n=$((n + 1))
printf '%s' "$n" > "${curlCount}"
if [ "$n" -ge ${readyOn} ] && [ "${readyOn}" -gt 0 ]; then
  printf '%s' '{"mode":"${postUp}","recreateSafe":true,"runningRunCount":0,"pendingRunCount":0,"activeRunIds":[]}'
else
  printf '%s' '{"mode":"draining","recreateSafe":false,"runningRunCount":2,"pendingRunCount":1,"activeRunIds":["run-a","run-b"]}'
fi
exit 0
`
  );
  await writeStub(
    'git',
    `#!/usr/bin/env bash
printf '%s\\n' "git $*" >> "${log}"
if [ "$1" = "status" ] && [ "${dirty}" = "1" ]; then printf '%s\\n' ' M dirty.txt'; exit 0; fi
if [ "$1" = "rev-parse" ]; then printf '%s\\n' abc123; exit 0; fi
exit 0
`
  );
  await writeStub(
    'sqlite3',
    `#!/usr/bin/env bash
printf '%s\\n' "sqlite3 $*" >> "${log}"
exit 0
`
  );
  await writeStub(
    'df',
    `#!/usr/bin/env bash
printf '%s\\n' "df $*" >> "${log}"
printf '%s\\n' 'Avail'
printf '%s\\n' '20G'
exit 0
`
  );
  const prune = join(root, 'prune.sh');
  await writeFile(prune, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await chmod(prune, 0o755);
}

async function runScript(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; calls: string }> {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      REBUILD_LOCK_FILE: join(root, 'rebuild.lock'),
      REBUILD_REPO_DIR: root,
      REBUILD_DB: join(root, 'archon.db'),
      REBUILD_PRUNE_SCRIPT: join(root, 'prune.sh'),
      REBUILD_API_BASE: 'http://127.0.0.1:3090',
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const calls = await readFile(log, 'utf8').catch(() => '');
  return { exitCode, stdout, stderr, calls };
}

beforeEach(async () => {
  await setup({});
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('rebuild-archon.sh', () => {
  test('rebuild_script_drains_before_build', async () => {
    const { exitCode, stdout, calls } = await runScript([
      '--poll-sec',
      '0',
      '--drain-timeout-min',
      '5',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('DRAIN_CLEARED_BY_SCRIPT');
    const drainPost = calls.indexOf('clearOnBoot');
    const buildAt = calls.indexOf('compose build app');
    expect(drainPost).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeGreaterThan(drainPost);
    const gets = calls
      .split('\n')
      .filter(
        line =>
          line.startsWith('curl ') && line.includes('/api/admin/drain') && !line.includes('-d')
      );
    expect(gets.length).toBeGreaterThanOrEqual(3);
    expect(calls.indexOf('compose build app')).toBeGreaterThan(calls.indexOf('git status'));
    expect(calls).toContain('compose up -d app');
    expect(calls).toContain('draining":false');
    expect(calls.indexOf('compose build app')).toBeLessThan(calls.lastIndexOf('draining":false'));
  });

  test('rebuild_script_timeout_undrains_and_never_builds', async () => {
    await setup({ readyOn: 99 });
    const { exitCode, stdout, calls } = await runScript([
      '--poll-sec',
      '0',
      '--drain-timeout-min',
      '0',
    ]);
    expect(exitCode).toBe(3);
    expect(stdout).toContain('ABORT_DRAIN_TIMEOUT');
    expect(stdout).toContain('run-a');
    expect(calls).toContain('draining":false');
    expect(calls).not.toContain('compose build app');
  });

  test('rebuild_script_locked_and_foreign_drain_respected', async () => {
    await setup({ lockHeld: true });
    const locked = await runScript([]);
    expect(locked.exitCode).toBe(75);
    expect(locked.stdout).toContain('LOCKED');
    expect(locked.calls).not.toContain('curl ');
    expect(locked.calls).not.toContain('docker ');

    await setup({ changed: false, readyOn: 99 });
    const foreign = await runScript(['--poll-sec', '0', '--drain-timeout-min', '0']);
    expect(foreign.exitCode).toBe(3);
    expect(foreign.calls).not.toContain('draining":false');
    expect(foreign.calls).not.toContain('compose build app');
  });

  // Overseer review, bdc-harness#949, [major]: RECREATED used to be set
  // BEFORE `docker compose up -d app` ran, so a failing `up -d` tripped the
  // ERR trap with RECREATED already 1 -- undrain_if_mine's guard then
  // suppressed undraining even though no replacement container ever booted
  // to run clearOnBoot, leaving Cauldron drained indefinitely.
  test('rebuild_script_undrains_when_compose_up_fails', async () => {
    await setup({ upFails: true });
    const { exitCode, calls } = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    // set -euo pipefail means the script exits non-zero via the ERR trap
    // when `docker compose up -d app` fails; it never reaches the script's
    // own explicit exit codes (0/1/3/75) for this path.
    expect(exitCode).not.toBe(0);
    expect(calls).toContain('compose build app');
    expect(calls).toContain('compose up -d app');
    // The undrain call was actually made -- not suppressed by a
    // prematurely-set RECREATED guard.
    expect(calls).toContain('draining":false');
    const buildAt = calls.indexOf('compose build app');
    const upAt = calls.indexOf('compose up -d app');
    const undrainAt = calls.lastIndexOf('draining":false');
    expect(upAt).toBeGreaterThan(buildAt);
    expect(undrainAt).toBeGreaterThan(upAt);
    // Never reached the post-recreate drain-clear branch or the pruning
    // tail -- the script aborted at the failed `up -d`, before any of that.
    expect(calls).not.toContain('DRAIN_CLEARED_BY_SCRIPT');
    expect(calls).not.toContain('builder prune');
  });

  test('rebuild_script_json_escapes_the_drain_reason', async () => {
    // A USER value containing a double quote and a backslash must not
    // produce malformed JSON or inject a field into the drain request body.
    await setup({});
    const { exitCode, calls } = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5'], {
      USER: 'j"o\\hn',
    });
    expect(exitCode).toBe(0);
    const drainCall = calls
      .split('\n')
      .find(line => line.startsWith('curl ') && line.includes('clearOnBoot'));
    expect(drainCall).toBeDefined();
    // The quote and backslash are escaped, not left raw -- a raw '"' here
    // would terminate the JSON string value early and corrupt the payload.
    expect(drainCall).toContain('j\\"o\\\\hn');
    expect(drainCall).not.toMatch(/reason":"rebuild [^\\]*j"o/);
  });

  test('rebuild_script_never_prints_token', async () => {
    const ok = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).not.toContain('tok-SENTINEL-123');
    expect(ok.stderr).not.toContain('tok-SENTINEL-123');

    await setup({ dirty: true });
    const aborted = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    expect(aborted.exitCode).toBe(1);
    expect(aborted.stdout).toContain('ABORT_DIRTY');
    expect(aborted.stdout).not.toContain('tok-SENTINEL-123');
    expect(aborted.stderr).not.toContain('tok-SENTINEL-123');
    expect(aborted.calls).toContain('draining":false');
  });

  test('rebuild_script_whitespace_foreign_drain_is_not_adopted', async () => {
    await setup({ initialMode: 'draining', initialWhitespace: true, readyOn: 1 });
    const ok = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    expect(ok.exitCode).toBe(0);
    expect(ok.calls).not.toContain('clearOnBoot');
    expect(ok.calls).not.toContain('draining":false');
    expect(ok.stdout).not.toContain('DRAIN_CLEARED_BY_SCRIPT');
  });

  test('rebuild_script_never_touches_a_foreign_drain', async () => {
    await setup({ initialMode: 'draining', readyOn: 1 });
    const ok = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    expect(ok.exitCode).toBe(0);
    expect(ok.calls).not.toContain('clearOnBoot');
    expect(ok.calls).not.toContain('draining":false');
    expect(ok.stdout).not.toContain('DRAIN_CLEARED_BY_SCRIPT');

    await setup({ initialMode: 'draining', dirty: true, readyOn: 1 });
    const aborted = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5']);
    expect(aborted.exitCode).toBe(1);
    expect(aborted.stdout).toContain('ABORT_DIRTY');
    expect(aborted.calls).not.toContain('clearOnBoot');
    expect(aborted.calls).not.toContain('draining":false');
    expect(aborted.calls).not.toContain('compose build app');
  });

  test('rebuild_script_interrupt_exits_and_never_builds', async () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      await setup({ readyOn: 99 });
      const proc = Bun.spawn(['bash', SCRIPT, '--poll-sec', '30', '--drain-timeout-min', '10'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REBUILD_LOCK_FILE: join(root, 'rebuild.lock'),
          REBUILD_REPO_DIR: root,
          REBUILD_DB: join(root, 'archon.db'),
          REBUILD_PRUNE_SCRIPT: join(root, 'prune.sh'),
          REBUILD_API_BASE: 'http://127.0.0.1:3090',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const started = Date.now();
      let sawPoll = false;
      while (Date.now() - started < 10000) {
        const calls = await readFile(log, 'utf8').catch(() => '');
        if (calls.includes('POLL_LOOP')) {
          sawPoll = true;
          break;
        }
        await Bun.sleep(50);
      }
      expect(sawPoll).toBe(true);
      proc.kill(signal);
      const exitCode = await proc.exited;
      const calls = await readFile(log, 'utf8');
      expect(exitCode).toBe(code);
      const undrains = calls.split('\n').filter(line => line.includes('draining":false'));
      expect(undrains).toHaveLength(1);
      expect(calls).not.toContain('compose build app');
      expect(calls).not.toContain('compose up -d app');
    }
  });

  test('json_escape_control_chars', async () => {
    await setup({});
    const user = 'op\tcr\rnl\nend';
    const { exitCode } = await runScript(['--poll-sec', '0', '--drain-timeout-min', '5'], {
      USER: user,
    });
    expect(exitCode).toBe(0);
    const bodyText = await readFile(join(root, 'last-drain-body.json'), 'utf8');
    const parsed = JSON.parse(bodyText) as { reason: string };
    expect(parsed.reason).toContain('\t');
    expect(parsed.reason).toContain('\r');
    expect(parsed.reason).toContain('\n');
    expect(bodyText).toContain('\\t');
    expect(bodyText).toContain('\\r');
    expect(bodyText).toContain('\\n');
  });

  // Overseer review, bdc-harness#949, 5af0c893: RECREATED flipped as soon as
  // `up -d` returned, so a replacement that never became healthy left a
  // script-owned drain in place. Cleanup must run on ABORT_HEALTH.
  test('rebuild_script_health_never_ready_releases_drain', async () => {
    await setup({ healthOk: false });
    const pruneLog = join(root, 'prune.log');
    await writeFile(
      join(root, 'prune.sh'),
      `#!/usr/bin/env bash\nprintf '%s\\n' pruned >> "${pruneLog}"\n`,
      { mode: 0o755 }
    );
    await chmod(join(root, 'prune.sh'), 0o755);
    await writeStub(
      'sleep',
      `#!/usr/bin/env bash
printf '%s\\n' "sleep $*" >> "${log}"
exit 0
`
    );
    const { exitCode, stdout, calls } = await runScript(
      ['--poll-sec', '0', '--drain-timeout-min', '5'],
      { REBUILD_HEALTH_TIMEOUT_SEC: '2' }
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain('ABORT_HEALTH');
    expect(stdout).not.toContain('DRAIN_CLEARED_BY_SCRIPT');
    expect(stdout).not.toContain('archon:latest');
    expect(calls).toContain('/api/health');
    const undrains = calls.split('\n').filter(line => line.includes('draining":false'));
    expect(undrains).toHaveLength(1);
    expect(undrains[0]).toContain('rebuild aborted');
    const upAt = calls.indexOf('compose up -d app');
    const undrainAt = calls.lastIndexOf('draining":false');
    expect(upAt).toBeGreaterThanOrEqual(0);
    expect(undrainAt).toBeGreaterThan(upAt);
    expect(calls).not.toContain('builder prune');
    expect(calls).not.toContain('cleared after recreate');
    const pruneRan = await readFile(pruneLog, 'utf8').catch(() => '');
    expect(pruneRan).toBe('');
  });

  test('rebuild_script_drain_request_failure_fails_fast', async () => {
    for (const status of [401, 500]) {
      await setup({ drainStatus: status });
      const started = Date.now();
      const { exitCode, stdout, calls } = await runScript([
        '--poll-sec',
        '30',
        '--drain-timeout-min',
        '120',
      ]);
      expect(Date.now() - started).toBeLessThan(10000);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('ABORT_DRAIN_REQUEST_FAILED');
      expect(calls).not.toContain('POLL_LOOP');
      expect(calls).not.toContain('git status');
      expect(calls).not.toContain('compose build app');
      expect(calls).not.toContain('compose up -d app');
    }
  });
});
