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

function runBlock(
  opts: { failMatch?: string; unwritable?: string; extra?: (dir: string) => void } = {}
): RunResult {
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
  opts.extra?.(dir);
  writeFileSync(log, '');

  const overrides = `
TREE='${tree}'
LOG='${log}'
FAIL_MATCH='${opts.failMatch ?? ''}'
UNWRITABLE='${opts.unwritable ?? ''}'
find() {
  echo "find $*" >> "$LOG"
  case "$1" in
    /.archon|/home/appuser) ;;
    *) return 1 ;;
  esac
  # Run the REAL find with the REAL expression (so -prune and the comma operator are exercised),
  # mapping /.archon and /home/appuser onto the temp tree (also inside -path patterns) and the
  # "! -user appuser" predicate onto a name match (wrong-* stands for "not owned by appuser").
  _fa=()
  while [ "$#" -gt 0 ]; do
    if [ "$1" = '!' ] && [ "\${2:-}" = '-user' ] && [ "\${3:-}" = 'appuser' ]; then
      _fa+=(-name 'wrong-*'); shift 3; continue
    fi
    case "$1" in
      /.archon*) _fa+=("$TREE/archon\${1#/.archon}") ;;
      /home/appuser*) _fa+=("$TREE/home\${1#/home/appuser}") ;;
      *) _fa+=("$1") ;;
    esac
    shift
  done
  command find "\${_fa[@]}"
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
    // WO-HARNESS-BOOT-CHOWN-WALK-AND-REBUILD-EVIDENCE-01: /.archon prunes the run workspaces below
    // their top two levels with find's comma operator; /home/appuser is unchanged.
    expect(finds).toEqual([
      'find /.archon ( ! -user appuser -print0 ) , ( -path /.archon/workspaces/*/* -prune )',
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
  // WO-HARNESS-BOOT-CHOWN-WALK-AND-REBUILD-EVIDENCE-01, Test 1.
  it('ownership_walk_prunes_workspace_contents', () => {
    const r = runBlock({
      extra: dir => {
        mkdirSync(join(dir, 'archon', 'workspaces', 'run-a', 'repo', 'deep'), { recursive: true });
        writeFileSync(join(dir, 'archon', 'workspaces', 'run-a', 'repo', 'deep', 'wrong-deep.txt'), 'x');
        writeFileSync(join(dir, 'archon', 'workspaces', 'wrong-top'), 'x');
        writeFileSync(join(dir, 'archon', 'workspaces', 'run-a', 'wrong-mid'), 'x');
        writeFileSync(join(dir, 'archon', 'wrong-root.txt'), 'x');
      },
    });
    expect(r.status).toBe(0);
    const chowned = r.calls.filter(c => c.startsWith('chown ')).map(c => c.split(' ').pop());
    expect(chowned).toContain(`${r.tree}/archon/workspaces/wrong-top`);
    expect(chowned).toContain(`${r.tree}/archon/workspaces/run-a/wrong-mid`);
    expect(chowned).toContain(`${r.tree}/archon/wrong-root.txt`);
    expect(chowned).not.toContain(`${r.tree}/archon/workspaces/run-a/repo/deep/wrong-deep.txt`);
    const archonFind = r.calls.find(c => c.startsWith('find /.archon'));
    expect(archonFind).toContain('-path /.archon/workspaces/*/* -prune');
  });

  // Test 2: the other walks are unchanged (no prune on /home/appuser).
  it('other_walks_are_unchanged', () => {
    const r = runBlock({
      extra: dir => {
        mkdirSync(join(dir, 'home', 'a', 'b', 'c'), { recursive: true });
        writeFileSync(join(dir, 'home', 'a', 'b', 'c', 'wrong-deep-home.txt'), 'x');
      },
    });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`chown -h appuser:appuser ${r.tree}/home/a/b/c/wrong-deep-home.txt`);
    const homeFind = r.calls.find(c => c.startsWith('find /home/appuser'));
    expect(homeFind).toBe('find /home/appuser ! -user appuser -print0');
  });

  // Test 3: each walk is announced BEFORE it runs and timed after.
  it('ownership_walk_is_announced_before_it_runs', () => {
    const r = runBlock();
    expect(r.status).toBe(0);
    for (const root of ['/.archon', '/home/appuser']) {
      const start = r.stderr.indexOf(`[archon] ownership check: ${root} ...`);
      const done = r.stderr.indexOf(`[archon] ownership check: ${root} done in `);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(done).toBeGreaterThan(start);
    }
    // The announcement precedes the walk: the block prints before calling find (stderr is
    // written before the find call is logged, so check the order of lines in stderr instead of
    // interleaving two streams): the /.archon "done" line comes before the /home/appuser start.
    expect(r.stderr.indexOf('ownership check: /.archon done in ')).toBeLessThan(
      r.stderr.indexOf('ownership check: /home/appuser ...')
    );
  });
});
