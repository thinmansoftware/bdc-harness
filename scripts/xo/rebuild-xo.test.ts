/**
 * scripts/xo/rebuild-xo.sh (WO-HARNESS-SECRETS-OUT-OF-BUILD-CONTEXT-01, bdc-xo#5444).
 *
 * Runs the real script with bash against stub `docker`, `git`, `curl`, `sqlite3`,
 * `sudo`, `df` and `sleep` commands placed first on PATH. Each stub appends its
 * arguments to one call log, so the test can assert what the script did and in
 * what order without a Docker daemon or a host checkout.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const script = new URL('./rebuild-xo.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const PREV = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);

const STUBS: Record<string, string> = {
  docker: `#!/bin/bash
echo "docker $*" >> "$STUB_LOG"
case "$1 $2" in
  "compose config") echo app ;;
  "compose build") exit "\${STUB_BUILD_RC:-0}" ;;
  "exec archon-app-1") [ "$3" = printenv ] && echo tok ;;
  "inspect --format")
    case "$3" in *Health*) echo healthy ;; *RestartCount*) echo 0 ;; esac ;;
  "inspect -f") echo created ;;
esac
exit 0
`,
  git: `#!/bin/bash
echo "git $*" >> "$STUB_LOG"
case "$1" in
  status) ;;
  fetch) ;;
  rev-parse)
    if [ "$2" = "--short" ]; then echo "\${3:0:7}"
    elif [ "$2" = "origin/dev" ]; then echo "${TARGET}"
    else echo "${PREV}"; fi ;;
esac
exit 0
`,
  curl: `#!/bin/bash
echo "curl $*" >> "$STUB_LOG"
case "$*" in
  *"%{http_code}"*) printf 200 ;;
  *) echo '{"mode":"normal","activeRunCount":0}' ;;
esac
exit 0
`,
  sqlite3: `#!/bin/bash
echo "sqlite3 $*" >> "$STUB_LOG"
case "$*" in *"select count"*) echo 0 ;; esac
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

function runScript(buildRc: number): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'rebuild-xo-'));
  try {
    const root = dir.replace(/\\/g, '/');
    const bin = `${root}/bin`;
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(`${bin}/${name}`, body, { mode: 0o755 });
      chmodSync(`${bin}/${name}`, 0o755);
    }
    writeFileSync(`${root}/serve-lanes.sh`, '#!/bin/sh\nexit 0\n');
    const log = `${root}/calls.log`;
    writeFileSync(log, '');
    const res = spawnSync('bash', [script.replace(/\\/g, '/'), '1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ARCHON_DIR: root,
        DB: `${root}/archon.db`,
        SCRIPTS_DIR: root,
        STUB_LOG: log,
        STUB_BUILD_RC: String(buildRc),
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

describe('rebuild-xo.sh', () => {
  it('stops when the image build fails, keeps the old container, undrains and restores the checkout (Test 3)', () => {
    const r = runScript(1);
    expect(r.status).toBe(5);
    expect(r.out).toContain('ABORT_BUILD rc=1');
    expect(r.calls.some(c => c.startsWith('docker compose up'))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker tag archon:latest archon:rollback-'))).toBe(true);
    expect(r.calls.some(c => c.includes('"draining":false'))).toBe(true);
    const checkouts = r.calls.filter(c => c.startsWith('git checkout'));
    expect(checkouts.length).toBe(2);
    expect(checkouts[0]).toContain(TARGET);
    expect(checkouts[1]).toContain(PREV);
  }, 60_000);

  it('a good build still reaches up and finishes (Test 4)', () => {
    const r = runScript(0);
    expect(r.status).toBe(0);
    expect(r.out).toContain('=== DONE');
    const build = r.calls.findIndex(c => c.startsWith('docker compose build'));
    const up = r.calls.findIndex(c => c.startsWith('docker compose up'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(build);
    expect(r.out).not.toContain('ABORT_BUILD');
  }, 60_000);
});
