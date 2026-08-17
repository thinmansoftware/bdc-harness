/**
 * Seat preflight -- deterministic, injectable validation for an isolated
 * server seat (M-131 Phase A, WO-HARNESS-M131-PHASE-A-GROK-SEAT-PROOF-01).
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
import { stat } from 'fs/promises';
import { defaultAgentConfigs } from './adapters';

/** Seat block of the worker configuration (config.seat). */
export interface SeatConfig {
  /** Stable seat identity, e.g. 'bdc-seat-grok'. */
  seat_id: string;
  /**
   * Providers this seat may advertise and run. Phase A seats are
   * single-provider: exactly one entry, and it must be a Grok adapter.
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
  env: Record<string, string | undefined>;
}

export type SeatPreflightErrorCode =
  | 'seat_config_invalid'
  | 'seat_provider_not_grok'
  | 'seat_provider_command_unavailable'
  | 'seat_secret_ingress_missing'
  | 'seat_vendor_profile_dir_invalid'
  | 'seat_state_dir_invalid'
  | 'seat_state_not_isolated'
  | 'seat_build_sha_missing';

export type SeatPreflightResult =
  | { ok: true; seatId: string; providers: string[]; buildSha: string }
  | { ok: false; code: SeatPreflightErrorCode; field: string };

export const DEFAULT_BUILD_SHA_ENV = 'SEAT_BUILD_SHA';

/** Adapter names this Phase A seat accepts (Grok only, ACP preferred). */
const GROK_ADAPTERS = new Set(['grok-acp', 'grok']);

function fail(code: SeatPreflightErrorCode, field: string): SeatPreflightResult {
  return { ok: false, code, field };
}

/**
 * Validates seat identity, Grok-only provider restriction, provider command
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
  const provider = seat.provider_allowlist[0];
  if (provider === undefined || !GROK_ADAPTERS.has(provider)) {
    return fail('seat_provider_not_grok', 'provider_allowlist');
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
  if (seat.state_dir === seat.vendor_profile_dir) {
    return fail('seat_state_not_isolated', 'state_dir');
  }
  const buildShaEnv = seat.build_sha_env ?? DEFAULT_BUILD_SHA_ENV;
  const buildSha = deps.env[buildShaEnv]?.trim();
  if (!buildSha) {
    return fail('seat_build_sha_missing', buildShaEnv);
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
