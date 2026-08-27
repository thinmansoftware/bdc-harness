/**
 * WO-HARNESS-CURSOR-BUILD-SEAT-01 -- cursor seat preflight + ladder scenarios.
 *
 * Hermetic: fake deps only. No real cursor-agent binary, credential, profile,
 * or network call is touched. The live headless-auth proof for this seat is
 * the PR-body transcript (spec stop condition 4), not this suite.
 */
import { describe, expect, test } from 'bun:test';
import {
  cursorBuildResultIsEmpty,
  runSeatPreflight,
  type SeatConfig,
  type SeatPreflightDeps,
} from './seat-preflight';
import { CURSOR_GROK_MODEL, defaultAgentConfigs } from './adapters';
import ladderConfig from '../../packages/smart-cauldron/config/ladder.config.json';

const GOOD_SEAT_CURSOR: SeatConfig = {
  seat_id: 'bdc-seat-cursor',
  model_family: 'cursor',
  provider_allowlist: ['cursor-build'],
  secret_ingress_file: '/run/m131/secret-ingress/cursor-credential.json',
  vendor_profile_dir: '/home/seat/.cursor',
  state_dir: '/var/lib/bdc-seat-cursor',
};

const COMMANDS = { 'cursor-build': 'cursor-agent', cursor: 'cursor-agent' };

function fakeDeps(overrides: Partial<SeatPreflightDeps> = {}): SeatPreflightDeps {
  return {
    commandAvailable: async () => true,
    isFile: async () => true,
    isDirectory: async () => true,
    canonicalPath: async (path: string) => path.replace(/\/+$/, '').toLowerCase(),
    env: { SEAT_BUILD_SHA: 'abc1234def5678' },
    ...overrides,
  };
}

