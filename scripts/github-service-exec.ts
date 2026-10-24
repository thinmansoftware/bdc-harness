import {
  getServiceGitHubToken,
  resolveServiceGitHubAuth,
  type GitHubService,
  type ServiceGitHubAuth,
} from '../packages/core/src/github/service-identity';
import { closeDatabase, getDatabase } from '../packages/core/src/db/connection';
import type { IDatabase } from '../packages/core/src/db/adapters/types';
import { rootLogger } from '../packages/paths/src/logger';
import {
  assertPersistedGitHubPoolAvailable,
  flushGitHubApiMeter,
  observationFromResponse,
  recordGitHubApiCall,
  type GitHubApiObservation,
} from '../packages/core/src/github/metering';

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

/** Narrow proof for one REST-only command; ambiguous commands may mix resources. */
function commandResources(command: string, args: readonly string[]): readonly string[] {
  const executable = command.split(/[\\/]/).at(-1);
  const endpoint = args[1] ?? '';
  const pulls =
    /^repos\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/pulls\?state=all&per_page=100&sort=created&direction=asc$/;
  if (
    (executable === 'gh' || executable === 'gh.exe') &&
    args.length === 4 &&
    args[0] === 'api' &&
    args[2] === '--paginate' &&
    args[3] === '--slurp' &&
    // Compare the whole match: '$' alone also accepts a trailing newline.
    pulls.exec(endpoint)?.[0] === endpoint
  ) {
    // Keep the CLI transport/secondary-limit gate even for a proven REST call.
    return ['core', 'cli'];
  }
  return ['core', 'graphql', 'search', 'cli'];
}

/** Only buffer input when gh explicitly requests it, so permission retries can replay it. */
export function githubCommandReadsStdin(args: string[]): boolean {
  if (args[0] === 'workflow' && args[1] === 'run' && args.includes('--json')) return true;
  if (args[0] === 'gist' && args[1] === 'create' && args.includes('-')) return true;
  return args.some((arg, index) => {
    if (arg === '--with-token') return true;
    if (arg === '--input=-' || arg === '--body-file=-') return true;
    if (arg === '-' && ['--input', '--body-file', '-F'].includes(args[index - 1] ?? '')) {
      return true;
    }
    return (
      ((arg === '--field' || arg === '-F') && (args[index + 1] ?? '').endsWith('=@-')) ||
      /^(?:--field=|-F).+=@-$/.test(arg)
    );
  });
}

