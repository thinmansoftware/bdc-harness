/**
 * scripts/xo/rebuild-xo.sh (WO-HARNESS-SECRETS-OUT-OF-BUILD-CONTEXT-01, bdc-xo#5444).
 *
 * Runs the real script with bash against stub `docker`, `git`, `curl`, `sqlite3`,
 * `sudo`, `df` and `sleep` commands placed first on PATH. Each stub appends its
 * arguments to one call log, so the test can assert what the script did and in
 * what order without a Docker daemon or a host checkout. Environment knobs make
 * one step fail at a time: STUB_BUILD_RC, STUB_UP_RC, STUB_TAG_RC, STUB_BACKUP_RC,
 * STUB_CURL_FAIL, and STUB_CMP_RC for serve-lanes.sh.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  "compose up") exit "\${STUB_UP_RC:-0}" ;;
  "exec archon-app-1")
    case "$3" in
      printenv) echo tok ;;
      sh) echo /app/.archon/workflows/defaults/bdc-feature-development-x.yaml ;;
      cmp) exit "\${STUB_CMP_RC:-0}" ;;
    esac ;;
  "inspect --format")
    case "$3" in *Health*) echo healthy ;; *RestartCount*) echo 0 ;; esac ;;
  "inspect -f") echo created ;;
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
}

function runScript(
  extraEnv: Record<string, string> = {},
  target: string = script,
  args: string[] = ['1']
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
    const res = spawnSync('bash', [target.replace(/\\/g, '/'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ARCHON_DIR: root,
        DB: `${root}/archon.db`,
        SCRIPTS_DIR: root,
        STUB_LOG: log,
        ...extraEnv,
      },
    });
    return {
      status: res.status,
      out: `${res.stdout}\n${res.stderr}`,
      calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
