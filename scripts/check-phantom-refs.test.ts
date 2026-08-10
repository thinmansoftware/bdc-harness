import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'check-phantom-refs.sh');
const temporaryDirectories: string[] = [];

async function commandDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'check-phantom-refs-'));
  temporaryDirectories.push(directory);
  await symlink('/usr/bin/awk', join(directory, 'awk'));
  await symlink('/usr/bin/sed', join(directory, 'sed'));
  return directory;
}

async function mockCommand(directory: string, name: string, body: string): Promise<void> {
  const path = join(directory, name);
  await writeFile(path, `#!/bin/bash\n${body}\n`);
  await chmod(path, 0o755);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true }))
  );
});

describe('check-phantom-refs', () => {
  test('parses tab-delimited git ls-remote output when gh is unavailable', async () => {
    const directory = await commandDirectory();
    await mockCommand(
      directory,
      'git',
      String.raw`[[ $1 == ls-remote && $2 == --heads ]] || exit 90
printf 'aaaaaaaa\trefs/heads/normal-branch\n'
printf 'bbbbbbbb\trefs/heads/feature/phantom'"'"'branch\n'`
    );

    const result = Bun.spawnSync(['/bin/bash', script, 'owner/repository'], {
      env: { PATH: directory },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("feature/phantom'branch\n");
    expect(result.stderr.toString()).toBe('');
  });

  test('reports enumeration failures distinctly from phantom refs', async () => {
    const directory = await commandDirectory();
    await mockCommand(directory, 'gh', 'exit 42');

    const result = Bun.spawnSync(['/bin/bash', script, 'unknown/repository'], {
      env: { PATH: directory },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe(
      'error: failed to enumerate refs for unknown/repository\n'
    );
  });
});
