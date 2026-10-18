import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

test('stdin startup entry reaches its closed context guard from a foreign cwd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'teetime-startup-entry-'));
  try {
    const env: Record<string, string> = { TEE_TIME_SANDBOX_PROBE: '0' };
    if (process.platform === 'win32' && process.env.SystemRoot)
      env.SystemRoot = process.env.SystemRoot;
    const result = Bun.spawnSync([process.execPath, 'run', '-'], {
      cwd: directory,
      env,
      stdin: readFileSync(new URL('./probe-codex-startup.ts', import.meta.url)),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 16384,
    });
    expect(result.exitCode).toBe(1);
    expect(result.signalCode ?? null).toBeNull();
    expect(new TextDecoder().decode(result.stdout)).toBe(
      '{"kind":"teetime-startup-capture-failed-v1"}'
    );
    expect(new TextDecoder().decode(result.stderr)).toBe('');
  } finally {
    const target = realpathSync(directory);
    if (
      dirname(target) !== realpathSync(tmpdir()) ||
      !basename(target).startsWith('teetime-startup-entry-')
    )
      throw new Error('owned startup test cleanup path rejected');
    rmSync(target, { recursive: true });
  }
});
