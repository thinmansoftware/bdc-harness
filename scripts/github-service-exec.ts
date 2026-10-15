import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from '../packages/core/src/github/service-identity';

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export async function runGitHubServiceCommand(input: {
  service: GitHubService;
  command: string;
  args: string[];
  /** Replay piped request bodies unchanged for the one permission-only retry. */
  stdin?: Uint8Array;
  env?: Record<string, string | undefined>;
  identity?: ServiceGitHubAuth;
  token?: (identity: ServiceGitHubAuth) => Promise<string>;
  execute?: (command: string[], env: Record<string, string | undefined>) => CommandResult;
}): Promise<CommandResult> {
  const env = input.env ?? process.env;
  const identity = input.identity ?? resolveServiceGitHubAuth(input.service, env);
  const token = await (input.token ?? getServiceGitHubToken)(identity);
  const execute =
    input.execute ??
    ((command, childEnv): CommandResult =>
      Bun.spawnSync({
        cmd: command,
        env: childEnv,
        stdin: input.stdin ?? 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
      }));
  const result = execute([input.command, ...input.args], {
    ...env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  });
  const stderr = new TextDecoder().decode(result.stderr);
  const fallback = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (
    identity.kind === 'app' &&
    result.exitCode !== 0 &&
    stderr.includes('HTTP 403') &&
    /resource not accessible by integration/i.test(stderr) &&
    fallback
  ) {
    return execute([input.command, ...input.args], {
      ...env,
      GH_TOKEN: fallback,
      GITHUB_TOKEN: fallback,
    });
  }
  return result;
}

if (import.meta.main) {
  const [service, command, ...args] = process.argv.slice(2);
  if (!service || !command) throw new Error('github_service_command_required');
  try {
    const result = await runGitHubServiceCommand({
      service: service as GitHubService,
      command,
      args,
      ...(process.stdin.isTTY ? {} : { stdin: await Bun.stdin.bytes() }),
    });
    await Bun.write(Bun.stdout, result.stdout);
    await Bun.write(Bun.stderr, result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    console.error('github_service_command_failed');
    process.exitCode = 1;
  }
}
