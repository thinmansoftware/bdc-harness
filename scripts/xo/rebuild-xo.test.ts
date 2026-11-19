/**
 * scripts/xo/rebuild-xo.sh (WO-HARNESS-SECRETS-OUT-OF-BUILD-CONTEXT-01, bdc-xo#5444).
 *
 * Runs the real script with bash against stub `docker`, `git`, `curl`, `sqlite3`,
 * `sudo`, `df` and `sleep` commands placed first on PATH. Each stub appends its
 * arguments to one call log, so the test can assert what the script did and in
 * what order without a Docker daemon or a host checkout. Environment knobs make
 * one step fail at a time: STUB_BUILD_RC, STUB_UP_RC, STUB_ROLLBACK_UP_RC, STUB_ROLLBACK_UNHEALTHY, STUB_TAG_RC, STUB_BACKUP_RC,
 * STUB_CURL_FAIL, and STUB_CMP_RC for serve-lanes.sh.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const script = new URL('./rebuild-xo.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const serveLanes = new URL('./serve-lanes.sh', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
);

const PREV = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);

const STUBS: Record<string, string> = {
  docker: `#!/bin/bash
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
  "compose config") echo app ;;
  "compose build") exit "\${STUB_BUILD_RC:-0}" ;;
  "compose up")
    case "$*" in
      *--force-recreate*) touch "$STUB_LOG.rolled"; exit "\${STUB_ROLLBACK_UP_RC:-0}" ;;
    esac
    exit "\${STUB_UP_RC:-0}" ;;
  "exec archon-app-1")
    case "$3" in
      printenv) echo tok ;;
      sh) echo /app/.archon/workflows/defaults/bdc-feature-development-x.yaml ;;
      cmp) exit "\${STUB_CMP_RC:-0}" ;;
    esac ;;
  "inspect --format")
    case "$3" in
      *Health*)
        if [ -n "\${STUB_HEALTH_SEQ:-}" ] && [ ! -e "$STUB_LOG.rolled" ]; then
          n=$(( $(cat "$STUB_LOG.hc" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_LOG.hc"
          set -- $STUB_HEALTH_SEQ; [ "$n" -gt "$#" ] && n=$#; shift $((n - 1)); echo "$1"
        elif [ "\${STUB_ROLLBACK_UNHEALTHY:-0}" = 1 ] && [ -e "$STUB_LOG.rolled" ]; then echo unhealthy; else echo healthy; fi ;;
      *RestartCount*) echo 0 ;;
    esac ;;
  "inspect -f") echo created ;;
  "logs --timestamps") echo "boot output"; exit "\${STUB_LOGS_RC:-0}" ;;
  "top archon-app-1") echo "PID ELAPSED STAT ARGS" ;;
esac
[ "$1" = tag ] && exit "\${STUB_TAG_RC:-0}"
exit 0
`,
  git: `#!/bin/bash
echo "git $*" >> "$STUB_LOG"
case "$1" in
  status) ;;
  fetch) exit "\${STUB_FETCH_RC:-0}" ;;
  rev-parse)
    if [ "$2" = "--short" ]; then echo "\${3:0:7}"
    elif [ "$2" = "origin/dev" ]; then echo "${TARGET}"
    else echo "${PREV}"; fi ;;
esac
exit 0
`,
  // Stateful drain: POST draining:true sets the state, draining:false clears it,
  // GET and POST bodies report the mode. STUB_CURL_FAIL=1 makes every call exit 7.
  curl: `#!/bin/bash
echo "curl $*" >> "$STUB_LOG"
[ "\${STUB_CURL_FAIL:-0}" = 1 ] && exit 7
STATE="$STUB_LOG.drain"
case "$*" in
  *'"draining":true'*) echo draining > "$STATE" ;;
  *'"draining":false'*) [ "\${STUB_STICKY_DRAIN:-0}" = 1 ] || echo normal > "$STATE" ;;
esac
MODE=$(cat "$STATE" 2>/dev/null || echo normal)
DRAINED=false
[ "$MODE" = draining ] && [ "\${STUB_NOT_DRAINED:-0}" != 1 ] && DRAINED=true
case "$*" in
  *"%{http_code}"*) printf 200 ;;
  *) echo "{\\"mode\\":\\"$MODE\\",\\"drained\\":$DRAINED,\\"activeRunCount\\":0}" ;;
esac
exit 0
`,
  sqlite3: `#!/bin/bash
echo "sqlite3 $*" >> "$STUB_LOG"
case "$*" in
  *"select count"*) echo 0 ;;
  *".backup"*)
    [ "\${STUB_BACKUP_RC:-0}" -ne 0 ] && exit "\${STUB_BACKUP_RC}"
    dest="\${2#.backup }"; echo backup > "$dest" ;;
esac
exit 0
`,
  sudo: `#!/bin/bash
echo "sudo $*" >> "$STUB_LOG"
# STUB_SUDO_HIDE=1: paths under ARCHON_DIR are visible ONLY through sudo (they live in ARCHON_DIR.hidden),
# like the mode-750 DB folder on the host that the ssh user cannot read.
if [ "\${STUB_SUDO_HIDE:-0}" = 1 ]; then
  a=(); for x in "$@"; do a+=("\${x//$ARCHON_DIR/$ARCHON_DIR.hidden}"); done
  set -- "\${a[@]}"
fi
if [ "$1" = timeout ] && [ -n "\${STUB_WARM_RC:-}" ]; then exit "$STUB_WARM_RC"; fi
exec "$@"
`,
  df: `#!/bin/bash
printf 'Avail\\n 80G\\n'
exit 0
`,
  sleep: `#!/bin/bash
exit 0
`,
};

interface RunResult {
  status: number | null;
  out: string;
  calls: string[];
  /** Names left in ARCHON_DIR.hidden (STUB_SUDO_HIDE=1) when the script finished, sorted. */
  hidden: string[];
}