describe('cursor seat preflight', () => {
  // Scenario 1 (success): a correctly configured cursor seat passes preflight
  // and advertises exactly the build-capable provider.
  test('passes and advertises cursor-build when fully configured', async () => {
    const result = await runSeatPreflight(GOOD_SEAT_CURSOR, COMMANDS, fakeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seatId).toBe('bdc-seat-cursor');
    expect(result.providers).toEqual(['cursor-build']);
    expect(result.buildSha).toBe('abc1234def5678');
  });

  // Scenario 2 (validation -- auth missing): with no secret-ingress file
  // present, preflight fails CLOSED with the typed reason and the seat never
  // advertises. Nothing is executed.
  test('fails closed with typed reason when the credential is absent', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT_CURSOR,
      COMMANDS,
      fakeDeps({ isFile: async () => false })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('seat_secret_ingress_missing');
    expect(result.field).toBe('secret_ingress_file');
    // The failure must not leak the path value.
    expect(JSON.stringify(result)).not.toContain('/run/m131');
  });

  // The read-only `cursor` adapter must be refused for a BUILD seat: it runs
  // with --mode ask and cannot write files, so it would burn a rung while
  // appearing to succeed.
  test('refuses the read-only cursor adapter on a build seat', async () => {
    const result = await runSeatPreflight(
      { ...GOOD_SEAT_CURSOR, provider_allowlist: ['cursor'] },
      COMMANDS,
      fakeDeps()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('seat_provider_not_cursor');
  });

  test('refuses a cursor seat that is missing its provider command', async () => {
    const result = await runSeatPreflight(
      GOOD_SEAT_CURSOR,
      COMMANDS,
      fakeDeps({ commandAvailable: async () => false })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('seat_provider_command_unavailable');
  });
});

describe('grok-via-cursor transport', () => {
  // The transport half: a GROK seat whose container-side pipe is cursor-agent.
  // The seat stays the grok seat -- only the transport differs -- so this must
  // pass under model_family 'grok', not a cursor family.
  const GROK_OVER_CURSOR: SeatConfig = {
    seat_id: 'bdc-seat-grok',
    model_family: 'grok',
    provider_allowlist: ['grok-via-cursor'],
    secret_ingress_file: '/run/m131/secret-ingress/cursor-credential.json',
    vendor_profile_dir: '/home/seat/.cursor',
    state_dir: '/var/lib/bdc-seat-grok',
  };

  const GROK_COMMANDS = {
    'grok-via-cursor': 'cursor-agent',
    grok: 'grok',
    'grok-acp': 'grok',
  };

  test('a grok seat may run over the cursor transport', async () => {
    const result = await runSeatPreflight(GROK_OVER_CURSOR, GROK_COMMANDS, fakeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.seatId).toBe('bdc-seat-grok');
    expect(result.providers).toEqual(['grok-via-cursor']);
  });

  test('the transport is refused for a non-grok family', async () => {
    const result = await runSeatPreflight(
      { ...GROK_OVER_CURSOR, model_family: 'codex' },
      GROK_COMMANDS,
      fakeDeps()
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('seat_provider_not_codex');
  });

  test('fails closed when cursor-agent is absent on a grok transport seat', async () => {
    const result = await runSeatPreflight(
      GROK_OVER_CURSOR,
      GROK_COMMANDS,
      fakeDeps({ commandAvailable: async () => false })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('seat_provider_command_unavailable');
  });
});

describe('cursor grok model id', () => {
  // The id must be a named, overridable constant -- Cursor's roster moved
  // 4.3 -> 4.5 -> 4.6 inside two months, so a moved id is a config change.
  test('defaults to the live-verified id and is env-overridable', () => {
    expect(CURSOR_GROK_MODEL).toBeTruthy();
    expect(defaultAgentConfigs['grok-via-cursor']?.args).toContain(CURSOR_GROK_MODEL);
  });

  test('the transport passes no --mode flag (both choices are read-only)', () => {
    expect(defaultAgentConfigs['grok-via-cursor']?.args).not.toContain('--mode');
  });

  test('the transport passes --force and --trust', () => {
    const args = defaultAgentConfigs['grok-via-cursor']?.args ?? [];
    expect(args).toContain('--force');
    expect(args).toContain('--trust');
  });
});

describe('cursor empty-output guard', () => {
  // Scenario 3 (validation -- empty output): cursor-agent exits 0 with no
  // output when workspace trust is not granted. rc 0 is therefore NOT proof of
  // work; an empty result must be recorded FAILED, never a silent success.
  test('treats empty cursor-agent output as a failed attempt', () => {
    expect(cursorBuildResultIsEmpty('')).toBe(true);
    expect(cursorBuildResultIsEmpty('   \n  \t ')).toBe(true);
  });

  test('treats real output as a completed attempt', () => {
    expect(cursorBuildResultIsEmpty('SEAT_OK')).toBe(false);
  });
});

describe('cursor ladder tier ships dark', () => {
  // Scenario 4 (edge -- ladder dark): asserted against the REAL config file,
  // not a fixture, so the shipped artifact is what is under test.
  test('cursor tier exists and is bound to its own workflow', () => {
    const tier = ladderConfig.tiers.find(t => t.name === 'cursor');
    expect(tier).toBeDefined();
    expect(tier?.workflowName).toBe('bdc-feature-development-cursor');
    expect(tier?.isFrontier).toBe(false);
  });

  test('cursor tier is REFUSED so live cascade behavior is unchanged', () => {
    expect(ladderConfig.refusedTiers).toContain('cursor');
  });

  test('cursor sits below codex in the ladder order', () => {
    const names = ladderConfig.tiers.map(t => t.name);
    expect(names.indexOf('cursor')).toBeLessThan(names.indexOf('codex'));
  });

  // The pre-existing entry floor must not regress: codex remains the first
  // non-refused tier while cursor is dark.
  test('entry floor remains codex while cursor is refused', () => {
    const firstLive = ladderConfig.tiers.find(t => !ladderConfig.refusedTiers.includes(t.name));
    expect(firstLive?.name).toBe('codex');
  });
});
