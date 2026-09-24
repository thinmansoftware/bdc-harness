import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const SHIM = join(import.meta.dir, 'shims', 'gh');

function runShim(
  args: string[],
  pathEnv: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SHIM, args, {
      env: { ...process.env, PATH: pathEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('gh shim denies pull request mutations', () => {
  test('declares the POSIX interpreter required for direct execution', async () => {
    const source = await readFile(SHIM, 'utf8');
    expect(source.startsWith('#!/bin/sh\n')).toBe(true);
  });

  test.skipIf(process.platform === 'win32')(
    'blocks pr create, merge, ready, and mutating api pulls calls',
    async () => {
      const fakeDir = await mkdtemp(join(tmpdir(), 'gh-shim-'));
      const fakeGh = join(fakeDir, 'gh');
      await writeFile(fakeGh, '#!/bin/sh\necho "FAKE $*"\nexit 0\n');
      await chmod(fakeGh, 0o755);
      await chmod(SHIM, 0o755);
      const pathEnv = `${dirname(SHIM)}${delimiter}${fakeDir}`;

      const blocked = [
        ['pr', 'create', '--title', 'x'],
        ['pr', 'merge', '1'],
        ['pr', 'ready', '1'],
        ['api', '-X', 'POST', 'repos/o/r/pulls'],
      ];
      for (const args of blocked) {
        const result = await runShim(args, pathEnv);
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('denied');
        expect(result.stdout).not.toContain('FAKE');
      }

      const view = await runShim(['pr', 'view', '1'], pathEnv);
      expect(view.code).toBe(0);
      expect(view.stdout.trim()).toBe('FAKE pr view 1');

      const auth = await runShim(['auth', 'status'], pathEnv);
      expect(auth.code).toBe(0);
      expect(auth.stdout.trim()).toBe('FAKE auth status');
    }
  );
});