function runScript(
  extraEnv: Record<string, string> = {},
  target: string = script,
  args: string[] = ['1'],
  setup?: (root: string) => void
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-xo-'));
  try {
    const root = dir.replace(/\\/g, '/');
    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(`${bin}/${name}`, body, { mode: 0o755 });
      chmodSync(`${bin}/${name}`, 0o755);
    }
    // Stub lane sync for the rebuild script (the real serve-lanes.sh is exercised by its own tests):
    // STUB_LANES=differs reports a lane that stays different, STUB_LANES=none reports nothing.
    writeFileSync(
      `${root}/serve-lanes.sh`,
      '#!/bin/sh\ncase "${STUB_LANES:-same}" in\n  differs) echo "a.yaml DIFFERS" ;;\n  none) ;;\n  *) echo "a.yaml SAME" ;;\nesac\nexit 0\n'
    );
    const log = `${root}/calls.log`;
    writeFileSync(log, '');
    if (extraEnv.STUB_SUDO_HIDE === '1') mkdirSync(`${root}.hidden`, { recursive: true });
    setup?.(root);
    const res = spawnSync('bash', [target.replace(/\\/g, '/'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ARCHON_DIR: root,
        DB: `${root}/archon.db`,
        SCRIPTS_DIR: root,
        STUB_LOG: log,
        // Failure evidence goes to the temp folder, never the real home folder.
        REBUILD_FAIL_DIR: root,
        ...extraEnv,
      },
    });
    let hidden: string[] = [];
    try {
      hidden = readdirSync(`${root}.hidden`).sort();
    } catch {
      hidden = [];
    }
    return {
      status: res.status,
      out: `${res.stdout}\n${res.stderr}`,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
      hidden,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.hidden`, { recursive: true, force: true });
  }
}

const has = (r: RunResult, prefix: string): boolean => r.calls.some(c => c.startsWith(prefix));

describe('rebuild-xo.sh', () => {
  it('stops when the image build fails, keeps the old container, undrains and restores the checkout (Test 3)', () => {
    const r = runScript({ STUB_BUILD_RC: '1' });
    expect(r.status).toBe(5);
    expect(r.out).toContain('ABORT_BUILD rc=1');
    expect(has(r, 'docker compose up')).toBe(false);
    expect(has(r, 'docker tag archon:latest archon:rollback-')).toBe(true);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(true);
    const checkouts = r.calls.filter(c => c.startsWith('git checkout'));
    expect(checkouts.length).toBe(2);
    expect(checkouts[0]).toContain(TARGET);
    expect(checkouts[1]).toContain(PREV);
  }, 60_000);

  it('a good build still reaches up and finishes (Test 4)', () => {
    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.out).toContain('=== DONE');
    const build = r.calls.findIndex(c => c.startsWith('docker compose build'));
    const up = r.calls.findIndex(c => c.startsWith('docker compose up'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(build);
    expect(r.out).not.toContain('ABORT_');
  }, 60_000);

  it('does not proceed when drain is not confirmed (Test 7)', () => {
    const r = runScript({ STUB_CURL_FAIL: '1' });
    expect(r.status).toBe(3);
    expect(r.out).toContain('ABORT_DRAIN');
    expect(has(r, 'docker compose build')).toBe(false);
    expect(has(r, 'docker compose up')).toBe(false);
    expect(has(r, 'docker tag')).toBe(false);
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);

  it('does not rebuild without a database backup (Test 8)', () => {
    const r = runScript({ STUB_BACKUP_RC: '1' });
    expect(r.status).toBe(3);
    expect(r.out).toContain('ABORT_BACKUP');
    expect(has(r, 'docker compose build')).toBe(false);
    expect(has(r, 'docker compose up')).toBe(false);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(true);
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);

  it('does not rebuild without a pinned rollback image (Test 9)', () => {
    const r = runScript({ STUB_TAG_RC: '1' });
    expect(r.status).toBe(3);
    expect(r.out).toContain('ABORT_PIN');
    expect(has(r, 'docker compose build')).toBe(false);
    expect(has(r, 'docker compose up')).toBe(false);
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);

  it('rolls back when compose up fails even if the old container looks healthy (Test 10)', () => {
    const r = runScript({ STUB_UP_RC: '1' });
    expect(r.status).toBe(4);
    expect(r.out).toContain('=== ROLLBACK');
    expect(r.out).not.toContain('=== DONE');
    expect(r.calls.some(c => /^docker tag archon:rollback-\S+ archon:latest$/.test(c))).toBe(true);
    expect(r.calls.some(c => c.includes('--no-build --force-recreate'))).toBe(true);
    const checkouts = r.calls.filter(c => c.startsWith('git checkout'));
    expect(checkouts[checkouts.length - 1]).toContain(PREV);
  }, 60_000);

  it('leaves drain ON and exits 8 when the rollback recreate fails (bdc-xo#5444 review)', () => {
    const r = runScript({ STUB_UP_RC: '1', STUB_ROLLBACK_UP_RC: '1' });
    expect(r.status).toBe(8);
    expect(r.out).toContain('ROLLBACK_STEP_FAILED: could not recreate the container');
    expect(r.out).toContain('ROLLBACK_FAILED');
    expect(r.out).not.toContain('=== DONE');
    // drain was turned on before the build and is never cleared after the failed rollback
    expect(r.calls.some(c => c.includes('"draining":true'))).toBe(true);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(false);
  }, 60_000);

  it('leaves drain ON and exits 8 when the restored container is not healthy (bdc-xo#5444 review)', () => {
    const r = runScript({ STUB_UP_RC: '1', STUB_ROLLBACK_UNHEALTHY: '1' });
    expect(r.status).toBe(8);
    expect(r.out).toContain('rollback health=unhealthy');
    expect(r.out).toContain('ROLLBACK_FAILED');
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(false);
  }, 60_000);

  it('clears drain after a rollback only when every step worked and the container is healthy (bdc-xo#5444 review)', () => {
    const r = runScript({ STUB_UP_RC: '1' });
    expect(r.status).toBe(4);
    expect(r.out).toContain('rollback health=healthy api=200');
    expect(r.out).not.toContain('ROLLBACK_FAILED');
    const lastDrain = r.calls.filter(c => c.includes('"draining"')).pop() ?? '';
    expect(lastDrain).toContain('"draining":false');
  }, 60_000);

  it('waits for the drain API to report drained, not for a narrower run count (Test 13)', () => {
    const r = runScript({ STUB_NOT_DRAINED: '1' });
    expect(r.status).toBe(3);
    expect(r.out).toContain('ABORT: not drained');
    expect(has(r, 'docker tag')).toBe(false);
    expect(has(r, 'docker compose build')).toBe(false);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(true);
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);

  it('does not build a stale commit when git fetch fails (Test 14)', () => {
    const r = runScript({ STUB_FETCH_RC: '1' });
    expect(r.status).toBe(3);
    expect(r.out).toContain('ABORT_FETCH');
    expect(has(r, 'docker compose build')).toBe(false);
    expect(has(r, 'docker compose up')).toBe(false);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(true);
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);

  it('fails and leaves drain on when the lanes cannot be verified identical (Test 15)', () => {
    for (const lanes of ['differs', 'none']) {
      const r = runScript({ STUB_LANES: lanes });
      expect(r.status).toBe(6);
      expect(r.out).toContain('ABORT_LANES');
      expect(r.out).not.toContain('=== DONE');
      const drainPosts = r.calls.filter(
        c => c.includes('/api/admin/drain') && c.includes('draining')
      );
      expect(drainPosts[drainPosts.length - 1]).toContain('"draining":true');
    }
  }, 120_000);

  it('fails loudly when drain will not clear after the rebuild (Test 16)', () => {
    const r = runScript({ STUB_STICKY_DRAIN: '1' });
    expect(r.status).toBe(7);
    expect(r.out).toContain('DRAIN_STUCK');
    expect(r.out).not.toContain('=== DONE');
  }, 60_000);
  // WO-HARNESS-BOOT-CHOWN-WALK-AND-REBUILD-EVIDENCE-01, Test 4 (bdc-xo #6097): P4 reads the backup through sudo.
  it('p4_sees_a_backup_only_sudo_can_read', () => {
    const r = runScript({ STUB_SUDO_HIDE: '1' });
    expect(r.out).not.toContain('ABORT_BACKUP');
    expect(r.calls.some(c => /^sudo test -s \S+\/archon\.db\.pre-rebuild-\S+$/.test(c))).toBe(true);
    expect(has(r, 'docker compose build')).toBe(true);
    const missing = runScript({ STUB_SUDO_HIDE: '1', STUB_BACKUP_RC: '1' });
    expect(missing.status).toBe(3);
    expect(missing.out).toContain('ABORT_BACKUP');
  }, 60_000);

  // Test 5: the prune sees the backups only through sudo, keeps the newest two and removes the rest.
  it('prune_keeps_the_newest_two_backups_through_sudo', () => {
    const r = runScript({ STUB_SUDO_HIDE: '1' }, script, ['1'], root => {
      ['A', 'B', 'C', 'D'].forEach((n, k) => {
        const f = `${root}.hidden/archon.db.pre-rebuild-0${n}`;
        writeFileSync(f, 'b');
        const t = new Date(Date.UTC(2026, 9, 1 + k));
        utimesSync(f, t, t);
      });
    });
    expect(r.status).toBe(0);
    const prune = r.calls.find(c => c.startsWith('sudo sh -c '));
    expect(prune).toBeDefined();
    // DBDIR is passed as an argument after "_", never inside the quoted script.
    expect(prune).toMatch(/ _ \S+$/);
    // Kept: tonight's new backup (newest) plus the newest older one (D); A, B and C are removed.
    const kept = r.hidden.filter(n => n.startsWith('archon.db.pre-rebuild-'));
    expect(kept.length).toBe(2);
    expect(kept).toContain('archon.db.pre-rebuild-0D');
    expect(kept).not.toContain('archon.db.pre-rebuild-0A');
  }, 60_000);

  // Test 6: the cache is warmed before up, and a warm-up timeout never aborts the rebuild.
  it('cache_is_warmed_before_up_and_never_aborts', () => {
    const r = runScript();
    const warm = r.calls.findIndex(c =>
      c.startsWith('sudo timeout 600 find /opt/bdc/archon-data /opt/bdc/archon-user-home')
    );
    const up = r.calls.findIndex(c => c.startsWith('docker compose up'));
    expect(warm).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(warm);
    const slow = runScript({ STUB_WARM_RC: '124' });
    expect(slow.out).toContain('warm: timed out after 600 s (continuing)');
    expect(slow.status).toBe(0);
    expect(slow.out).toContain('=== DONE');
  }, 60_000);

  // Test 7: an early "unhealthy" is not final; the bound is 360 s (72 polls of 5 s).
  it('health_wait_survives_an_early_unhealthy', () => {
    const ok = runScript({ STUB_HEALTH_SEQ: 'starting unhealthy unhealthy unhealthy healthy' });
    expect(ok.out).toContain('=== V: health (up to 360 s) ===');
    expect(ok.out).not.toContain('=== ROLLBACK');
    expect(ok.status).toBe(0);
    const fd = mkdtempSync(join(tmpdir(), 'rebuild-fail-'));
    try {
      const bad = runScript({
        STUB_HEALTH_SEQ: 'unhealthy',
        REBUILD_FAIL_DIR: fd.replace(/\\/g, '/'),
      });
      const vPolls = bad.calls.filter(
        c => c.startsWith('docker inspect --format') && c.includes('Health')
      ).length;
      // 72 polls in the V phase, then one rollback poll (the rollback container reports healthy at once).
      expect(vPolls).toBe(73);
      expect(bad.out).toContain('=== ROLLBACK');
      expect(bad.status).toBe(4);
    } finally {
      rmSync(fd, { recursive: true, force: true });
    }
  }, 60_000);

  // Test 8: the failed start's logs, health and top are saved BEFORE any rollback command.
  it('failed_start_evidence_is_saved_before_rollback', () => {
    const fd = mkdtempSync(join(tmpdir(), 'rebuild-fail-'));
    try {
      const r = runScript({ STUB_UP_RC: '1', REBUILD_FAIL_DIR: fd.replace(/\\/g, '/') });
      const logs = r.calls.findIndex(c => c.startsWith('docker logs --timestamps archon-app-1'));
      const health = r.calls.findIndex(c =>
        c.startsWith('docker inspect -f {{json .State.Health}}')
      );
      const top = r.calls.findIndex(c => c.startsWith('docker top archon-app-1'));
      const firstRollback = r.calls.findIndex(c => c.startsWith('docker tag archon:rollback-'));
      expect(firstRollback).toBeGreaterThanOrEqual(0);
      for (const k of [logs, health, top]) {
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(firstRollback);
      }
      expect(r.out).toMatch(/saved: \S+rebuild-fail-\S+\.log \S+\.health\.json \S+\.top\.txt/);
      const saved = readdirSync(fd);
      expect(saved.some(f => f.endsWith('.log'))).toBe(true);
      expect(saved.some(f => f.endsWith('.health.json'))).toBe(true);
      expect(saved.some(f => f.endsWith('.top.txt'))).toBe(true);
      // A failing docker logs never stops the rollback.
      const broken = runScript({
        STUB_UP_RC: '1',
        STUB_LOGS_RC: '1',
        REBUILD_FAIL_DIR: fd.replace(/\\/g, '/'),
      });
      expect(broken.out).toContain('WARN: could not save docker logs');
      expect(broken.calls.some(c => c.startsWith('docker tag archon:rollback-'))).toBe(true);
      expect(broken.status).toBe(4);
    } finally {
      rmSync(fd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('serve-lanes.sh', () => {
  it('reports SAME and copies nothing when the served lane equals the baked one (Test 11)', () => {
    const r = runScript({ STUB_CMP_RC: '0' }, serveLanes, ['--apply']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('bdc-feature-development-x.yaml SAME');
    expect(r.calls.some(c => c.startsWith('docker exec archon-app-1 cp'))).toBe(false);
  }, 60_000);

  it('copies the baked lane over a differing served one only with --apply (Test 12)', () => {
    const dry = runScript({ STUB_CMP_RC: '1' }, serveLanes, []);
    expect(dry.out).toContain('bdc-feature-development-x.yaml DIFFERS');
    expect(dry.calls.some(c => c.startsWith('docker exec archon-app-1 cp'))).toBe(false);
    const applied = runScript({ STUB_CMP_RC: '1' }, serveLanes, ['--apply']);
    expect(applied.out).toContain('applied');
    expect(applied.calls.some(c => c.startsWith('docker exec archon-app-1 cp'))).toBe(true);
  }, 60_000);
});
