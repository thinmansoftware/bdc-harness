import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  decideSeatGate,
  getSeatCutoff,
  readAllSeats,
  readSeat,
  resetSeatUsageCacheForTests,
  seatsForBindings,
  setSeatCutoffOverride,
  setSeatUsageLogForTests,
  unknownSeatReading,
  type SeatReading,
} from './seat-usage';

const SECRET_MARKERS = [
  'tok-claude-FIXTURE',
  'tok-codex-FIXTURE',
  'acct-FIXTURE',
  'user_FIXTURE',
  'a.b.c',
];

let logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];

beforeEach(() => {
  resetSeatUsageCacheForTests();
  logs = [];
  setSeatUsageLogForTests((obj, msg) => {
    logs.push({ obj, msg });
  });
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  delete process.env.FUELGLASS_SEAT_GATE;
});

afterEach(() => {
  resetSeatUsageCacheForTests();
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
  delete process.env.FUELGLASS_SEAT_GATE;
});

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function claudeDeps(
  fetchImpl: typeof fetch
): Promise<{ claudeCredentialsFile: string; fetch: typeof fetch; env: Record<string, string | undefined> }> {
  const dir = await mkdtemp(join(tmpdir(), 'seat-claude-'));
  const claudeCredentialsFile = join(dir, 'credentials.json');
  await writeFile(
    claudeCredentialsFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok-claude-FIXTURE',
        expiresAt: Date.now() + 60_000,
        subscriptionType: 'max',
      },
    })
  );
  return { claudeCredentialsFile, fetch: fetchImpl, env: {} };
}

async function codexDeps(
  fetchImpl: typeof fetch
): Promise<{ codexAuthFile: string; fetch: typeof fetch; env: Record<string, string | undefined> }> {
  const dir = await mkdtemp(join(tmpdir(), 'seat-codex-'));
  const codexAuthFile = join(dir, 'auth.json');
  await writeFile(
    codexAuthFile,
    JSON.stringify({
      tokens: { access_token: 'tok-codex-FIXTURE', account_id: 'acct-FIXTURE' },
    })
  );
  return { codexAuthFile, fetch: fetchImpl, env: {} };
}

