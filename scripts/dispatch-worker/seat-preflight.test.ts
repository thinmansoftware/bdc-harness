/**
 * Scenario A1 (WO-HARNESS-M131-PHASE-A-GROK-SEAT-PROOF-01): preflight blocks
 * advertisement. Hermetic -- fake deps only, no real command, credential,
 * profile, or provider path is ever touched.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BUILD_SHA_ENV,
  runSeatPreflight,
  type SeatConfig,
  type SeatPreflightDeps,
} from './seat-preflight';

const GOOD_SEAT: SeatConfig = {
  seat_id: 'bdc-seat-grok',
  provider_allowlist: ['grok-acp'],
  secret_ingress_file: '/run/m131/secret-ingress/grok-credential.json',
  vendor_profile_dir: '/home/seat/.grok',
  state_dir: '/var/lib/bdc-seat-grok',
};

const COMMANDS = { 'grok-acp': 'grok', grok: 'grok', claude: 'claude' };

function fakeDeps(overrides: Partial<SeatPreflightDeps> = {}): SeatPreflightDeps {
  return {
    commandAvailable: async () => true,
    isFile: async () => true,
    isDirectory: async () => true,
    env: { [DEFAULT_BUILD_SHA_ENV]: 'abc123def456' },
    ...overrides,
  };
}

describe('runSeatPreflight', () => {
  test('passes a fully valid Grok seat and reports build SHA', async () => {
    const result = await runSeatPreflight(GOOD_SEAT, COMMANDS, fakeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seatId).toBe('bdc-seat-grok');
      expect(result.providers).toEqual(['grok-acp']);
      expect(result.buildSha).toBe('abc123def456');
    }
  });

  test('fails typed when the provider command is unavailable', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT,
      COMMANDS,
      fakeDeps({ commandAvailable: async () => false })
    );
    expect(result).toEqual({
      ok: false,
      code: 'seat_provider_command_unavailable',
      field: 'agents',
    });
  });

  test('fails typed when the synthetic profile directory is absent', async () => {
    const deps = fakeDeps({
      isDirectory: async path => path !== GOOD_SEAT.vendor_profile_dir,
    });
    const result = await runSeatPreflight(GOOD_SEAT, COMMANDS, deps);
    expect(result).toEqual({
      ok: false,
      code: 'seat_vendor_profile_dir_invalid',
      field: 'vendor_profile_dir',
    });
  });

  test('fails typed when the secret-ingress file is missing', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT,
      COMMANDS,
      fakeDeps({ isFile: async () => false })
    );
    expect(result).toEqual({
      ok: false,
      code: 'seat_secret_ingress_missing',
      field: 'secret_ingress_file',
    });
  });

  test('fails typed when the state directory is missing', async () => {
    const deps = fakeDeps({
      isDirectory: async path => path !== GOOD_SEAT.state_dir,
    });
    const result = await runSeatPreflight(GOOD_SEAT, COMMANDS, deps);
    expect(result).toEqual({ ok: false, code: 'seat_state_dir_invalid', field: 'state_dir' });
  });

  test('fails typed when state and vendor profile share a directory', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, state_dir: GOOD_SEAT.vendor_profile_dir };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_state_not_isolated', field: 'state_dir' });
  });

  test('rejects a non-Grok provider allowlist', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, provider_allowlist: ['claude'] };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({
      ok: false,
      code: 'seat_provider_not_grok',
      field: 'provider_allowlist',
    });
  });

  test('rejects a multi-provider allowlist (concurrency-one seat)', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, provider_allowlist: ['grok-acp', 'grok'] };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_config_invalid', field: 'provider_allowlist' });
  });

  test('rejects an allowlisted provider with no configured command', async () => {
    const result = await runSeatPreflight(GOOD_SEAT, {}, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_config_invalid', field: 'agents' });
  });

  test('fails typed when the build SHA env var is empty', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT,
      COMMANDS,
      fakeDeps({ env: { [DEFAULT_BUILD_SHA_ENV]: '  ' } })
    );
    expect(result).toEqual({
      ok: false,
      code: 'seat_build_sha_missing',
      field: DEFAULT_BUILD_SHA_ENV,
    });
  });

  test('honors a custom build_sha_env name', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, build_sha_env: 'M131_BUILD_SHA' };
    const result = await runSeatPreflight(
      seat,
      COMMANDS,
      fakeDeps({ env: { M131_BUILD_SHA: 'feedbeef' } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buildSha).toBe('feedbeef');
  });

  test('sanitizes failures: no path value ever appears in the result', async () => {
    const failures = [
      await runSeatPreflight(GOOD_SEAT, COMMANDS, fakeDeps({ isFile: async () => false })),
      await runSeatPreflight(GOOD_SEAT, COMMANDS, fakeDeps({ isDirectory: async () => false })),
      await runSeatPreflight(GOOD_SEAT, {}, fakeDeps()),
    ];
    for (const failure of failures) {
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain('/run/m131');
      expect(serialized).not.toContain('/home/seat');
      expect(serialized).not.toContain('/var/lib');
      expect(serialized).not.toContain('credential');
    }
  });
});
