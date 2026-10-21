import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGrokTool } from '../../packages/providers/src/community/grok/tools';

const launcher = '/usr/local/bin/archon-lane-exec';
const containerTest = existsSync(launcher) ? test : test.skip;
const launcherSource = readFileSync(new URL('./archon-lane-exec.sh', import.meta.url), 'utf8');

describe('container lane isolation', () => {
  test('lane_executes_server_owned_0600_bash_script', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lane-bash-0600-local-'));
    const script = join(directory, 'node.sh');
    const harness = join(directory, 'harness.sh');
    try {
      writeFileSync(script, 'echo lane-bash-ok\n', { mode: 0o600 });
      writeFileSync(
        harness,
        [
          '#!/bin/sh',
          'set -eu',
          'exec 9<"$1"',
          'chmod 000 "$1"',
          'if bash /proc/self/fd/9 >reopen-out 2>reopen-err; then',
          '  echo reopen-succeeded >&2',
          '  exit 2',
          'fi',
          'exec 0<&9 9<&-',
          'exec bash -s --',
          '',
        ].join('\n'),
        { mode: 0o700 }
      );
      const result = Bun.spawnSync(['bash', harness, script], { cwd: directory });
      const output = new TextDecoder().decode(result.stdout);
      const error = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(error).not.toContain('reopen-succeeded');
      expect(output).toContain('lane-bash-ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('lane launcher feeds 0600 bash scripts on stdin and scrubs database env', () => {
    expect(launcherSource).not.toContain('/proc/self/fd/');
    expect(launcherSource).not.toContain('[ -f ');
    expect(launcherSource).toContain('O_NOFOLLOW');
    expect(launcherSource).toContain('bash -s');
    expect(launcherSource).toContain('DATABASE_URL');
    expect(launcherSource).toContain('exec 0<&9');
  });

  test('bash script opener refuses symlinks and reads a regular 0600 file', () => {
    const start = launcherSource.indexOf("<<'PY'\n");
    const end = launcherSource.indexOf('\nPY\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const program = launcherSource.slice(start + "<<'PY'\n".length, end);
    const directory = mkdtempSync(join(tmpdir(), 'lane-bash-nofollow-'));
    const script = join(directory, 'node.sh');
    const secret = join(directory, 'secret');
    const link = join(directory, 'link.sh');
    const hidden = join(directory, 'hidden');
    const dirLink = join(directory, 'dirlink');
    try {
      writeFileSync(script, 'echo lane-bash-ok\n', { mode: 0o600 });
      chmodSync(script, 0o600);
      writeFileSync(secret, 'SECRET-BYTES\n', { mode: 0o600 });
      symlinkSync(secret, link);
      mkdirSync(hidden);
      writeFileSync(join(hidden, 'node.sh'), 'echo hidden\n');
      symlinkSync(hidden, dirLink);

      const opened = Bun.spawnSync(['python3', '-', script], {
        stdin: new TextEncoder().encode(program),
      });
      expect(opened.exitCode).toBe(0);
      expect(new TextDecoder().decode(opened.stdout)).toBe('echo lane-bash-ok\n');

      const followed = Bun.spawnSync(['python3', '-', link], {
        stdin: new TextEncoder().encode(program),
      });
      expect(followed.exitCode).toBe(66);
      expect(new TextDecoder().decode(followed.stdout)).toBe('');
      expect(readFileSync(secret, 'utf8')).toBe('SECRET-BYTES\n');

      const viaDirectory = Bun.spawnSync(['python3', '-', join(dirLink, 'node.sh')], {
        stdin: new TextEncoder().encode(program),
      });
      expect(viaDirectory.exitCode).toBe(66);
      expect(new TextDecoder().decode(viaDirectory.stdout)).not.toContain('hidden');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  containerTest('launcher_drops_to_lane_uid_with_no_caps', () => {
    const result = Bun.spawnSync([
      launcher,
      'sh',
      '-c',
      'id -u; grep ^CapEff: /proc/self/status; grep ^Groups: /proc/self/status',
    ]);
    const output = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output).toContain('1002');
    expect(output).toContain('CapEff:\t0000000000000000');
    expect(output).not.toMatch(/Groups:.*\b1100\b/);
    expect(output).not.toMatch(/Groups:.*\b1101\b/);
  });

  containerTest('launcher_denied_for_lane_uid', () => {
    const nested = Bun.spawnSync([
      launcher,
      'sh',
      '-c',
      '/usr/local/libexec/archon/lane-setpriv --version',
    ]);
    const nestedText = `${new TextDecoder().decode(nested.stdout)}\n${new TextDecoder().decode(nested.stderr)}`;
    expect(nested.exitCode).not.toBe(0);
    expect(nestedText.toLowerCase()).toContain('permission denied');

    const wrapper = Bun.spawnSync([launcher, 'sh', '-c', `${launcher} id -u`]);
    const wrapperText = `${new TextDecoder().decode(wrapper.stdout)}\n${new TextDecoder().decode(wrapper.stderr)}`;
    expect(wrapper.exitCode).not.toBe(0);
    expect(wrapperText.toLowerCase()).toMatch(/permission denied|refusing nested lane launch/);
  });

  containerTest('lane_cannot_write_server_config_or_database', () => {
    const result = Bun.spawnSync([
      launcher,
      'sh',
      '-c',
      'test ! -w /home/appuser/.gitconfig && test ! -r /.archon/archon.db && test ! -w /.archon',
    ]);
    expect(result.exitCode).toBe(0);
  });

  containerTest('lane_executes_server_owned_0600_bash_script', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lane-bash-0600-'));
    const script = join(directory, 'node.sh');
    try {
      writeFileSync(script, 'echo lane-bash-ok\nid -u\n', { mode: 0o600 });
      chmodSync(script, 0o600);
      const result = Bun.spawnSync([launcher, 'bash', script]);
      const output = new TextDecoder().decode(result.stdout);
      const error = new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(error).not.toContain('Permission denied');
      expect(output).toContain('lane-bash-ok');
      expect(output).toContain('1002');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  containerTest('lane_env_has_no_database_credential', () => {
    const result = Bun.spawnSync({
      cmd: [launcher, '/bin/sh', '-c', 'printenv DATABASE_URL; echo rc=$?'],
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://probe:probe@127.0.0.1:1/probe',
        SHADOW_DATABASE_URL: 'postgresql://probe:probe@127.0.0.1:1/shadow',
        PGPASSWORD: 'probe',
      },
    });
    const output = new TextDecoder().decode(result.stdout).trim();
    expect(output).toBe('rc=1');
    expect(output).not.toContain('postgresql://');
  });

  containerTest('grok_file_tools_run_as_lane_uid', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'grok-lane-boundary-'));
    const secret = join(directory, 'secret');
    const worktree = join(directory, 'worktree');
    try {
      writeFileSync(secret, 'reviewer-key-bytes', { mode: 0o600 });
      chmodSync(secret, 0o600);
      mkdirSync(worktree, { mode: 0o777 });
      chmodSync(worktree, 0o777);
      symlinkSync(secret, join(worktree, 'leak'));
      symlinkSync(secret, join(worktree, 'db'));
      writeFileSync(join(worktree, 'ordinary.txt'), 'before', { mode: 0o666 });

      const readLeak = await executeGrokTool(
        worktree,
        'read_file',
        JSON.stringify({ path: 'leak' })
      );
      const readDb = await executeGrokTool(worktree, 'read_file', JSON.stringify({ path: 'db' }));
      const writeDb = await executeGrokTool(
        worktree,
        'write_file',
        JSON.stringify({ path: 'db', content: 'overwrite' })
      );
      const editLeak = await executeGrokTool(
        worktree,
        'edit_file',
        JSON.stringify({ path: 'leak', old_string: 'reviewer', new_string: 'lane' })
      );
      expect(readLeak.toLowerCase()).toContain('permission denied');
      expect(readDb.toLowerCase()).toContain('permission denied');
      expect(writeDb.toLowerCase()).toContain('permission denied');
      expect(editLeak.toLowerCase()).toContain('permission denied');
      expect(readFileSync(secret, 'utf8')).toBe('reviewer-key-bytes');

      const written = await executeGrokTool(
        worktree,
        'write_file',
        JSON.stringify({ path: 'ordinary.txt', content: 'hello' })
      );
      const read = await executeGrokTool(
        worktree,
        'read_file',
        JSON.stringify({ path: 'ordinary.txt' })
      );
      const edited = await executeGrokTool(
        worktree,
        'edit_file',
        JSON.stringify({ path: 'ordinary.txt', old_string: 'hello', new_string: 'HELLO' })
      );
      const reread = await executeGrokTool(
        worktree,
        'read_file',
        JSON.stringify({ path: 'ordinary.txt' })
      );
      expect(written).toContain('OK wrote');
      expect(read).toBe('hello');
      expect(edited).toContain('OK edited');
      expect(reread).toBe('HELLO');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
