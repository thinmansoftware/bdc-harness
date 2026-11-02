/**
 * Seat preflight -- deterministic, injectable validation for an isolated
 * server seat (M-131 Phase A/B).
 *
 * A seat-configured worker MUST pass this preflight before it advertises,
 * polls, or claims any Dispatch work. Every failure is a typed, sanitized
 * error: the error code and field name are reported, but path values, file
 * contents, and credential material are never echoed.
 *
 * Pure by construction: all filesystem and environment access goes through
 * the injected SeatPreflightDeps, so unit tests run hermetically with fakes
 * and never touch a real credential, profile, or provider binary.
 */
import { realpath, stat } from 'fs/promises';
import { resolve } from 'path';
import { defaultAgentConfigs } from './adapters';

/** Seat block of the worker configuration (config.seat). */
export interface SeatConfig {
  /** Stable seat identity, e.g. 'bdc-seat-grok'. */
  seat_id: string;
  /** Model family served by this seat. Omitted Phase A configs default to Grok. */
  model_family?: 'grok' | 'codex' | 'claude' | 'cursor';
  /**
   * Providers this seat may advertise and run. Seats are single-provider:
   * exactly one entry, and it must match the configured model family.
   */
  provider_allowlist: string[];
  /**
   * Read-only #1327 secret-ingress file path. Preflight verifies presence
   * and file-ness only; it never reads or reports the contents.
   */
  secret_ingress_file: string;
  /** Seat-private writable vendor-profile directory (exactly one refresh writer). */
  vendor_profile_dir: string;
  /** Separate non-secret state directory. Must differ from the profile dir. */
  state_dir: string;
  /** Env var carrying the image build SHA. Defaults to SEAT_BUILD_SHA. */
  build_sha_env?: string;
}

export interface SeatPreflightDeps {
  /** True when the provider command resolves to an executable. */
  commandAvailable(command: string): Promise<boolean>;
  /** True when the path exists and is a regular file. */
  isFile(path: string): Promise<boolean>;
  /** True when the path exists and is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /**
   * Canonical absolute path with symlinks resolved. Used for the
   * profile/state isolation check -- string comparison alone is NOT
   * sufficient, because a trailing slash, a './' segment, a relative form, a
   * case variant on a case-insensitive filesystem, or a symlink can all name
   * the SAME directory while comparing unequal. Review finding 2026-08-17.
   */
  canonicalPath(path: string): Promise<string>;
  env: Record<string, string | undefined>;
}

/**
 * Build SHA values that carry no information. A seat that advertises one of
 * these is claiming an identity it does not have, which is worse than failing
 * closed because it looks like an answer. Review finding 2026-08-17: the
 * Dockerfile defaults BUILD_SHA to 'unknown', and preflight previously
 * accepted any non-empty string.
 */
const PLACEHOLDER_BUILD_SHAS = new Set(['unknown', 'none', 'null', 'undefined', 'dev', 'latest']);

/** Minimum plausible length for an abbreviated git SHA. */
const MIN_BUILD_SHA_LENGTH = 7;

/**
 * True when `inner` is the same directory as `outer` or nested inside it.
 * Nesting matters: a state dir inside the vendor profile is not isolated from
 * it either, so equality alone is too weak a test.
 */
export function isSameOrNested(a: string, b: string): boolean {
  // Compare with a normalized separator so the check behaves identically on
  // POSIX and Windows; canonicalPath may return either form.
  const norm = (value: string): string => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const left = norm(a);
  const right = norm(b);
  if (left === right) return true;
  return left.startsWith(right + '/') || right.startsWith(left + '/');
}

export type SeatPreflightErrorCode =
  | 'seat_config_invalid'
  | 'seat_provider_not_grok'
  | 'seat_provider_not_codex'
  | 'seat_provider_not_claude'
  | 'seat_provider_not_cursor'
  | 'seat_provider_command_unavailable'
  | 'seat_secret_ingress_missing'
  | 'seat_vendor_profile_dir_invalid'
  | 'seat_state_dir_invalid'
  | 'seat_state_not_isolated'
  | 'seat_build_sha_missing'
  | 'seat_build_sha_placeholder';

export type SeatPreflightResult =
  | { ok: true; seatId: string; providers: string[]; buildSha: string }
  | { ok: false; code: SeatPreflightErrorCode; field: string };

