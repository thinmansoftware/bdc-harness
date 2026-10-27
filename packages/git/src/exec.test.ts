import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execOwnedProcessGroup } from './exec';

const roots: string[] = [];
const groups: number[] = [];

function pidIsLive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state =
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0] ?? '';
    return state !== '' && state !== 'Z';
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // The group already exited.
    }
  }
  groups.length = 0;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe('execOwnedProcessGroup', () => {
  test('returns output that stays within maxBuffer', async () => {
    const result = await execOwnedProcessGroup('bash', ['-c', 'echo hello'], {
      maxBuffer: 100,
      onSpawn: pgid => {
        groups.push(pgid);
      },
    });
    expect(result.stdout).toBe('hello\n');
    expect(result.pgid).toBeGreaterThan(1);
  });

  test('onSpawn sees the process group before the child exits', async () => {
    let seen = 0;
    let aliveAtSpawn = false;
    const result = await execOwnedProcessGroup('bash', ['-c', 'sleep 0.3; echo hi'], {
      onSpawn: pgid => {
        seen = pgid;
        aliveAtSpawn = pidIsLive(pgid);
        groups.push(pgid);
      },
    });
    expect(seen).toBe(result.pgid);
    expect(aliveAtSpawn).toBe(true);
    expect(result.stdout).toContain('hi');
  });

  test('maxBuffer ends the process group while stdout is still streaming', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owned-max-'));
    const outside = mkdtempSync(join(tmpdir(), 'owned-out-'));
    roots.push(dir, outside);
    const pidFile = join(dir, 'child.pid');
    const script = [
      'bash -c \'cd "$1" && pwd > "$1/cwd.txt" && echo $$ > "$2" && exec sleep 300\' _ "$OUTSIDE" "$PIDFILE" &',
      'i=0',
      'while [ "$i" -lt 50 ]; do',
      '  if [ -s "$PIDFILE" ]; then break; fi',
      '  i=$((i + 1))',
      '  sleep 0.05',
      'done',
      'while true; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
    ].join('\n');
    const started = Date.now();
    let caught: { code?: unknown; stdout?: string; stderr?: string; pgid?: number } | undefined;
    try {
      await execOwnedProcessGroup('bash', ['-c', script], {
        cwd: dir,
        env: { ...process.env, OUTSIDE: outside, PIDFILE: pidFile },
        maxBuffer: 4096,
        timeout: 15000,
        onSpawn: pgid => {
          groups.push(pgid);
        },
      });
    } catch (err) {
      caught = err as { code?: unknown; stdout?: string; stderr?: string; pgid?: number };
    }
    expect(Date.now() - started).toBeLessThan(10000);
    expect(caught?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(Buffer.byteLength(caught?.stdout ?? '')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(caught?.stderr ?? '')).toBeLessThanOrEqual(4096);
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(childPid).toBeGreaterThan(1);
    expect(readFileSync(join(outside, 'cwd.txt'), 'utf8').trim()).toBe(outside);
    expect(pidIsLive(childPid)).toBe(false);
    if (typeof caught?.pgid === 'number') {
      expect(pidIsLive(caught.pgid)).toBe(false);
    }
  });
});