/** Consume gh's captured HTTP trace; never forward headers, URLs or bodies. */
export function consumeGitHubTrace(
  raw: string,
  service: GitHubService,
  poolId: string,
  permissionFallback: boolean
): { stderr: string; observations: GitHubApiObservation[] } {
  let inRequest = false;
  let status = 0;
  let headers = new Headers();
  const visible: string[] = [];
  const observations: GitHubApiObservation[] = [];
  const finish = (): void => {
    if (status >= 200 && status <= 599) {
      observations.push(
        observationFromResponse(service, poolId, new Response(null, { status, headers }), {
          permissionFallback,
        })
      );
    }
    status = 0;
    headers = new Headers();
  };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('* Request at ')) {
      finish();
      inRequest = true;
    } else if (line.startsWith('* Request took ')) {
      finish();
      inRequest = false;
    } else if (inRequest) {
      const response = /^< HTTP\/\S+ (\d{3})/.exec(line);
      const header =
        /^< (x-ratelimit-(?:limit|remaining|reset|resource)|retry-after):\s*(.*)$/i.exec(line);
      if (response) status = Number(response[1]);
      if (header) headers.set(header[1], header[2]);
    } else if (!/^[*<>]/.test(line)) visible.push(line);
  }
  finish();
  return { stderr: visible.join('\n'), observations };
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
  db?: IDatabase;
}): Promise<CommandResult> {
  // Classify and execute the same argv even if a caller mutates its input while
  // quota checks or token minting await. Permission retries reuse this snapshot.
  const command = input.command;
  const args = [...input.args];
  const resources = commandResources(command, args);
  const env = input.env ?? process.env;
  const identity = input.identity ?? resolveServiceGitHubAuth(input.service, env);
  const db = input.db ?? getDatabase();
  const execute =
    input.execute ??
    ((command, childEnv): CommandResult =>
      Bun.spawnSync({
        cmd: command,
        env: childEnv,
        stdin: input.stdin ? (input.stdin.byteLength ? input.stdin : 'ignore') : 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
      }));
  const fallback = env.ARCHON_GITHUB_PERMISSION_FALLBACK_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  // WO-HARNESS-OPEN-PR-REFUSES-REVIEWER-AUTHOR-01: a lane that must never author
  // as the reviewer (the open-pr-if-needed node) sets
  // ARCHON_GITHUB_NO_PERMISSION_FALLBACK=1 so an App permission 403 fails closed
  // instead of silently retrying with the reviewer/user PAT fallback. Without
  // this, a distinct builder App can pass the lane's acting-login guard and then
  // open the PR as the reviewer via the fallback token.
  const permissionFallbackDisabled =
    env.ARCHON_GITHUB_NO_PERMISSION_FALLBACK === '1' ||
    env.ARCHON_GITHUB_NO_PERMISSION_FALLBACK === 'true';
  const invoke = async (
    selected: ServiceGitHubAuth,
    permissionFallback = false
  ): Promise<CommandResult> => {
    await assertPersistedGitHubPoolAvailable(selected.poolId, resources, db);
    const token =
      selected.kind === 'pat'
        ? selected.token
        : await (input.token ?? getServiceGitHubToken)(selected);
    let result: CommandResult;
    try {
      result = execute([command, ...args], {
        ...env,
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        GH_DEBUG: 'api',
        CLICOLOR: '0',
      });
    } catch (error) {
      recordGitHubApiCall({
        service: input.service,
        poolId: selected.poolId,
        resource: 'cli',
        status: 0,
        permissionFallback,
      });
      await flushGitHubApiMeter(db);
      throw error;
    }
    const trace = consumeGitHubTrace(
      new TextDecoder().decode(result.stderr),
      input.service,
      selected.poolId,
      permissionFallback
    );
    for (const observation of trace.observations) recordGitHubApiCall(observation);
    // No trace (transport/startup failure or a non-HTTP command) is an explicit
    // CLI attempt, not a fabricated successful API request.
    if (!trace.observations.length) {
      const rateLimited = /(?:API|secondary) rate limit|abuse detection/i.test(trace.stderr);
      recordGitHubApiCall({
        service: input.service,
        poolId: selected.poolId,
        resource: 'cli',
        status: 0,
        rateLimited,
        permissionFallback,
        ...(rateLimited ? { remaining: 0, reset: Math.floor(Date.now() / 1000) + 60 } : {}),
      });
    }
    // Persist before exit/retry so the next CLI process sees the same pool.
    await flushGitHubApiMeter(db);
    let stderr = trace.stderr;
    for (const secret of [token, fallback]) {
      if (secret) stderr = stderr.split(secret).join('[redacted]');
    }
    return { ...result, stderr: new TextEncoder().encode(stderr) };
  };
  const result = await invoke(identity);
  const stderr = new TextDecoder().decode(result.stderr);
  if (
    identity.kind === 'app' &&
    result.exitCode !== 0 &&
    /(?:HTTP 403|GraphQL:)[\s\S]*resource not accessible by integration|resource not accessible by integration[\s\S]*HTTP 403/i.test(
      stderr
    ) &&
    fallback &&
    !permissionFallbackDisabled
  ) {
    return invoke(
      { kind: 'pat', service: input.service, token: fallback, poolId: 'user-pat', distinct: false },
      true
    );
  }
  return result;
}

if (import.meta.main) {
  // stdout is gh's machine-readable response, never database startup logs.
  rootLogger.level = 'silent';
  const [service, command, ...args] = process.argv.slice(2);
  if (!service || !command) throw new Error('github_service_command_required');
  try {
    const result = await runGitHubServiceCommand({
      service: service as GitHubService,
      command,
      args,
      ...(!process.stdin.isTTY && githubCommandReadsStdin(args)
        ? { stdin: await Bun.stdin.bytes() }
        : {}),
    });
    if (result.stdout.byteLength) await Bun.write(Bun.stdout, result.stdout);
    if (result.stderr.byteLength) await Bun.write(Bun.stderr, result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(
      `github_service_command_failed:${error instanceof Error ? error.name : 'unknown'}`
    );
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
