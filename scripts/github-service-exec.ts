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

/** Services a builder lane (laneuser UID) is permitted to act as. A lane IS
 * Builder 2 (run_nodes); smart_cauldron is the lane's own batch identity. Any
 * other service (overseer, merge_manager, taskmaster, ...) is refused so a lane
 * cannot mint or act as the reviewer / merge manager even though the gh shim
 * reads ARCHON_GITHUB_SERVICE, which a lane can set.
 * (WO-HARNESS-APP-KEY-ISOLATION-01, Test 3) */
const LANE_ALLOWED_SERVICES: ReadonlySet<GitHubService> = new Set<GitHubService>([
  'run_nodes',
  'smart_cauldron',
]);

/** The unprivileged lane UID (laneuser); overridable for tests. */
function laneUid(): number {
  const parsed = Number.parseInt(process.env.ARCHON_LANE_UID ?? '1002', 10);
  return Number.isNaN(parsed) ? 1002 : parsed;
}

/** Throw lane_service_forbidden when a builder lane (lane UID) requests a
 * non-builder GitHub service. */
export function assertLaneServiceAllowed(
  service: GitHubService,
  currentUid: number | undefined
): void {
  if (currentUid === laneUid() && !LANE_ALLOWED_SERVICES.has(service)) {
    throw new Error(
      `lane_service_forbidden: builder lane may not act as GitHub service '${service}'`
    );
  }
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
  /** Effective UID of this process; defaults to process.getuid(). Injected in tests. */
  currentUid?: number;
  /** Observability hook invoked once when metering is skipped (unwritable DB). */
  onMeteringSkipped?: () => void;
}): Promise<CommandResult> {
  const env = input.env ?? process.env;
  assertLaneServiceAllowed(input.service, input.currentUid ?? process.getuid?.());
  const identity = input.identity ?? resolveServiceGitHubAuth(input.service, env);
  // Metering persists to archon.db. A builder lane (laneuser UID) cannot open or
  // write the server-owned archon.db (0600 owner 1001); when the DB is
  // unavailable, skip metering with a single warning rather than failing the gh
  // command the lane needs. (WO-HARNESS-APP-KEY-ISOLATION-01, Test 3)
  let db: IDatabase | undefined = input.db;
  if (!db) {
    try {
      db = getDatabase();
    } catch {
      db = undefined;
    }
  }
  let meteringSkipLogged = false;
  const skipMetering = (): void => {
    if (meteringSkipLogged) return;
    meteringSkipLogged = true;
    process.stderr.write(
      'github_metering_skipped: archon.db not accessible from this process; continuing without GitHub API metering\n'
    );
    input.onMeteringSkipped?.();
  };
  /** Persist buffered meter rows, degrading to a skip when the DB is unwritable. */
  const flushMeter = async (): Promise<void> => {
    if (!db) {
      skipMetering();
      return;
    }
    try {
      await flushGitHubApiMeter(db);
    } catch {
      skipMetering();
      db = undefined;
    }
  };
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
    // A gh command may use REST and GraphQL in the same operation. Refuse
    // conservatively if any of its pool's known resources is exhausted. When the
    // DB is unreachable (lane UID), skip the check rather than block the command.
    if (db) {
      try {
        await assertPersistedGitHubPoolAvailable(
          selected.poolId,
          ['core', 'graphql', 'search', 'cli'],
          db
        );
      } catch (poolError) {
        // Preserve a genuine pool-availability refusal (github_pool_backoff);
        // only swallow DB-access failures (unwritable/unreadable archon.db from
        // a lane UID) as a metering skip.
        if (poolError instanceof Error && poolError.message.startsWith('github_pool_backoff')) {
          throw poolError;
        }
        skipMetering();
        db = undefined;
      }
    } else {
      skipMetering();
    }
    const token =
      selected.kind === 'pat'
        ? selected.token
        : await (input.token ?? getServiceGitHubToken)(selected);
    let result: CommandResult;
    try {
      result = execute([input.command, ...input.args], {
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
      await flushMeter();
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
    await flushMeter();
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
    // Surface the lane refusal verbatim so operators (and Stop/Test 3) see why a
    // builder lane was denied a non-builder GitHub service.
    if (error instanceof Error && error.message.startsWith('lane_service_forbidden')) {
      console.error(error.message);
    } else {
      console.error(
        `github_service_command_failed:${error instanceof Error ? error.name : 'unknown'}`
      );
    }
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}
