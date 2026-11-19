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

function scan(
  prelude: string,
  status?: string,
  refusal = false,
  options: {
    expectClear?: boolean;
    waitLimit?: number;
    cmdline?: string[] | Uint8Array;
    extraEnv?: Record<string, string>;
  } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), 'rtw-scan-6372-'));
  try {
    mkdirSync(join(root, '4545'));
    if (status !== undefined) writeFileSync(join(root, '4545/status'), status);
    if (options.cmdline !== undefined) {
      writeFileSync(
        join(root, '4545/cmdline'),
        Array.isArray(options.cmdline) ? options.cmdline.join('\0') + '\0' : options.cmdline
      );
    }
    const script = join(root, 'scan.sh');
    writeFileSync(
      script,
      `set -euo pipefail\n${readers}\nproc_root="$SCAN_PROC_ROOT"\nholder="$proc_root/holder"\nrtw_self_uid=1001\nrtw_holder_started_ms=0\nrtw_boot_ms=0\nrtw_hz=100\nrtw_skip_pids=""\n${prelude}\nrtw_scan_holder\nprintf 'result=%s unreadable=%s detail=%s\\n' "$rtw_scan_result" "$rtw_scan_unreadable" "\${rtw_scan_errors:-}"\n`
    );
    if (refusal) {
      const body = readFileSync(script, 'utf8');
      writeFileSync(
        script,
        `${body}\nrtw_refuse() { printf 'REFUSED: %s\\n' "$1"; return 1; }\nif rtw_wait_for_holder_exit; then\n printf 'WAIT_CLEAR\\n'\n ${options.expectClear ? ':' : 'exit 9'}\nelse\n ${options.expectClear ? 'exit 9' : ':'}\nfi\nprintf 'sleep_calls=%s\\n' "\${sleep_calls:-0}"\n`
      );
    }
    const result = Bun.spawnSync(['bash', script.replaceAll('\\', '/')], {
      env: {
        ...process.env,
        SCAN_PROC_ROOT: root.replaceAll('\\', '/'),
        RTW_HOLDER_WAIT_SECONDS: String(options.waitLimit ?? 0),
        ...options.extraEnv,
      },
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

test('an unreadable PID disappearing on rescan permits only the later clear scan', () => {
  const output = scan(
    `sleep_calls=0
sleep() { [ "$1" = 5 ] || return 9; sleep_calls=$((sleep_calls + 1)); rmdir "$proc_root/4545"; }`,
    undefined,
    true,
    { expectClear: true, waitLimit: 10 }
  );
  expect(output).toContain('WAIT_CLEAR');
  expect(output).toContain('sleep_calls=1');
  expect(output).not.toContain('REFUSED:');
});

test('the same unreadable PID refuses after three scans and two bounded sleeps', () => {
  const output = scan(
    `sleep_calls=0
sleep() { [ "$1" = 5 ] || return 9; sleep_calls=$((sleep_calls + 1)); }`,
    undefined,
    true,
    { waitLimit: 120 }
  );
  expect(output).toContain('REFUSED: process scan incomplete (1 unreadable): pid=4545');
  expect(output).toContain('sleep_calls=2');
  expect(output).not.toContain('WAIT_CLEAR');
});

test('rotating unknown PIDs cannot reset the finite retry budget', () => {
  const output = scan(
    `sleep_calls=0
sleep() {
 [ "$1" = 5 ] || return 9
 rmdir "$proc_root/$((4545 + sleep_calls))"
 sleep_calls=$((sleep_calls + 1))
 mkdir "$proc_root/$((4545 + sleep_calls))"
}`,
    undefined,
    true,
    { waitLimit: 120 }
  );
  expect(output).toContain('REFUSED: process scan incomplete (1 unreadable): pid=4547');
  expect(output).toContain('sleep_calls=2');
  expect(output).not.toContain('WAIT_CLEAR');
});

test('a zero wait cap preserves immediate unknown-identity refusal', () => {
  const output = scan(`sleep() { exit 9; }`, undefined, true);
  expect(output).toContain('REFUSED: process scan incomplete');
  expect(output).toContain('sleep_calls=0');
});

test('a shorter existing wait cap ends retries before the three-scan budget', () => {
  const output = scan(
    `sleep_calls=0
sleep() { [ "$1" = 5 ] || return 9; sleep_calls=$((sleep_calls + 1)); }`,
    undefined,
    true,
    { waitLimit: 5 }
  );
  expect(output).toContain('REFUSED: process scan incomplete');
  expect(output).toContain('sleep_calls=1');
});

test('a rescan revealing a visible foreign holder still refuses', () => {
  const output = scan(
    `sleep_calls=0
readlink() { printf '%s\\n' "$holder"; }
sleep() {
 sleep_calls=$((sleep_calls + 1))
 mkdir "$proc_root/4545/cwd"
 printf 'Uid:\\t1002\\t1002\\t1002\\t1002\\n' > "$proc_root/4545/status"
}`,
    undefined,
    true,
    { waitLimit: 10 }
  );
  expect(output).toContain('REFUSED: live process cwd under holder');
  expect(output).toContain('sleep_calls=1');
  expect(output).not.toContain('WAIT_CLEAR');
});

const cursorNode = '/opt/cursor-agent/.local/share/cursor-agent/versions/2026.11.17-f532c45/node';
const cursorScript =
  '/opt/cursor-agent/.local/share/cursor-agent/versions/2026.11.17-f532c45/index.js';
const workspace =
  '/.archon/workspaces/thinmansoftware/shopops/worktrees/archon/task-web-worker-12345-abc';

test('cmdline preserves recognized Cursor executable, script and explicit workspace', () => {
  const output = scan('', undefined, true, {
    cmdline: [cursorNode, cursorScript, '--workspace', workspace, '--print'],
  });
  expect(output).toContain(
    `cmdline=${cursorNode} ${cursorScript} --workspace ${workspace} --print`
  );
});

test('cmdline redacts credential flags, unknown values, URLs and prompts before truncation', () => {
  const secret = 'synthetic-credential-123456';
  const output = scan('', undefined, true, {
    cmdline: [
      'node',
      cursorScript,
      '--api-key',
      secret,
      '--token=' + secret,
      '--header',
      'Authorization: Bearer ' + secret,
      'https://user:' + secret + '@example.invalid',
      'private prompt ' + secret,
      '--workspace',
      workspace,
    ],
  });
  expect(output).not.toContain(secret);
  expect(output).not.toContain('private prompt');
  expect(output).not.toContain('https://');
  expect(output).toContain('--workspace ' + workspace);
  expect(output).toContain('[REDACTED]');
});

test('even path-like secrets are redacted when supplied to a credential flag', () => {
  const output = scan('', undefined, true, { cmdline: ['node', '--token', workspace] });
  expect(output).toContain('cmdline=');
  expect(output).not.toContain(workspace);
});

test('cmdline rejects unsafe workspace values and masks known environment secrets in paths', () => {
  const secret = 'synthetic-env-secret';
  const output = scan('', undefined, true, {
    cmdline: [
      cursorNode,
      cursorScript,
      '--workspace',
      workspace + '?token=' + secret,
      '--workspace',
      workspace.replace('shopops', secret),
    ],
    extraEnv: { SCAN_TEST_SECRET_TOKEN: secret },
  });
  expect(output).toContain('cmdline=');
  expect(output).not.toContain(secret);
  expect(output).not.toContain('?token=');
});

test('cmdline input and redacted output are bounded without exposing partial arguments', () => {
  const output = scan('', undefined, false, {
    cmdline: [cursorNode, cursorScript, '--workspace', workspace, 'sensitive-' + 'q'.repeat(20000)],
  });
  expect(output).toContain('cmdline=');
  const context = output.split('cmdline=')[1]?.trim() ?? '';
  expect(context.length).toBeLessThanOrEqual(512);
  expect(context).not.toContain('sensitive-');
  expect(context).not.toContain('qqqq');
});

test('unavailable cmdline remains a refusal and never changes classification', () => {
  const output = scan('', undefined, true);
  expect(output).toContain('REFUSED: process scan incomplete');
  expect(output).toContain('cmdline=[unavailable]');
});

test('credential-shaped values inside a workspace path are also redacted', () => {
  const secret = ['gh', 'p_', 'SYNTHETIC_ONLY'].join('');
  const output = scan('', undefined, true, {
    cmdline: ['node', '--workspace', workspace.replace('shopops', secret)],
  });
  expect(output).toContain('cmdline=');
  expect(output).not.toContain(secret);
});
