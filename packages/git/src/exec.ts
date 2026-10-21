import { execFile } from 'child_process';
import { mkdir as fsMkdir } from 'fs/promises';
import { promisify } from 'util';
import { resolve } from 'path';
import { buildLaneSubprocessEnv, laneSpawnArgv } from '../../core/src/github/lane-env';

const promisifiedExecFile = promisify(execFile);

export function shouldIsolateWorkspaceGit(cmd: string, args: string[], cwd?: string): boolean {
  if (cmd !== 'git') return false;
  const workspaceRoot = '/.archon/workspaces';
  const candidates: string[] = cwd ? [resolve(cwd)] : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === '-C' || arg === '--git-dir' || arg === '--work-tree') && args[index + 1]) {
      candidates.push(resolve(cwd ?? process.cwd(), args[index + 1]));
    } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      candidates.push(resolve(cwd ?? process.cwd(), arg.slice(arg.indexOf('=') + 1)));
    }
  }
  return candidates.some(path => path === workspaceRoot || path.startsWith(`${workspaceRoot}/`));
}

/** Wrapper around child_process.execFile for test mockability */
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: { timeout?: number; cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const isolated = shouldIsolateWorkspaceGit(cmd, args, options?.cwd);
  const argv = isolated ? laneSpawnArgv([cmd, ...args]) : [cmd, ...args];
  const result = await promisifiedExecFile(
    argv[0],
    argv.slice(1),
    isolated ? { ...options, env: buildLaneSubprocessEnv(options?.env ?? process.env) } : options
  );
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}