export const DEFAULT_BUILD_SHA_ENV = 'SEAT_BUILD_SHA';

type ModelFamily = NonNullable<SeatConfig['model_family']>;

// WO-HARNESS-M131-PHASE-B-CODEX-CLAUDE-SEATS-01: PHASE-B-SEAT-PACKAGING-01
// (bdc-harness#703, merged) added codex/claude packaging using the PLAIN CLI
// adapters only, explicitly to stay clear of the separate ACP/MCP operator-
// host promotion gate. This WO's own spec calls for the ACP/MCP legs
// specifically (EXISTING mcp/session.ts runMcpAgent, EXISTING
// claude-acp/adapter.ts, preserving the M-126 lifecycle), so codex-mcp and
// claude-acp are added here alongside the plain names -- a seat MAY run
// either transport for its family; preflight still enforces exactly one
// PROVIDER (not one transport) per the existing single-entry allowlist rule.
const FAMILY_ADAPTERS: Record<ModelFamily, ReadonlySet<string>> = {
  // 'grok-via-cursor' is the container-side transport added by
  // WO-HARNESS-CURSOR-BUILD-SEAT-01: the xAI API is defunded, so a grok seat
  // running inside a container reaches Grok THROUGH cursor-agent. It is a
  // transport for the grok family, not a separate family -- the seat is still
  // the grok seat, only the pipe differs.
  grok: new Set(['grok-acp', 'grok', 'grok-via-cursor']),
  codex: new Set(['codex', 'codex-mcp']),
  claude: new Set(['claude', 'claude-acp']),
  // WO-HARNESS-CURSOR-BUILD-SEAT-01: the cursor seat is a BUILD seat, so only
  // the build-capable leg is allowed. The read-only `cursor` adapter
  // (--mode ask) is deliberately NOT in this set: a build seat that silently
  // cannot write files would burn a rung and report success.
  cursor: new Set(['cursor-build']),
};

const FAMILY_ERROR_CODE: Record<ModelFamily, SeatPreflightErrorCode> = {
  grok: 'seat_provider_not_grok',
  codex: 'seat_provider_not_codex',
  claude: 'seat_provider_not_claude',
  cursor: 'seat_provider_not_cursor',
};

/**
 * WO-HARNESS-CURSOR-BUILD-SEAT-01 -- empty-output guard.
 *
 * cursor-agent exits 0 with NO output when workspace trust is not granted
 * (verified live on the target host, 2026-08-26: the CLI prints a Workspace
 * Trust notice and returns rc 0). A zero exit code is therefore NOT sufficient
 * evidence that the seat did any work. Callers MUST treat an empty result as
 * a failed attempt rather than a silent success.
 *
 * Same rule as the Board-Secretary 0-byte-output prior art.
 */
export function cursorBuildResultIsEmpty(stdout: string): boolean {
  return stdout.trim().length === 0;
}

function fail(code: SeatPreflightErrorCode, field: string): SeatPreflightResult {
  return { ok: false, code, field };
}

/**
 * Validates seat identity, model-family provider restriction, provider command
 * availability, secret-ingress presence, profile/state isolation, and build
 * SHA visibility. Returns a typed result; never throws for validation
 * failures and never includes path values or file contents in the result.
 */
