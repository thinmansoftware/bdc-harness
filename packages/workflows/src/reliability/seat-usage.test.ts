import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CreateAuthenticatedMessageData } from '@archon/core/db/dispatch';
import {
  alertUnknownSeat,
  decideSeatGate,
  DEFAULT_SEAT_CUTOFF_PERCENT,
  getSeatCutoff,
  readAllSeats,
  readSeat,
  resetSeatUsageCacheForTests,
  seatsForBindings,
  setSeatAlertSendForTests,
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
let alerts: Array<{ sender: string; data: CreateAuthenticatedMessageData }> = [];

beforeEach(() => {
  resetSeatUsageCacheForTests();
  logs = [];
  alerts = [];
  setSeatUsageLogForTests((obj, msg) => {
    logs.push({ obj, msg });
  });
  setSeatAlertSendForTests(async (context, data) => {
    alerts.push({ sender: context.sender, data });
    return null;
  });
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
});

afterEach(() => {
  resetSeatUsageCacheForTests();
  delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
});

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function claudeDeps(fetchImpl: typeof fetch): Promise<{
  claudeCredentialsFile: string;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}> {
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

async function codexDeps(fetchImpl: typeof fetch): Promise<{
  codexAuthFile: string;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}> {
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
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 604800,
                reset_at: 1790514812,
              },
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
    const claude = measured('claude', [
      { name: 'seven_day', used_percent: 41, remaining_percent: 59, resets_at: 'x' },
    ]);
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

  test('default_cutoff_is_90_with_no_env_and_no_override', () => {
    expect(DEFAULT_SEAT_CUTOFF_PERCENT).toBe(90);
    expect(process.env.FUELGLASS_SEAT_CUTOFF_PERCENT).toBeUndefined();
    expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '   ';
    expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
    expect(logs.filter(entry => entry.msg === 'fuelglass.seat_cutoff_env_invalid')).toHaveLength(0);
  });

  test('invalid_env_falls_back_to_90_and_logs_once', () => {
    for (const raw of ['abc', '0', '96', '100', '-5', 'NaN']) {
      process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = raw;
      expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
    }
    const invalidLogs = logs.filter(entry => entry.msg === 'fuelglass.seat_cutoff_env_invalid');
    expect(invalidLogs).toHaveLength(1);
    expect(invalidLogs[0]?.obj).toEqual({ raw: 'abc' });
  });

  test('cutoff_resolution_order', () => {
    expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '95';
    expect(getSeatCutoff()).toEqual({ percent: 95, source: 'env' });
    process.env.FUELGLASS_SEAT_CUTOFF_PERCENT = '1';
    expect(getSeatCutoff()).toEqual({ percent: 1, source: 'env' });
    setSeatCutoffOverride(80);
    expect(getSeatCutoff()).toEqual({ percent: 80, source: 'operator' });
    setSeatCutoffOverride(null);
    expect(getSeatCutoff()).toEqual({ percent: 1, source: 'env' });
    delete process.env.FUELGLASS_SEAT_CUTOFF_PERCENT;
    expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
  });

  test('override_outside_1_to_95_is_rejected_with_a_named_error', () => {
    for (const bad of [96, 100, 0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        setSeatCutoffOverride(bad);
      }).toThrow('seat_cutoff_out_of_range');
    }
    expect(getSeatCutoff()).toEqual({ percent: 90, source: 'default' });
    setSeatCutoffOverride(95);
    expect(getSeatCutoff()).toEqual({ percent: 95, source: 'operator' });
    setSeatCutoffOverride(1);
    expect(getSeatCutoff()).toEqual({ percent: 1, source: 'operator' });
  });

  test('default_cutoff_refuses_seat_at_91_and_names_it', () => {
    const claude = measured('claude', [
      { name: 'seven_day', used_percent: 91, remaining_percent: 9, resets_at: 'x' },
    ]);
    const decision = decideSeatGate(
      [{ providerId: 'claude' }],
      { claude },
      getSeatCutoff().percent
    );
    expect(decision).toEqual({
      refused: true,
      seat: 'claude',
      window: 'seven_day',
      usedPercent: 91,
      cutoffPercent: 90,
    });
  });

  test('default_cutoff_lets_seat_at_89_proceed', () => {
    const codex = measured('codex', [
      {
        name: 'primary',
        used_percent: 89,
        remaining_percent: 11,
        resets_at: 'x',
        window_seconds: 604800,
      },
    ]);
    const decision = decideSeatGate([{ providerId: 'codex' }], { codex }, getSeatCutoff().percent);
    expect(decision).toEqual({ refused: false, unknownSeats: [] });
  });

  test('unknown_seat_alerts_operator_once_per_seat_per_hour', async () => {
    const hour = Date.UTC(2026, 8, 24, 10, 5, 0);
    const sent = await alertUnknownSeat('claude', 'Claude limit probe rejected (HTTP 401)', {
      workflowName: 'wf',
      workflowRunId: 'run-1',
      now: hour,
    });
    expect(sent).toBe(true);
    expect(alerts).toHaveLength(1);
    const first = alerts[0];
    expect(first?.sender).toBe('dispatch');
    expect(first?.data.recipient).toBe('operator');
    expect(first?.data.task_type).toBe('agent_message');
    expect(first?.data.idempotency_key).toBe('fuelglass-seat-unknown:claude:2026-09-24T10');
    expect(first?.data.correlation_id).toBe('fuelglass-seat-unknown:claude:2026-09-24T10');
    const body = first?.data.body ?? '';
    expect(body.split('\n')[0]).toBe('Fuelglass seat gate could not measure seat claude');
    expect(body).toContain('Claude limit probe rejected (HTTP 401)');
    expect(body).toContain('could not measure');
    expect(body).toContain('run-1');

    // Same seat, same hour: nothing more.
    expect(await alertUnknownSeat('claude', 'again', { now: hour + 50 * 60 * 1000 })).toBe(false);
    expect(alerts).toHaveLength(1);

    // A different seat in the same hour gets its own alert.
    expect(await alertUnknownSeat('cursor', 'no Cursor session credential', { now: hour })).toBe(
      true
    );
    expect(alerts).toHaveLength(2);
    expect(alerts[1]?.data.idempotency_key).toBe('fuelglass-seat-unknown:cursor:2026-09-24T10');

    // The next hour alerts again for the first seat.
    expect(await alertUnknownSeat('claude', 'still down', { now: hour + 60 * 60 * 1000 })).toBe(
      true
    );
    expect(alerts).toHaveLength(3);
    expect(alerts[2]?.data.idempotency_key).toBe('fuelglass-seat-unknown:claude:2026-09-24T11');
  });

  test('unknown_alert_key_is_stable_across_a_restart_in_the_same_hour', async () => {
    const at = Date.UTC(2026, 8, 24, 10, 1, 0);
    await alertUnknownSeat('codex', 'Codex limit probe failed', { now: at });
    // Simulate a process restart: the in-memory marker is gone.
    resetSeatUsageCacheForTests();
    setSeatAlertSendForTests(async (context, data) => {
      alerts.push({ sender: context.sender, data });
      return null;
    });
    await alertUnknownSeat('codex', 'Codex limit probe failed', { now: at + 30 * 60 * 1000 });
    expect(alerts).toHaveLength(2);
    // Dispatch dedupes on this key, so the second enqueue returns the first message.
    expect(alerts[1]?.data.idempotency_key).toBe(alerts[0]?.data.idempotency_key ?? '');
    expect(alerts[0]?.data.idempotency_key).toBe('fuelglass-seat-unknown:codex:2026-09-24T10');
  });

  test('unknown_alert_failure_is_logged_and_retried', async () => {
    const at = Date.UTC(2026, 8, 24, 12, 0, 0);
    let attempts = 0;
    setSeatAlertSendForTests(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('db down');
      return null;
    });
    expect(await alertUnknownSeat('claude', 'n', { now: at })).toBe(false);
    expect(
      logs.filter(entry => entry.msg === 'fuelglass.seat_unknown_alert_failed').map(e => e.obj)
    ).toEqual([{ seat: 'claude', error: 'db down' }]);
    expect(await alertUnknownSeat('claude', 'n', { now: at + 1000 })).toBe(true);
    expect(attempts).toBe(2);
  });

  test('gate_has_no_off_switch_anywhere', async () => {
    // Built by concatenation so this file does not itself contain the name.
    const removed = ['FUELGLASS', 'SEAT', 'GATE'].join('_');
    const root = join(import.meta.dir, '..', '..', '..', '..');
    const files = [
      'packages/workflows/src/reliability/seat-usage.ts',
      'packages/workflows/src/reliability/seat-usage.test.ts',
      'packages/workflows/src/reliability/seat-gate-executor.test.ts',
      'packages/workflows/src/executor.ts',
      'packages/server/src/routes/api.ts',
      'packages/server/src/routes/api.fuelglass-seats.test.ts',
      'packages/server/src/routes/schemas/fuelglass.schemas.ts',
      'docs/fuelglass-seat-gate.md',
    ];
    for (const file of files) {
      const text = await readFile(join(root, file), 'utf8');
      expect(text.length).toBeGreaterThan(0);
      expect({ file, found: text.includes(removed) }).toEqual({ file, found: false });
    }
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
            primary_window: {
              used_percent: 92,
              limit_window_seconds: 604800,
              reset_at: 1790514812,
            },
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
      [
        {
          name: 'primary',
          used_percent: 70,
          remaining_percent: 30,
          resets_at: 'x',
          window_seconds: 604800,
        },
      ],
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