describe('seat usage', () => {
  test('claude_measured_seven_day', async () => {
    let url = '';
    let beta = '';
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input);
      const headers = init?.headers as Record<string, string>;
      beta = headers['anthropic-beta'] ?? '';
      return jsonResponse(
        200,
        JSON.stringify({
          five_hour: { utilization: 44, resets_at: '2026-09-24T10:29:59Z' },
          seven_day: { utilization: 41, resets_at: '2026-09-28T02:59:59Z' },
          nimbus_quill: { utilization: 0 },
        })
      );
    };
    const reading = await readSeat('claude', await claudeDeps(fetchImpl));
    expect(reading.limit_source).toBe('measured');
    expect(reading.seven_day).toEqual({
      used_percent: 41,
      remaining_percent: 59,
      resets_at: '2026-09-28T02:59:59Z',
    });
    const five = reading.windows.find(w => w.name === 'five_hour');
    expect(five?.used_percent).toBe(44);
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(beta).toBe('oauth-2025-04-20');
    expect(JSON.stringify(reading)).not.toContain('tok-claude-FIXTURE');
  });

  test('codex_measured_seven_day_from_primary', async () => {
    let account = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      account = headers['chatgpt-account-id'] ?? '';
      return jsonResponse(
        200,
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 92,
              limit_window_seconds: 604800,
              reset_at: 1790514812,
            },
          },
        })
      );
    };
    const reading = await readSeat('codex', await codexDeps(fetchImpl));
    expect(reading.seven_day).toMatchObject({ used_percent: 92 });
    expect(reading.windows[0]?.name).toBe('primary');
    expect(reading.windows[0]?.window_seconds).toBe(604800);
    expect(account).toBe('acct-FIXTURE');
    expect(JSON.stringify(reading)).not.toContain('tok-codex-FIXTURE');
    expect(JSON.stringify(reading)).not.toContain('acct-FIXTURE');
  });

  test('cursor_env_token_monthly_window', async () => {
    let cookie = '';
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      cookie = headers.Cookie ?? '';
      return jsonResponse(
        200,
        JSON.stringify({
          membershipType: 'ultra',
          billingCycleEnd: '2026-10-13T00:00:00Z',
          individualUsage: { plan: { used: 13, limit: 100 } },
        })
      );
    };
    const reading = await readSeat('cursor', {
      fetch: fetchImpl,
      env: { FUELGLASS_CURSOR_SESSION_TOKEN: 'user_FIXTURE%3A%3Aa.b.c' },
    });
    expect(reading.limit_source).toBe('measured');
    expect(reading.windows[0]).toMatchObject({ name: 'monthly', used_percent: 13 });
    expect(reading.seven_day).toBe('NOT_APPLICABLE');
    expect(cookie.startsWith('WorkosCursorSessionToken=')).toBe(true);
    expect(JSON.stringify(reading)).not.toContain('user_FIXTURE');
    expect(JSON.stringify(reading)).not.toContain('a.b.c');
  });

  test('cursor_no_credential_is_unknown_without_fetch', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200, '{}');
    };
    const reading = await readSeat('cursor', { fetch: fetchImpl, env: {} });
    expect(reading.limit_source).toBe('UNKNOWN');
    expect(reading.note.toLowerCase()).toContain('credential');
    expect(calls).toBe(0);
    expect(typeof reading.seven_day).toBe('string');
  });

  test('claude_401_is_unknown_never_zero', async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(401, JSON.stringify({ error: { message: 'OAuth access token has expired' } }));
    const reading = await readSeat('claude', await claudeDeps(fetchImpl));
    expect(reading.limit_source).toBe('UNKNOWN');
    expect(reading.seven_day).toBe('UNKNOWN');
    expect(reading.windows.every(w => w.used_percent !== 0 && w.used_percent !== 100)).toBe(true);
    expect(reading.windows).toHaveLength(0);
  });

  test('cache_and_single_flight', async () => {
    let calls = 0;
    let failClaude = false;
    const fetchImpl: typeof fetch = async input => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
      const url = String(input);
      if (url.includes('anthropic')) {
        if (failClaude) return jsonResponse(401, '{}');
        return jsonResponse(
          200,
          JSON.stringify({ seven_day: { utilization: 10, resets_at: '2026-09-28T00:00:00Z' } })
        );
      }
      if (url.includes('chatgpt')) {
        return jsonResponse(
          200,
          JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1790514812 },
            },
          })
        );
      }
      return jsonResponse(
        200,
        JSON.stringify({
          membershipType: 'ultra',
          billingCycleEnd: '2026-10-13T00:00:00Z',
          individualUsage: { plan: { used: 1, limit: 100 } },
        })
      );
    };
    const dir = await mkdtemp(join(tmpdir(), 'seat-cache-'));
    const claudeCredentialsFile = join(dir, 'credentials.json');
    const codexAuthFile = join(dir, 'auth.json');
    await writeFile(
      claudeCredentialsFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok-claude-FIXTURE',
          expiresAt: Date.now() + 60_000,
          subscriptionType: 'max',
        },
      })
    );
    await writeFile(
      codexAuthFile,
      JSON.stringify({ tokens: { access_token: 'tok-codex-FIXTURE', account_id: 'acct-FIXTURE' } })
    );
    let clock = 0;
    const deps = {
      fetch: fetchImpl,
      now: () => clock,
      claudeCredentialsFile,
      codexAuthFile,
      env: { FUELGLASS_CURSOR_SESSION_TOKEN: 'user_FIXTURE%3A%3Aa.b.c' },
    };
    await Promise.all(Array.from({ length: 10 }, () => readAllSeats(deps)));
    const afterBurst = calls;
    expect(afterBurst).toBe(3);
    clock = 30_000;
    await readAllSeats(deps);
    expect(calls).toBe(afterBurst);
    clock = 56_000;
    await readAllSeats(deps);
    expect(calls).toBe(afterBurst + 3);

    resetSeatUsageCacheForTests();
    setSeatUsageLogForTests((obj, msg) => {
      logs.push({ obj, msg });
    });
    failClaude = true;
    clock = 0;
    let claudeCalls = 0;
    const failing: typeof fetch = async input => {
      if (String(input).includes('anthropic')) claudeCalls += 1;
      return jsonResponse(401, '{}');
    };
    const unknownDeps = {
      fetch: failing,
      now: () => clock,
      claudeCredentialsFile,
      env: {},
    };
    const first = await readSeat('claude', unknownDeps);
    const second = await readSeat('claude', unknownDeps);
    expect(first.limit_source).toBe('UNKNOWN');
    expect(second.limit_source).toBe('UNKNOWN');
    expect(claudeCalls).toBe(1);
    clock = 56_000;
    await readSeat('claude', unknownDeps);
    expect(claudeCalls).toBe(2);
  });

  test('gate_refuses_maxed_seat_and_names_it', () => {
    const claude = measured('claude', [{ name: 'seven_day', used_percent: 41, remaining_percent: 59, resets_at: 'x' }]);
    const codex = measured('codex', [
      {
        name: 'primary',
        used_percent: 92,
        remaining_percent: 8,
        resets_at: 'x',
        window_seconds: 604800,
      },
    ]);
    const decision = decideSeatGate(
      [{ providerId: 'claude' }, { providerId: 'codex' }],
      { claude, codex },
      90
    );
    expect(decision).toEqual({
      refused: true,
      seat: 'codex',
      window: 'primary',
      usedPercent: 92,
      cutoffPercent: 90,
    });
  });

  test('gate_allows_on_unknown', () => {
    const decision = decideSeatGate(
      [{ providerId: 'claude' }],
      { claude: unknownSeatReading('claude', 'probe failed') },
      1
    );
    expect(decision).toEqual({ refused: false, unknownSeats: ['claude'] });
  });

  test('non_seat_providers_ignored', () => {
    const bindings = [
      { providerId: 'opr-zero' },
      { providerId: 'grok' },
      { providerId: 'codex-opr' },
    ];
    expect(seatsForBindings(bindings)).toEqual([]);
    const decision = decideSeatGate(bindings, {}, 1);
    expect(decision).toEqual({ refused: false, unknownSeats: [] });
  });

  test('cutoff_resolution_order', () => {
    expect(getSeatCutoff()).toEqual({ percent: 100, source: 'default' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '95';
    expect(getSeatCutoff()).toEqual({ percent: 95, source: 'env' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = 'abc';
    expect(getSeatCutoff()).toEqual({ percent: 100, source: 'default' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '0';
    expect(getSeatCutoff()).toEqual({ percent: 100, source: 'default' });
    const invalidLogs = logs.filter(entry => entry.msg === 'fuelglass.seat_cutoff_env_invalid');
    expect(invalidLogs).toHaveLength(1);
    setSeatCutoffOverride(80);
    expect(getSeatCutoff()).toEqual({ percent: 80, source: 'operator' });
    setSeatCutoffOverride(null);
    expect(getSeatCutoff()).toEqual({ percent: 100, source: 'default' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '95';
    expect(getSeatCutoff()).toEqual({ percent: 95, source: 'env' });
  });

  test('no_credential_leak', async () => {
    const claudeFetch: typeof fetch = async () =>
      jsonResponse(
        200,
        JSON.stringify({
          five_hour: { utilization: 44, resets_at: '2026-09-24T10:29:59Z' },
          seven_day: { utilization: 41, resets_at: '2026-09-28T02:59:59Z' },
        })
      );
    const claude401: typeof fetch = async () => jsonResponse(401, '{}');
    const codexFetch: typeof fetch = async () =>
      jsonResponse(
        200,
        JSON.stringify({
          plan_type: 'pro',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 92, limit_window_seconds: 604800, reset_at: 1790514812 },
          },
        })
      );
    const cursorFetch: typeof fetch = async () =>
      jsonResponse(
        200,
        JSON.stringify({
          membershipType: 'ultra',
          billingCycleEnd: '2026-10-13T00:00:00Z',
          individualUsage: { plan: { used: 13, limit: 100 } },
        })
      );
    const readings = [
      await readSeat('claude', await claudeDeps(claudeFetch)),
      await readSeat('codex', await codexDeps(codexFetch)),
      await readSeat('cursor', {
        fetch: cursorFetch,
        env: { FUELGLASS_CURSOR_SESSION_TOKEN: 'user_FIXTURE%3A%3Aa.b.c' },
      }),
    ];
    resetSeatUsageCacheForTests();
    setSeatUsageLogForTests((obj, msg) => {
      logs.push({ obj, msg });
    });
    readings.push(await readSeat('claude', await claudeDeps(claude401)));
    const gate = decideSeatGate([{ providerId: 'claude' }], { claude: readings[0] }, 100);
    const blob = JSON.stringify({ readings, gate, logs });
    for (const marker of SECRET_MARKERS) {
      expect(blob).not.toContain(marker);
    }
  });

  test('codex_limit_reached_refuses_below_cutoff', () => {
    const codex = measured(
      'codex',
      [{ name: 'primary', used_percent: 70, remaining_percent: 30, resets_at: 'x', window_seconds: 604800 }],
      { limit_reached: true }
    );
    const decision = decideSeatGate([{ providerId: 'codex' }], { codex }, 100);
    expect(decision.refused).toBe(true);
    if (decision.refused) expect(decision.seat).toBe('codex');
  });
});

function measured(
  seat: SeatReading['seat'],
  windows: SeatReading['windows'],
  extra: { limit_reached?: boolean } = {}
): SeatReading {
  return {
    seat,
    limit_source: 'measured',
    windows,
    seven_day: 'UNKNOWN',
    gate_windows: [],
    note: '',
    probed_at: '2026-09-24T00:00:00Z',
    endpoint: 'https://example.invalid',
    ...extra,
  };
}
