/**
 * Stub-PATH tests for deploy/rebuild-archon.sh.
 * docker, curl, git, sqlite3, df, and flock record every invocation.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

const SCRIPT = join(import.meta.dir, 'rebuild-archon.sh');

let root: string;
let bin: string;
let log: string;
let curlCount: string;
const acquiredToken = '11111111-1111-4111-8111-111111111111';
const replacementToken = '22222222-2222-4222-8222-222222222222';
const bashPath = (path: string): string =>
  path
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);

async function cleanupRoot(): Promise<void> {
  if (!root) return;
  const owned = relative(await realpath(tmpdir()), await realpath(root));
  if (owned.startsWith('..') || isAbsolute(owned) || !owned.startsWith('rebuild-archon-'))
    throw new Error('unsafe rebuild fixture cleanup');
  await rm(root, { recursive: true, force: true });
  root = '';
}

async function writeStub(name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, body.replaceAll(root, bashPath(root)), { mode: 0o755 });
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
  drainStatus?: number;
  healthOk?: boolean;
  replacementDrain?: boolean;
  drainTransportFail?: boolean;
  invalidGrant?:
    | 'missing'
    | 'malformed'
    | 'invalid_json'
    | 'duplicate'
    | 'trailing'
    | 'nonfinite'
    | 'array'
    | 'unsuccessful'
    | 'changed_number'
    | 'unowned_grant';
}): Promise<void> {
  await cleanupRoot();
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
  const drainStatus = opts.drainStatus ?? 200;
  const healthCode = opts.healthOk === false ? '503' : '200';
  const replacement = opts.replacementDrain ? '1' : '0';
  const transportFail = opts.drainTransportFail ? '1' : '0';
  const replacementFlag = join(root, 'replacement-drain');
  const grant =
    opts.changed === false
      ? 'null'
      : JSON.stringify(opts.invalidGrant === 'malformed' ? 'invalid' : acquiredToken);
  let grantResponse =
    opts.invalidGrant === 'invalid_json'
      ? 'not-json'
      : JSON.stringify({
          success: true,
          changed: opts.changed !== false,
          mode: 'draining',
          drainToken: opts.replacementDrain ? replacementToken : acquiredToken,
          ...(opts.invalidGrant === 'missing' ? {} : { acquiredDrainToken: JSON.parse(grant) }),
        });
  if (opts.invalidGrant === 'duplicate')
    grantResponse = grantResponse.replace('"changed":true', '"changed":true,"changed":true');
  if (opts.invalidGrant === 'trailing') grantResponse += '{}';
  if (opts.invalidGrant === 'nonfinite')
    grantResponse = grantResponse.replace('"success":true', '"extra":NaN,"success":true');
  if (opts.invalidGrant === 'array') grantResponse = '[]';
  if (opts.invalidGrant === 'unsuccessful')
    grantResponse = grantResponse.replace('"success":true', '"success":false');
  if (opts.invalidGrant === 'changed_number')
    grantResponse = grantResponse.replace('"changed":true', '"changed":1');
  if (opts.invalidGrant === 'unowned_grant')
    grantResponse = grantResponse.replace('"changed":true', '"changed":false');

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
    resp='${grantResponse}'
    if [ "${transportFail}" = "1" ]; then exit 56; fi
  elif [[ "$data" == *'draining":false'* || "$data" == *'draining": false'* ]]; then
    resp='{"changed":true,"mode":"normal"}'
    if [ -f "${replacementFlag}" ]; then
      if [[ "$data" == *'"expectedDrainToken":"${acquiredToken}"'* ]]; then
        status=409
        resp='{"error":"cauldron_drain_ownership_conflict"}'
      else
        printf '%s\\n' INCIDENT_CLEARED >> "${log}"
        rm -f "${replacementFlag}"
      fi
    fi
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
  printf '%s' '{"mode":"${initialMode}","recreateSafe":false,"runningRunCount":0,"pendingRunCount":0,"activeRunIds":[]}'
  exit 0
fi
printf '%s\\n' POLL_LOOP >> "${log}"
if [ "${replacement}" = "1" ]; then touch "${replacementFlag}"; fi
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

function spawnScript(
  args: string[],
  extraEnv: Record<string, string> = {}
): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(
    [
      'bash',
      '-c',
      `export PATH="$REBUILD_STUB_BIN:$PATH"; for tool in docker curl git sqlite3 df flock; do [ "$(command -v "$tool")" = "$REBUILD_STUB_BIN/$tool" ] || exit 97; done; printf '%s' "$$" > "$REBUILD_TEST_PID"; exec bash "$REBUILD_TEST_SCRIPT" "$@"`,
      'rebuild-fixture',
      ...args,
    ],
    {
      env: {
        ...process.env,
        REBUILD_STUB_BIN: bashPath(bin),
        REBUILD_TEST_SCRIPT: bashPath(SCRIPT),
        REBUILD_TEST_PID: bashPath(join(root, 'script.pid')),
        REBUILD_LOCK_FILE: bashPath(join(root, 'rebuild.lock')),
        REBUILD_REPO_DIR: bashPath(root),
        REBUILD_DB: bashPath(join(root, 'archon.db')),
        REBUILD_PRUNE_SCRIPT: bashPath(join(root, 'prune.sh')),
        REBUILD_PYTHON:
          process.env.REBUILD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
        REBUILD_API_BASE: 'http://127.0.0.1:3090',
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    }
  );
}

async function runScript(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; calls: string }> {
  const proc = spawnScript(args, extraEnv);
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
  await cleanupRoot();
});

describe('rebuild-archon.sh', () => {
  test('missing Python refuses before Docker or drain and lost acquisition response never guesses cleanup', async () => {
    const missing = await runScript([], { REBUILD_PYTHON: 'missing-fixture-python-executable' });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('ABORT_PYTHON3_REQUIRED');
    expect(missing.calls).toBe('');
    await setup({ drainTransportFail: true });
    const lost = await runScript([]);
    expect(lost.exitCode).toBe(1);
    expect(lost.stdout).toContain('ABORT_DRAIN_OWNERSHIP_UNKNOWN');
    expect(lost.calls).not.toContain('draining":false');
    expect(lost.calls).not.toContain('compose build');
  });
  for (const options of [
    { readyOn: 99 },
    { dirty: true },
    { upFails: true },
    { healthOk: false },
    {},
  ]) {
    test(`replacement incident drain survives automatic cleanup ${JSON.stringify(options)}`, async () => {
      await setup({ ...options, replacementDrain: true });
      const result = await runScript(
        ['--poll-sec', '0', '--drain-timeout-min', 'readyOn' in options ? '0' : '5'],
        { REBUILD_HEALTH_TIMEOUT_SEC: '1' }
      );
      expect(result.exitCode).not.toBe(97);
      expect(result.calls).not.toContain('INCIDENT_CLEARED');
      const clears = result.calls
        .split('\n')
        .filter(line => line.startsWith('curl ') && line.includes('draining":false'));
      expect(clears.length).toBeGreaterThan(0);
      for (const clear of clears)
        expect(clear).toContain(`"expectedDrainToken":"${acquiredToken}"`);
      expect(result.stdout).not.toContain('DRAIN_CLEARED_BY_SCRIPT');
    });
  }
  for (const invalidGrant of [
    'missing',
    'malformed',
    'invalid_json',
    'duplicate',
    'trailing',
    'nonfinite',
    'array',
    'unsuccessful',
    'changed_number',
    'unowned_grant',
  ] as const) {
    test(`invalid acquisition proof refuses build and unconditional cleanup (${invalidGrant})`, async () => {
      await setup({ invalidGrant });
      const result = await runScript(['--poll-sec', '0']);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('ABORT_DRAIN_OWNERSHIP_UNKNOWN');
      expect(result.calls).not.toContain('compose build');
      expect(result.calls).not.toContain('draining":false');
    });
  }
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
      // Short, real sleeps bound Bash's deferred trap handling without changing
      // the production polling interval or simulating the signal itself.
      await writeStub(
        'sleep',
        '#!/usr/bin/env bash\n"$REBUILD_PYTHON" -c "import time; time.sleep(0.1)"\n'
      );
      const proc = spawnScript(['--poll-sec', '30', '--drain-timeout-min', '10']);
      const output = [new Response(proc.stdout).text(), new Response(proc.stderr).text()];
      let exited = false;
      try {
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
        const pid = await readFile(join(root, 'script.pid'), 'utf8');
        if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('invalid owned fixture process id');
        const sent = Bun.spawnSync(
          ['bash', '-c', 'kill -s "$1" "$2"', 'signal-fixture', signal.slice(3), pid],
          { stdout: 'pipe', stderr: 'pipe' }
        );
        expect(sent.exitCode).toBe(0);
        const exitCode = await proc.exited;
        exited = true;
        const calls = await readFile(log, 'utf8');
        expect(exitCode).toBe(code);
        const undrains = calls.split('\n').filter(line => line.includes('draining":false'));
        expect(undrains).toHaveLength(1);
        expect(undrains[0]).toContain(`"expectedDrainToken":"${acquiredToken}"`);
        expect(calls).not.toContain('compose build app');
        expect(calls).not.toContain('compose up -d app');
      } finally {
        if (!exited) {
          proc.kill('SIGKILL');
          await proc.exited;
        }
        await Promise.all(output);
      }
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
