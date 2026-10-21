import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

const launcher = '/usr/local/bin/archon-lane-exec';
const containerTest = existsSync(launcher) ? test : test.skip;

describe('container lane isolation', () => {
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

  containerTest('lane_cannot_write_server_config_or_database', () => {
    const result = Bun.spawnSync([
      launcher,
      'sh',
      '-c',
      'test ! -w /home/appuser/.gitconfig && test ! -r /.archon/archon.db && test ! -w /.archon',
    ]);
    expect(result.exitCode).toBe(0);
  });
});
