/**
 * docker-entrypoint.sh ownership fix (WO-HARNESS-ENTRYPOINT-CHOWN-NO-CRASH-RESTART-01).
 *
 * Lifts the real ownership-fix block out of docker-entrypoint.sh by its
 * BEGIN/END markers (no re-typed copy) and runs it with bash. Shell functions
 * override `find`, `chown` and `gosu` so the test needs no root and no real
 * appuser: `find` maps /.archon and /home/appuser onto a temp tree and emulates
 * the "not owned by appuser" predicate by file name (wrong-*), `chown` only
 * records its arguments (and can be told to fail for one path), and `gosu`
 * answers the writability check.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entrypoint = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');

function extractBlock(source: string): string {
  const startMarker = '# BEGIN ownership-fix';
  const endMarker = '# END ownership-fix';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start)
    throw new Error('ownership-fix block not found in docker-entrypoint.sh');
  return source.slice(start, end + endMarker.length);
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  tree: string;
}

function runBlock(opts: { failMatch?: string; unwritable?: string } = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'archon-owner-'));
  // Forward slashes so Git Bash's find on Windows accepts the path as-is.
  const tree = dir.replace(/\\/g, '/');
  const log = `${tree}/calls.log`;
  // Many correctly-owned entries, two wrong-owner entries (one per root).
  for (const root of ['archon', 'home']) {
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(dir, root, `ws-${i}`, 'nested'), { recursive: true });
      writeFileSync(join(dir, root, `ws-${i}`, 'nested', 'ok.txt'), 'ok');
      writeFileSync(join(dir, root, `ws-${i}`, 'ok.txt'), 'ok');
    }
  }
  writeFileSync(join(dir, 'archon', 'ws-2', 'nested', 'wrong-a.txt'), 'x');
  writeFileSync(join(dir, 'home', 'ws-4', 'wrong-b.txt'), 'x');
  writeFileSync(log, '');

  const overrides = `
TREE='${tree}'
LOG='${log}'
FAIL_MATCH='${opts.failMatch ?? ''}'
UNWRITABLE='${opts.unwritable ?? ''}'
find() {
  echo "find $*" >> "$LOG"
  case "$1" in
    /.archon) _m="$TREE/archon" ;;
    /home/appuser) _m="$TREE/home" ;;
    *) return 1 ;;
  esac
  command find "$_m" -name 'wrong-*' -print0
}
chown() {
  echo "chown $*" >> "$LOG"
  if [ -n "$FAIL_MATCH" ]; then
    case "$3" in *"$FAIL_MATCH"*) return 1 ;; esac
  fi
  return 0
}
gosu() {
  echo "gosu $*" >> "$LOG"
  [ "$4" != "$UNWRITABLE" ]
}
`;
  const script = `set -e\n${overrides}\n${extractBlock(entrypoint)}\necho AFTER_BLOCK\n`;
  try {
    const res = spawnSync('bash', ['-c', script], {
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      encoding: 'utf8',
    });
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls, tree };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('entrypoint ownership-fix block', () => {
  it('only_wrong_owner_paths_are_touched', () => {
    const r = runBlock();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('AFTER_BLOCK');
    const chowns = r.calls.filter(c => c.startsWith('chown '));
    expect(chowns).toEqual([
      `chown -h appuser:appuser ${r.tree}/archon/ws-2/nested/wrong-a.txt`,
      `chown -h appuser:appuser ${r.tree}/home/ws-4/wrong-b.txt`,
    ]);
    for (const c of chowns) expect(c).not.toMatch(/(^| )-[a-zA-Z]*R/);
    // find is asked only for entries not owned by appuser, on both roots.
    const finds = r.calls.filter(c => c.startsWith('find '));
    expect(finds).toEqual([
      'find /.archon ! -user appuser -print0',
      'find /home/appuser ! -user appuser -print0',
    ]);
    expect(r.calls).toContain('gosu appuser test -w /.archon');
    expect(r.calls).toContain('gosu appuser test -w /home/appuser');
    expect(r.stderr).not.toContain('WARN');
    expect(r.stderr).not.toContain('ERROR');
  });

  it('partial_failure_warns_and_continues', () => {
    const r = runBlock({ failMatch: 'wrong-a.txt' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARN: could not fix ownership of 1 paths under /.archon');
    expect(r.stderr).not.toContain('ERROR');
    // The second root is still processed and the next command still runs.
    expect(r.calls).toContain(`chown -h appuser:appuser ${r.tree}/home/ws-4/wrong-b.txt`);
    expect(r.stdout).toContain('AFTER_BLOCK');
  });

  it('unwritable_root_fails_hard', () => {
    const r = runBlock({ unwritable: '/.archon' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'ERROR: Failed to fix ownership of /.archon -- volume may be read-only or mounted with incompatible options'
    );
    expect(r.stdout).not.toContain('AFTER_BLOCK');
  });
});
