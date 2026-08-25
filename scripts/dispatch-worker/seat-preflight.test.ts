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

const GOOD_SEAT_CODEX: SeatConfig = {
  seat_id: 'bdc-seat-codex',
  model_family: 'codex',
  provider_allowlist: ['codex'],
  secret_ingress_file: '/run/m131/secret-ingress/codex-credential.json',
  vendor_profile_dir: '/home/seat/.codex',
  state_dir: '/var/lib/bdc-seat-codex',
};

const GOOD_SEAT_CLAUDE: SeatConfig = {
  seat_id: 'bdc-seat-claude',
  model_family: 'claude',
  provider_allowlist: ['claude'],
  secret_ingress_file: '/run/m131/secret-ingress/claude-credential.json',
  vendor_profile_dir: '/home/seat/.claude',
  state_dir: '/var/lib/bdc-seat-claude',
};

const COMMANDS = { 'grok-acp': 'grok', grok: 'grok', codex: 'codex', claude: 'claude' };

function fakeDeps(overrides: Partial<SeatPreflightDeps> = {}): SeatPreflightDeps {
  return {
    commandAvailable: async () => true,
    isFile: async () => true,
    isDirectory: async () => true,
    // Default fake canonicalization mirrors what real realpath+resolve does for
    // the aliasing forms these tests assert on: strips a trailing slash,
    // collapses './' segments, resolves a leading '../<base>/' relative
    // climb-back-in, and lowercases (case-insensitive filesystem, e.g. default
    // Windows/macOS). It intentionally does NOT resolve arbitrary symlinks --
    // that path is exercised directly via a canonicalPath override below.
    canonicalPath: async (path: string) => {
      let normalized = path.replace(/\/\.\//g, '/').replace(/\/+$/, '');
      // Collapse one 'X/../' pair repeatedly, matching resolve()'s behavior.
      while (/[^/]+\/\.\.\//.test(normalized)) {
        normalized = normalized.replace(/[^/]+\/\.\.\//, '');
      }
      return normalized.toLowerCase();
    },
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

  // REGRESSION (review finding 2026-08-17): isolation was decided by raw
  // string equality, so any of these DIFFERENT strings naming the SAME
  // directory silently passed. Each case must now be refused.
  test.each([
    ['trailing slash', '/home/seat/.grok/'],
    ['dot segment', '/home/seat/./.grok'],
    ['both', '/home/seat/./.grok/'],
    // review finding 2026-08-19: relative-path and case-variant aliases were
    // asserted as fixed but had no dedicated regression coverage.
    ['relative climb-back-in', '/home/seat/other/../.grok'],
    ['case variant (case-insensitive filesystem)', '/home/seat/.GROK'],
    ['case variant with trailing slash', '/HOME/SEAT/.grok/'],
  ])('rejects same-directory-different-string: %s', async (_label, stateDir) => {
    const seat: SeatConfig = { ...GOOD_SEAT, state_dir: stateDir };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_state_not_isolated', field: 'state_dir' });
  });

  test('rejects a symlinked state dir that canonicalizes onto the profile dir', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, state_dir: '/var/lib/link-to-profile' };
    const deps = fakeDeps({
      canonicalPath: async path =>
        path === '/var/lib/link-to-profile' ? GOOD_SEAT.vendor_profile_dir : path,
    });
    const result = await runSeatPreflight(seat, COMMANDS, deps);
    expect(result).toEqual({ ok: false, code: 'seat_state_not_isolated', field: 'state_dir' });
  });

  test('rejects a state dir NESTED inside the vendor profile (not merely equal)', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, state_dir: '/home/seat/.grok/state' };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_state_not_isolated', field: 'state_dir' });
  });

  test('rejects a vendor profile nested inside the state dir (both directions)', async () => {
    const seat: SeatConfig = {
      ...GOOD_SEAT,
      vendor_profile_dir: '/var/lib/bdc-seat-grok/profile',
      state_dir: '/var/lib/bdc-seat-grok',
    };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_state_not_isolated', field: 'state_dir' });
  });

  test('a genuinely distinct sibling directory still passes', async () => {
    const seat: SeatConfig = { ...GOOD_SEAT, state_dir: '/home/seat/.grok-state' };
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result.ok).toBe(true);
  });

  // REGRESSION (review finding 2026-08-17): the Dockerfile defaulted
  // BUILD_SHA to 'unknown' and preflight accepted any non-empty value, so a
  // seat could advertise an identity it did not have.
  test.each(['unknown', 'UNKNOWN', 'none', 'null', 'undefined', 'dev', 'latest'])(
    'rejects placeholder build SHA: %s',
    async placeholder => {
      const result = await runSeatPreflight(
        GOOD_SEAT,
        COMMANDS,
        fakeDeps({ env: { [DEFAULT_BUILD_SHA_ENV]: placeholder } })
      );
      expect(result).toEqual({
        ok: false,
        code: 'seat_build_sha_placeholder',
        field: DEFAULT_BUILD_SHA_ENV,
      });
    }
  );

  test('rejects an implausibly short build SHA', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT,
      COMMANDS,
      fakeDeps({ env: { [DEFAULT_BUILD_SHA_ENV]: 'abc123' } })
    );
    expect(result).toEqual({
      ok: false,
      code: 'seat_build_sha_placeholder',
      field: DEFAULT_BUILD_SHA_ENV,
    });
  });

  test('accepts a real abbreviated git SHA', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT,
      COMMANDS,
      fakeDeps({ env: { [DEFAULT_BUILD_SHA_ENV]: '36c3166e' } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buildSha).toBe('36c3166e');
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

describe('runSeatPreflight model families', () => {
  test.each([
    [GOOD_SEAT_CODEX, 'bdc-seat-codex', 'codex'],
    [GOOD_SEAT_CLAUDE, 'bdc-seat-claude', 'claude'],
  ] as const)('passes the configured family for %s', async (seat, seatId, provider) => {
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.seatId).toBe(seatId);
      expect(result.providers).toEqual([provider]);
    }
  });

  test.each([
    [GOOD_SEAT_CODEX, 'claude', 'seat_provider_not_codex'],
    [GOOD_SEAT_CLAUDE, 'codex', 'seat_provider_not_claude'],
  ] as const)('rejects a cross-family provider for %s', async (seat, provider, code) => {
    const result = await runSeatPreflight(
      { ...seat, provider_allowlist: [provider] },
      COMMANDS,
      fakeDeps()
    );
    expect(result).toEqual({ ok: false, code, field: 'provider_allowlist' });
  });

  test('defaults an omitted model_family to Grok for Phase A compatibility', async () => {
    const result = await runSeatPreflight(
      { ...GOOD_SEAT, provider_allowlist: ['claude'] },
      COMMANDS,
      fakeDeps()
    );
    expect(result).toEqual({
      ok: false,
      code: 'seat_provider_not_grok',
      field: 'provider_allowlist',
    });
  });

  test('rejects an unknown model_family as invalid configuration', async () => {
    const seat = { ...GOOD_SEAT, model_family: 'other' } as unknown as SeatConfig;
    const result = await runSeatPreflight(seat, COMMANDS, fakeDeps());
    expect(result).toEqual({ ok: false, code: 'seat_config_invalid', field: 'model_family' });
  });

  test.each([GOOD_SEAT_CODEX, GOOD_SEAT_CLAUDE])(
    'fails closed before execution when auth is missing for %s',
    async seat => {
      let commandChecked = false;
      const result = await runSeatPreflight(
        seat,
        COMMANDS,
        fakeDeps({
          commandAvailable: async () => {
            commandChecked = true;
            return true;
          },
          isFile: async () => false,
        })
      );
      expect(commandChecked).toBe(true);
      expect(result).toEqual({
        ok: false,
        code: 'seat_secret_ingress_missing',
        field: 'secret_ingress_file',
      });
    }
  );
});