export async function runSeatPreflight(
  seat: SeatConfig,
  agentCommands: Record<string, string>,
  deps: SeatPreflightDeps
): Promise<SeatPreflightResult> {
  if (!seat.seat_id || typeof seat.seat_id !== 'string') {
    return fail('seat_config_invalid', 'seat_id');
  }
  if (!Array.isArray(seat.provider_allowlist) || seat.provider_allowlist.length !== 1) {
    return fail('seat_config_invalid', 'provider_allowlist');
  }
  const modelFamily = seat.model_family ?? 'grok';
  if (!Object.hasOwn(FAMILY_ADAPTERS, modelFamily)) {
    return fail('seat_config_invalid', 'model_family');
  }
  const provider = seat.provider_allowlist[0];
  if (provider === undefined || !FAMILY_ADAPTERS[modelFamily].has(provider)) {
    return fail(FAMILY_ERROR_CODE[modelFamily], 'provider_allowlist');
  }
  const command = agentCommands[provider];
  if (!command) {
    return fail('seat_config_invalid', 'agents');
  }
  if (!(await deps.commandAvailable(command))) {
    return fail('seat_provider_command_unavailable', 'agents');
  }
  if (!seat.secret_ingress_file || !(await deps.isFile(seat.secret_ingress_file))) {
    return fail('seat_secret_ingress_missing', 'secret_ingress_file');
  }
  if (!seat.vendor_profile_dir || !(await deps.isDirectory(seat.vendor_profile_dir))) {
    return fail('seat_vendor_profile_dir_invalid', 'vendor_profile_dir');
  }
  if (!seat.state_dir || !(await deps.isDirectory(seat.state_dir))) {
    return fail('seat_state_dir_invalid', 'state_dir');
  }
  // Isolation is decided on CANONICAL paths, not raw strings: a trailing
  // slash, './', a relative form, a case variant, or a symlink can all name
  // the same directory. Nesting counts as non-isolated too.
  let canonicalProfile: string;
  let canonicalState: string;
  try {
    canonicalProfile = await deps.canonicalPath(seat.vendor_profile_dir);
    canonicalState = await deps.canonicalPath(seat.state_dir);
  } catch {
    return fail('seat_state_not_isolated', 'state_dir');
  }
  if (isSameOrNested(canonicalProfile, canonicalState)) {
    return fail('seat_state_not_isolated', 'state_dir');
  }

  const buildShaEnv = seat.build_sha_env ?? DEFAULT_BUILD_SHA_ENV;
  const buildSha = deps.env[buildShaEnv]?.trim();
  if (!buildSha) {
    return fail('seat_build_sha_missing', buildShaEnv);
  }
  // A placeholder SHA is not an identity. Refuse it rather than advertising
  // a seat that cannot be tied back to an exact commit.
  if (
    PLACEHOLDER_BUILD_SHAS.has(buildSha.toLowerCase()) ||
    buildSha.length < MIN_BUILD_SHA_LENGTH
  ) {
    return fail('seat_build_sha_placeholder', buildShaEnv);
  }
  return { ok: true, seatId: seat.seat_id, providers: [provider], buildSha };
}

/** Production deps: real command resolution, filesystem, and process env. */
export function realSeatPreflightDeps(): SeatPreflightDeps {
  return {
    async commandAvailable(command: string): Promise<boolean> {
      return Bun.which(command) !== null;
    },
    async isFile(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    async canonicalPath(path: string): Promise<string> {
      // realpath resolves symlinks and normalizes separators/'.'/'..'.
      // Fall back to resolve() when the path cannot be canonicalized, so an
      // unresolvable path still gets normalized rather than compared raw.
      try {
        return await realpath(resolve(path));
      } catch {
        return resolve(path);
      }
    },
    env: process.env,
  };
}

/**
 * Health-instrument CLI: `bun run scripts/dispatch-worker/seat-preflight.ts
 * --config <worker-config.json>` exits 0 when the configured seat passes
 * preflight and 1 otherwise, printing only the typed code and field. Used by
 * the m131-seat container healthcheck; safe because it never prints paths,
 * contents, or credentials.
 */
if (import.meta.main) {
  const index = process.argv.indexOf('--config');
  const configPath = index === -1 ? undefined : process.argv[index + 1];
  if (!configPath) {
    console.error('Usage: bun run scripts/dispatch-worker/seat-preflight.ts --config <path>');
    process.exit(2);
  }
  const raw = (await Bun.file(configPath).json()) as {
    seat?: SeatConfig;
    agents?: Record<string, { command?: string }>;
  };
  if (!raw.seat) {
    console.error('seat_config_invalid field=seat');
    process.exit(1);
  }
  const commands: Record<string, string> = {};
  for (const [name, agent] of Object.entries(defaultAgentConfigs)) {
    commands[name] = agent.command;
  }
  for (const [name, agent] of Object.entries(raw.agents ?? {})) {
    if (agent?.command) commands[name] = agent.command;
  }
  const result = await runSeatPreflight(raw.seat, commands, realSeatPreflightDeps());
  if (result.ok) {
    console.log(`seat_preflight_ok seat=${result.seatId} build_sha=${result.buildSha}`);
    process.exit(0);
  }
  console.error(`${result.code} field=${result.field}`);
  process.exit(1);
}
