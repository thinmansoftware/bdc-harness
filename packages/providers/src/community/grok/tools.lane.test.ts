import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANE_LAUNCHER,
  buildLaneSubprocessEnv,
  setLaneLauncherPathForTests,
} from '../../../../core/src/github/lane-env';
import { executeGrokTool, type GrokFileSpawn } from './tools';

const launcherDir = mkdtempSync(join(tmpdir(), 'grok-lane-launcher-'));
const launcherFile = join(launcherDir, 'archon-lane-exec');
writeFileSync(launcherFile, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

describe('grok file tools', () => {
  let cwd: string;
  let savedIsolation: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'grok-lane-tool-'));
    savedIsolation = process.env.ARCHON_LANE_UID_ISOLATION;
    delete process.env.ARCHON_LANE_UID_ISOLATION;
    setLaneLauncherPathForTests(launcherFile);
  });

  afterEach(() => {
    setLaneLauncherPathForTests(undefined);
    if (savedIsolation === undefined) delete process.env.ARCHON_LANE_UID_ISOLATION;
    else process.env.ARCHON_LANE_UID_ISOLATION = savedIsolation;
    rmSync(cwd, { recursive: true, force: true });
  });

  test('grok_file_tools_run_as_lane_uid', async () => {
    writeFileSync(join(cwd, 'leak'), 'server-secret', 'utf8');
    writeFileSync(join(cwd, 'db'), 'database-bytes', 'utf8');
    writeFileSync(join(cwd, 'ordinary.txt'), 'plain', 'utf8');
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; input: string }> =
      [];
    const spawnFile: GrokFileSpawn = async (file, args, options) => {
      calls.push({ file, args, env: options.env, input: options.input });
      const body = JSON.parse(options.input) as { op: string };
      if (body.op === 'read') return { stdout: 'from-lane', stderr: '', code: 0 };
      return { stdout: 'OK', stderr: '', code: 0 };
    };

    const readLeak = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: 'leak' }), {
      spawnFile,
    });
    const readDb = await executeGrokTool(cwd, 'read_file', JSON.stringify({ path: 'db' }), {
      spawnFile,
    });
    const writeDb = await executeGrokTool(
      cwd,
      'write_file',
      JSON.stringify({ path: 'db', content: 'overwrite' }),
      { spawnFile }
    );
    const editLeak = await executeGrokTool(
      cwd,
      'edit_file',
      JSON.stringify({ path: 'leak', old_string: 'server', new_string: 'lane' }),
      { spawnFile }
    );
    const readOrdinary = await executeGrokTool(
      cwd,
      'read_file',
      JSON.stringify({ path: 'ordinary.txt' }),
      { spawnFile }
    );

    expect(readLeak).toBe('from-lane');
    expect(readDb).toBe('from-lane');
    expect(writeDb).toContain('OK wrote');
    expect(editLeak).toContain('OK edited');
    expect(readOrdinary).toBe('from-lane');
    expect(calls).toHaveLength(5);
    const expectedEnv = buildLaneSubprocessEnv(process.env);
    for (const call of calls) {
      expect(call.file).toBe(LANE_LAUNCHER);
      expect(call.env).toEqual(expectedEnv);
      const body = JSON.parse(call.input) as { path: string };
      expect(body.path.startsWith(cwd)).toBe(true);
    }
    expect(readFileSync(join(cwd, 'leak'), 'utf8')).toBe('server-secret');
    expect(readFileSync(join(cwd, 'db'), 'utf8')).toBe('database-bytes');
    expect(existsSync(join(cwd, 'ordinary.txt'))).toBe(true);
    expect(readFileSync(join(cwd, 'ordinary.txt'), 'utf8')).toBe('plain');
  });
});
