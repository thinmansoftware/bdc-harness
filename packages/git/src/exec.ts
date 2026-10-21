import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir as fsMkdir } from 'fs/promises';
import { basename, isAbsolute, resolve, sep } from 'path';
import { promisify } from 'util';
import { buildLaneSubprocessEnv, getArchonWorkspacesPath, laneSpawnArgv } from '@archon/paths';

const promisifiedExecFile = promisify(execFile);

/** git flags that carry a repository path and so determine the lane boundary. */
const GIT_PATH_FLAGS = ['-C', '--git-dir', '--work-tree'];

/** True when `candidate` resolves to `root` or a path underneath it. */
function isUnder(candidate: string, root: string): boolean {
  const base = candidate ? resolve(candidate) : '';
  if (!base) return false;
  const normRoot = resolve(root);
  return base === normRoot || base.startsWith(normRoot + sep);
}

/**
 * Collect every repository path a git invocation targets: the process cwd and
 * the value of any -C / --git-dir / --work-tree flag (space- or =-separated).
 * Relative flag values are resolved against cwd (git's own behavior for -C).
 */
function gitTargetPaths(args: string[], cwd: string | undefined): string[] {
  const paths: string[] = [];
  if (cwd) paths.push(cwd);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const flag of GIT_PATH_FLAGS) {
      if (arg === flag) {
        const value = args[i + 1];
        if (value) paths.push(isAbsolute(value) ? value : resolve(cwd ?? process.cwd(), value));
        i++;
        break;
      }
      if (arg.startsWith(flag + '=')) {
        const value = arg.slice(flag.length + 1);
        if (value) paths.push(isAbsolute(value) ? value : resolve(cwd ?? process.cwd(), value));
        break;
      }
    }
  }
  return paths;
}

interface ExecOptions {
  timeout?: number;
  cwd?: string;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Lane-isolation routing (WO-HARNESS-APP-KEY-ISOLATION-01).
 *
 * Any git command the server process runs whose cwd or -C/--git-dir/--work-tree
 * target resolves under the Archon workspaces root must run as the unprivileged
 * lane UID with a scrubbed environment -- because repository-local .git/config
 * (credential.helper, core.fsmonitor/hooksPath, core.sshCommand, filter drivers)
 * is lane-controlled and would otherwise execute under the server's UID. There
 * is NO hardened UID-1001 alternative.
 *
 * Returns the (possibly rewritten) command/args/options. When isolation is off,
 * the launcher is absent (local dev / CI), or the target is not a workspace path,
 * the inputs are returned unchanged. Exported so git.test.ts can assert the
 * routing decision without spawning.
 */
export function resolveLaneGitSpawn(
  cmd: string,
  args: string[],
  options: ExecOptions | undefined,
  deps: {
    env?: NodeJS.ProcessEnv;
    workspaceRoot?: string;
    exists?: (path: string) => boolean;
  } = {}
): { cmd: string; args: string[]; options: ExecOptions | undefined } {
  if (basename(cmd) !== 'git') return { cmd, args, options };

  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  let workspaceRoot: string;
  try {
    workspaceRoot = deps.workspaceRoot ?? getArchonWorkspacesPath();
  } catch {
    return { cmd, args, options };
  }

  const targets = gitTargetPaths(args, options?.cwd);
  if (!targets.some(target => isUnder(target, workspaceRoot))) {
    return { cmd, args, options };
  }

  const wrapped = laneSpawnArgv([cmd, ...args], { env, exists });
  if (wrapped[0] === cmd) {
    // Isolation disabled or launcher absent -- run unchanged (local dev / CI).
    return { cmd, args, options };
  }

  return {
    cmd: wrapped[0],
    args: wrapped.slice(1),
    options: { ...options, env: buildLaneSubprocessEnv(options?.env ?? env) },
  };
}

/** Wrapper around child_process.execFile for test mockability. Git commands that
 * target a path under the Archon workspaces root are routed through the lane
 * launcher (distinct unprivileged UID + scrubbed env). */
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const routed = resolveLaneGitSpawn(cmd, args, options);
  const result = await promisifiedExecFile(routed.cmd, routed.args, routed.options);
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}
