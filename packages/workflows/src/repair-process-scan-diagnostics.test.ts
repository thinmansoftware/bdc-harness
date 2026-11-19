import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lane = readFileSync(
  join(import.meta.dir, '../../../.archon/workflows/defaults/bdc-feature-development-cursor.yaml'),
  'utf8'
).replaceAll('\r', '');
const readers = lane
  .slice(lane.indexOf('      rtw_proc_field()'), lane.indexOf('      rtw_json_escape()'))
  .replace(/^      /gm, '');

function scan(prelude: string, status?: string, refusal = false): string {
  const root = mkdtempSync(join(tmpdir(), 'rtw-scan-6372-'));
  try {
    mkdirSync(join(root, '4545'));
    if (status !== undefined) writeFileSync(join(root, '4545/status'), status);
    const script = join(root, 'scan.sh');
    writeFileSync(
      script,
      `set -euo pipefail\n${readers}\nproc_root="$SCAN_PROC_ROOT"\nholder="$proc_root/holder"\nrtw_self_uid=1001\nrtw_holder_started_ms=0\nrtw_boot_ms=0\nrtw_hz=100\nrtw_skip_pids=""\n${prelude}\nrtw_scan_holder\nprintf 'result=%s unreadable=%s detail=%s\\n' "$rtw_scan_result" "$rtw_scan_unreadable" "\${rtw_scan_errors:-}"\n`
    );
    if (refusal) {
      const body = readFileSync(script, 'utf8');
      writeFileSync(
        script,
        `${body}\nrtw_refuse() { printf 'REFUSED: %s\\n' "$1"; return 1; }\nif rtw_wait_for_holder_exit; then exit 9; fi\n`
      );
    }
    const result = Bun.spawnSync(['bash', script.replaceAll('\\', '/')], {
      env: { ...process.env, SCAN_PROC_ROOT: root.replaceAll('\\', '/') },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a PID exiting during the status read is already skipped', () => {
  const output = scan(`awk() {
  rmdir "$proc_root/4545"
  printf 'status: No such file or directory\\n' >&2
  return 1
}`);
  expect(output).toContain('result=clear unreadable=0');
});

test('a PID exiting during the start-time read is already skipped', () => {
  const output = scan(`awk() { printf '1001\\n'; }
cat() { rmdir "$proc_root/4545"; printf 'stat: No such process\\n' >&2; return 1; }`);
  expect(output).toContain('result=clear unreadable=0');
});

test('an unknown identity still refuses and names the PID and status read error', () => {
  const output = scan('');
  expect(output).toContain('result=incomplete unreadable=1');
  expect(output).toContain('pid=4545 uid=unknown');
  expect(output).toContain('status');
  expect(output).toContain('No such file or directory');
});

test('a known same-UID unreadable start time names UID and stat read error', () => {
  const output = scan('', 'Uid:\t1001\t1001\t1001\t1001\n');
  expect(output).toContain('result=incomplete unreadable=1');
  expect(output).toContain('pid=4545 uid=1001');
  expect(output).toContain('stat');
  expect(output).toContain('No such file or directory');
});

test('the actual refusal includes the PID, unknown UID and underlying read error', () => {
  const output = scan('', undefined, true);
  expect(output).toContain('REFUSED: process scan incomplete (1 unreadable): pid=4545 uid=unknown');
  expect(output).toContain('status');
  expect(output).toContain('No such file or directory');
});

test('readable foreign UID is still skipped without a broker-specific exemption', () => {
  expect(scan('', 'Uid:\t1002\t1002\t1002\t1002\n')).toContain('result=clear unreadable=0');
});

test('permission-denied reads remain unknown and preserve the actual error', () => {
  const output = scan(`awk() { printf 'status: Permission denied\\n' >&2; return 2; }`);
  expect(output).toContain('result=incomplete unreadable=1');
  expect(output).toContain('pid=4545 uid=unknown');
  expect(output).toContain('Permission denied');
});

test('all unreadable PIDs are named and each error is bounded to one line', () => {
  const output = scan(`mkdir "$proc_root/4546"
awk() { printf '%s\\nsecond line\\n' '${'x'.repeat(500)}' >&2; return 2; }`);
  expect(output).toContain('result=incomplete unreadable=2');
  expect(output).toContain('pid=4545 uid=unknown');
  expect(output).toContain('pid=4546 uid=unknown');
  expect(output).not.toContain('x'.repeat(241));
  expect(output.trim().split('\n')).toHaveLength(1);
});
