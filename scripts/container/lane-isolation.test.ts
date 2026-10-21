import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Lane UID isolation tests (WO-HARNESS-APP-KEY-ISOLATION-01).
 *
 * Two tiers:
 *  - Launcher shell logic (CI-runnable): drives scripts/container/archon-lane-exec.sh
 *    with a fake setpriv so the argv/env handling is verified without root or
 *    file capabilities.
 *  - Image tests (Tests 4, 7, 8): require the built production image (laneuser
 *    UID 1002, the setcap'd launcher, the entrypoint permission step). They can
 *    only run inside archon-app-1, so they are gated on
 *    ARCHON_LANE_ISOLATION_IMAGE_TEST=1 and skip (not fail) in CI.
 */

const LAUNCHER = join(import.meta.dir, 'archon-lane-exec.sh');
const IN_IMAGE = process.env.ARCHON_LANE_ISOLATION_IMAGE_TEST === '1';

describe('archon-lane-exec launcher logic (CI-runnable)', () => {
  let dir: string;
  let fakeSetpriv: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-exec-'));
    // A fake setpriv that just prints its own argv, one per line, so the test can
    // assert exactly what the launcher passed and in what order.
    fakeSetpriv = join(dir, 'fake-setpriv');
    writeFileSync(fakeSetpriv, '#!/bin/bash\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });
    chmodSync(fakeSetpriv, 0o755);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runLauncher(
    args: string[],
    extraEnv: Record<string, string> = {}
  ): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync({
      cmd: ['bash', LAUNCHER, ...args],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ARCHON_LANE_SETPRIV: fakeSetpriv,
        // Pick a lane UID that is not the current UID so the re-entry guard
        // allows the launcher to proceed.
        ARCHON_LANE_UID: '4242',
        ARCHON_LANE_GID: '4242',
        ...extraEnv,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }

  test('drops to the lane UID/GID and passes the command through after --', () => {
    const { exitCode, stdout } = runLauncher(['echo', 'hello']);
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toContain('--reuid=4242');
    expect(lines).toContain('--regid=4242');
    expect(lines).toContain('--clear-groups');
    expect(lines).toContain('--inh-caps=-all');
    expect(lines).toContain('--ambient-caps=-all');
    expect(lines).toContain('--no-new-privs');
    // The command follows the -- separator, unchanged and in order.
    const sep = lines.indexOf('--');
    expect(sep).toBeGreaterThan(-1);
    expect(lines.slice(sep + 1)).toEqual(['echo', 'hello']);
  });

  test('ARCHON_LANE_WRAPPED_CMD is prepended (Codex single-path SDK path)', () => {
    const { exitCode, stdout } = runLauncher(['exec', '--json'], {
      ARCHON_LANE_WRAPPED_CMD: '/opt/real/codex',
    });
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split('\n');
    const sep = lines.indexOf('--');
    expect(lines.slice(sep + 1)).toEqual(['/opt/real/codex', 'exec', '--json']);
  });

  test('refuses with no command and no wrapped command', () => {
    const { exitCode, stderr } = runLauncher([]);
    expect(exitCode).toBe(91);
    expect(stderr).toContain('no command given');
  });

  test('refuses to re-enter when already at the lane UID', () => {
    const currentUid = String(process.getuid?.() ?? 0);
    const { exitCode, stderr } = runLauncher(['echo', 'x'], { ARCHON_LANE_UID: currentUid });
    expect(exitCode).toBe(90);
    expect(stderr).toContain('refusing to re-enter');
  });

  test('fails clearly when the setpriv launcher is missing', () => {
    const { exitCode, stderr } = runLauncher(['echo', 'x'], {
      ARCHON_LANE_SETPRIV: join(dir, 'does-not-exist'),
    });
    expect(exitCode).toBe(92);
    expect(stderr).toContain('missing or not executable');
  });
});

// ---------------------------------------------------------------------------
// Image tests: require the built production image. Gated on
// ARCHON_LANE_ISOLATION_IMAGE_TEST=1 (operator runs these inside archon-app-1);
// they skip in CI because a setuid launcher + UID 1002 cannot exist in the
// unprivileged test runner. The deterministic per-spawn-site proof lives in the
// lane-env / git / github-service-exec unit tests.
// ---------------------------------------------------------------------------
function laneExec(args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync({
    cmd: ['/usr/local/bin/archon-lane-exec', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout) };
}

describe('lane isolation in the built image', () => {
  test.skipIf(!IN_IMAGE)('Test 4: launcher drops to lane UID 1002 with no capabilities', () => {
    const uid = laneExec(['id', '-u']);
    expect(uid.stdout.trim()).toBe('1002');
    const status = laneExec(['cat', '/proc/self/status']);
    const capEff = /^CapEff:\s*([0-9a-f]+)/m.exec(status.stdout)?.[1];
    expect(capEff).toBe('0000000000000000');
    const groups = /^Groups:\s*(.*)$/m.exec(status.stdout)?.[1] ?? '';
    // archon-secrets (1100) and archon-launch (1101) must NOT be present.
    expect(groups.split(/\s+/)).not.toContain('1100');
    expect(groups.split(/\s+/)).not.toContain('1101');
  });

  test.skipIf(!IN_IMAGE)('Test 7: lane cannot write server config or the database', () => {
    // As the lane UID (via the launcher), these writes/read must be denied.
    expect(laneExec(['sh', '-c', 'echo x >> /home/appuser/.gitconfig']).exitCode).not.toBe(0);
    expect(laneExec(['sh', '-c', 'echo x > /home/appuser/.config/git/config']).exitCode).not.toBe(
      0
    );
    expect(laneExec(['sh', '-c', 'echo x > /.archon/archon.db']).exitCode).not.toBe(0);
    expect(laneExec(['sh', '-c', 'cat /.archon/archon.db']).exitCode).not.toBe(0);
    expect(laneExec(['sh', '-c', 'echo x > /.archon/lane-probe']).exitCode).not.toBe(0);
    // But the lane CAN write inside the workspace allowlist.
    const probe = '/.archon/workspaces/.lane-write-probe';
    expect(laneExec(['sh', '-c', `touch ${probe} && rm -f ${probe}`]).exitCode).toBe(0);
  });

  test.skipIf(!IN_IMAGE)(
    'Test 8: reviewer key unreadable, Builder 2 key readable by the lane',
    () => {
      expect(laneExec(['cat', '/run/secrets/thinman-overseer.pem']).exitCode).not.toBe(0);
      expect(laneExec(['head', '-c0', '/proc/1/environ']).exitCode).not.toBe(0);
      expect(laneExec(['test', '-r', '/run/secrets/thinman-builder-2.pem']).exitCode).toBe(0);
    }
  );
});
