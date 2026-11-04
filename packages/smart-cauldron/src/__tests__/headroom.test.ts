import { describe, expect, test } from 'bun:test';
import { loadRuleset, pickEntryTier } from '../conductor.js';
import {
  admitClaudeTier,
  bindingUsedPercent,
  chooseHeadroomEntry,
  resolveEntryThreshold,
  rungSeatSkip,
  seatForTier,
  type SeatReadingLike,
  type SeatUsageSnapshot,
} from '../headroom.js';
import { loadLadder, loadPremiumTiers, loadRefusedTiers } from '../ladder.js';
import { extractNodeModels } from '../poll.js';

const CANONICAL_LADDER = [
  { name: 'zero' },
  { name: 'qwen' },
  { name: 'cursor' },
  { name: 'codex' },
  { name: 'claude' },
  { name: 'frontier' },
];
const REFUSED = ['glm', 'zero', 'qwen', 'cursor'];
const PREMIUM = ['frontier'];

function measured(
  windows: { name: string; used_percent: number }[],
  limitReached = false
): SeatReadingLike {
  return {
    limit_source: 'measured',
    windows,
    ...(limitReached ? { limit_reached: true } : {}),
  };
}

function choose(input: {
  picked: string;
  usage: SeatUsageSnapshot | null;
  thresholdPercent?: number;
  pinned?: boolean;
  tiers?: { name: string }[];
  refusedTiers?: string[];
  premiumTiers?: string[];
}) {
  return chooseHeadroomEntry({
    picked: input.picked,
    tiers: input.tiers ?? CANONICAL_LADDER,
    refusedTiers: input.refusedTiers ?? REFUSED,
    premiumTiers: input.premiumTiers ?? PREMIUM,
    usage: input.usage,
    thresholdPercent: input.thresholdPercent ?? 80,
    pinned: input.pinned ?? false,
  });
}

const HOT_CODEX_COOL_CLAUDE: SeatUsageSnapshot = {
  codex: measured([
    { name: 'primary', used_percent: 83 },
    { name: 'secondary', used_percent: 40 },
  ]),
  claude: measured([
    { name: 'five_hour', used_percent: 11 },
    { name: 'seven_day', used_percent: 45 },
  ]),
};

describe('entry headroom', () => {
  test('claude-tier-admission-distinguishes-measured-over-and-unknown', () => {
    expect(
      admitClaudeTier({
        usage: {
          claude: measured([
            { name: 'seven_day', used_percent: 41 },
            { name: 'five_hour', used_percent: 62 },
          ]),
        },
        thresholdPercent: 80,
      })
    ).toEqual({ admitted: true, reason: 'claude_seat_ok:62:80' });
    expect(
      admitClaudeTier({
        usage: { claude: measured([{ name: 'seven_day', used_percent: 80 }]) },
        thresholdPercent: 80,
      })
    ).toEqual({ admitted: false, reason: 'claude_seat_over_threshold:80:80' });
    expect(
      admitClaudeTier({
        usage: { claude: { limit_source: 'UNKNOWN', windows: [] } },
        thresholdPercent: 80,
      })
    ).toEqual({ admitted: false, reason: 'claude_seat_unknown' });
  });

  test('over-threshold-entry-moves-up', () => {
    expect(seatForTier('codex')).toBe('codex');
    expect(seatForTier('claude')).toBe('claude');
    expect(seatForTier('frontier')).toBe('claude');
    expect(seatForTier('cursor')).toBe('cursor');
    expect(seatForTier('zero')).toBeNull();
    expect(seatForTier('qwen')).toBeNull();
    expect(seatForTier('glm')).toBeNull();
    expect(seatForTier('Codex')).toBeNull();

    const result = choose({ picked: 'codex', usage: HOT_CODEX_COOL_CLAUDE });
    expect(result.entry).toBe('claude');
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('seat_over_threshold:codex:83');
    expect(result.seats).toEqual({ codex: 83, claude: 45 });
  });

  test('pinned-entry-never-moved', () => {
    const result = choose({ picked: 'codex', usage: HOT_CODEX_COOL_CLAUDE, pinned: true });
    expect(result.entry).toBe('codex');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('pinned');
    expect(result.seats).toEqual({ codex: 83, claude: 45 });
  });

  test('healthy-and-unknown-seats-do-not-move-entry', () => {
    const below = choose({
      picked: 'codex',
      usage: { codex: measured([{ name: 'primary', used_percent: 60 }]) },
    });
    expect(below.entry).toBe('codex');
    expect(below.changed).toBe(false);
    expect(below.reason).toBe('seat_ok:codex:60');

    const unknownSeat = choose({
      picked: 'codex',
      usage: {
        codex: {
          limit_source: 'UNKNOWN',
          windows: [{ name: 'primary', used_percent: 99 }],
        },
      },
    });
    expect(unknownSeat.entry).toBe('codex');
    expect(unknownSeat.changed).toBe(false);
    expect(unknownSeat.reason).toBe('seat_unknown:codex');

    const unavailable = choose({ picked: 'codex', usage: null });
    expect(unavailable.entry).toBe('codex');
    expect(unavailable.changed).toBe(false);
    expect(unavailable.reason).toBe('seat_usage_unavailable');
    expect(unavailable.seats).toEqual({});

    const missing = choose({
      picked: 'codex',
      usage: { claude: measured([{ name: 'five_hour', used_percent: 10 }]) },
    });
    expect(missing.entry).toBe('codex');
    expect(missing.changed).toBe(false);
    expect(missing.reason).toBe('seat_unknown:codex');
  });

  test('binding-window-is-the-most-consumed', () => {
    const claude = measured([
      { name: 'five_hour', used_percent: 11 },
      { name: 'seven_day', used_percent: 89 },
    ]);
    const codex = measured([{ name: 'primary', used_percent: 10 }], true);
    expect(bindingUsedPercent(claude)).toBe(89);
    expect(bindingUsedPercent(codex)).toBe(100);

    const result = choose({
      picked: 'codex',
      usage: {
        codex: measured([
          { name: 'primary', used_percent: 83 },
          { name: 'secondary', used_percent: 40 },
        ]),
        claude,
      },
    });
    expect(result.entry).toBe('codex');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('no_known_headroom:codex:83');
  });

  test('never-downgrade-and-never-premium', () => {
    const moneyPick = choose({
      picked: 'claude',
      usage: {
        claude: measured([{ name: 'seven_day', used_percent: 95 }]),
        codex: measured([{ name: 'primary', used_percent: 10 }]),
      },
    });
    expect(moneyPick.entry).toBe('claude');
    expect(moneyPick.changed).toBe(false);
    expect(moneyPick.reason).toBe('no_known_headroom:claude:95');

    const noLaterHeadroom = choose({
      picked: 'codex',
      usage: {
        codex: measured([{ name: 'primary', used_percent: 83 }]),
        claude: measured([{ name: 'seven_day', used_percent: 90 }]),
      },
    });
    expect(noLaterHeadroom.entry).toBe('codex');
    expect(noLaterHeadroom.changed).toBe(false);
    expect(noLaterHeadroom.reason).toBe('no_known_headroom:codex:83');
    expect(noLaterHeadroom.entry).not.toBe('frontier');
  });

  test('threshold-env-parsing', () => {
    const cases: Array<[Record<string, string | undefined>, number]> = [
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '85' }, 85],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '1' }, 1],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '99' }, 99],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '0' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '100' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '150' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: 'abc' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '' }, 80],
      [{}, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: ' 85' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '+85' }, 80],
      [{ SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT: '85.0' }, 80],
    ];
    for (const [env, expected] of cases) {
      const resolved = resolveEntryThreshold(env);
      expect(resolved).toBe(expected);
      expect(Number.isNaN(resolved)).toBe(false);
    }
  });

  test('real-config-parity', () => {
    const tiers = loadLadder().map(tier => ({ name: tier.name }));
    const refusedTiers = loadRefusedTiers();
    const premiumTiers = loadPremiumTiers();
    const ruleset = loadRuleset();
    const hotCursorCoolCodex: SeatUsageSnapshot = {
      cursor: { limit_source: 'measured', windows: [{ name: 'primary', used_percent: 83 }] },
      codex: { limit_source: 'measured', windows: [{ name: 'primary', used_percent: 11 }] },
    };

    // 2026-11-02 (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01): plain CODE now
    // picks zero. zero carries no paid seat, so seat-headroom must leave it
    // where it is -- a hot cursor seat must NOT push a zero-entry WO up a rung.
    const codePick = pickEntryTier({ woClass: 'CODE' }, ruleset);
    expect(codePick).toBe('zero');
    const zeroEntry = chooseHeadroomEntry({
      picked: codePick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: hotCursorCoolCodex,
      thresholdPercent: 80,
      pinned: false,
    });
    expect(zeroEntry.entry).toBe('zero');
    expect(zeroEntry.changed).toBe(false);
    expect(zeroEntry.reason).toBe('no_seat');

    // Seat-shift parity still has to hold for picks that land on a real seat.
    // feature-tagged CODE is the live rule that enters cursor.
    const cursorPick = pickEntryTier({ woClass: 'CODE', tags: ['feature'] }, ruleset);
    expect(cursorPick).toBe('cursor');
    const codeEntry = chooseHeadroomEntry({
      picked: cursorPick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: hotCursorCoolCodex,
      thresholdPercent: 80,
      pinned: false,
    });
    expect(codeEntry.entry).toBe('codex');
    expect(codeEntry.changed).toBe(true);
    expect(codeEntry.reason).toBe('seat_over_threshold:cursor:83');
    const coolCursor = chooseHeadroomEntry({
      picked: cursorPick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: {
        cursor: { limit_source: 'measured', windows: [{ name: 'primary', used_percent: 20 }] },
      },
      thresholdPercent: 80,
      pinned: false,
    });
    expect(coolCursor.entry).toBe('cursor');
    expect(coolCursor.changed).toBe(false);

    const billingPick = pickEntryTier({ woClass: 'CODE', tags: ['billing'] }, ruleset);
    expect(billingPick).toBe('cursor');
    const billingEntry = chooseHeadroomEntry({
      picked: billingPick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: {
        cursor: { limit_source: 'measured', windows: [{ name: 'primary', used_percent: 20 }] },
      },
      thresholdPercent: 80,
      pinned: false,
    });
    expect(billingEntry.picked).toBe('cursor');
    expect(billingEntry.entry).toBe('cursor');
    expect(billingEntry.changed).toBe(false);
    expect(billingEntry.reason).toBe('seat_ok:cursor:20');
  });

  test('node-models-extracted-from-events', () => {
    const models = extractNodeModels([
      {
        event_type: 'node_completed',
        step_name: 'plan',
        data: {
          provider: 'claude',
          declared_model_id: 'sonnet',
          served_model_id: 'claude-sonnet-5',
        },
      },
      {
        event_type: 'node_failed',
        step_name: 'diff-review',
        data: {
          provider: 'codex',
          declared_model_id: 'gpt-5.6-sol',
        },
      },
      {
        event_type: 'node_completed',
        step_name: '',
        data: {
          provider: 'claude',
          declared_model_id: 'sonnet',
          served_model_id: 'should-not-appear',
        },
      },
      {
        event_type: 'node_started',
        step_name: 'implement',
        data: {
          provider: 'claude',
          declared_model_id: 'sonnet',
          served_model_id: 'claude-sonnet-5',
        },
      },
      {
        event_type: 'node_completed',
        step_name: 'plan',
        data: {
          provider: 'claude',
          declared_model_id: 'sonnet',
          served_model_id: 'claude-sonnet-5-later',
        },
      },
    ]);
    expect(Object.keys(models).sort()).toEqual(['diff-review', 'plan']);
    expect(models.plan).toEqual({
      provider: 'claude',
      declared: 'sonnet',
      served: 'claude-sonnet-5-later',
    });
    expect(models['diff-review']).toEqual({
      provider: 'codex',
      declared: 'gpt-5.6-sol',
      served: null,
    });
    expect(models.implement).toBeUndefined();
    for (const triple of Object.values(models)) {
      expect(triple.provider).not.toBe('');
      expect(triple.declared).not.toBe('');
      expect(triple.served).not.toBe('');
    }
  });

  test('unknown-destination-seat-is-never-a-promotion-target', () => {
    const codexHot = measured([{ name: 'primary', used_percent: 83 }]);
    const unknownClaude: SeatReadingLike = {
      limit_source: 'UNKNOWN',
      windows: [{ name: 'five_hour', used_percent: 11 }],
    };
    const base = {
      picked: 'codex',
      tiers: CANONICAL_LADDER,
      refusedTiers: REFUSED,
      premiumTiers: PREMIUM,
      thresholdPercent: 80,
      pinned: false,
    };

    const unknownReading = chooseHeadroomEntry({
      ...base,
      usage: { codex: codexHot, claude: unknownClaude },
    });
    expect(unknownReading.entry).toBe('codex');
    expect(unknownReading.changed).toBe(false);
    expect(unknownReading.reason).toBe('no_known_headroom:codex:83');
    expect(unknownReading.seats.claude).toBe('UNKNOWN');
    expect(unknownReading.seats.codex).toBe(83);

    const absent = chooseHeadroomEntry({
      ...base,
      usage: { codex: codexHot },
    });
    expect(absent.entry).toBe('codex');
    expect(absent.changed).toBe(false);
    expect(absent.reason).toBe('no_known_headroom:codex:83');
    expect(absent.seats.claude).toBe('UNKNOWN');

    const noWindows = chooseHeadroomEntry({
      ...base,
      usage: { codex: codexHot, claude: measured([]) },
    });
    expect(noWindows.entry).toBe('codex');
    expect(noWindows.changed).toBe(false);
    expect(noWindows.reason).toBe('no_known_headroom:codex:83');
    expect(noWindows.seats.claude).toBe('UNKNOWN');

    const synthetic = chooseHeadroomEntry({
      picked: 'codex',
      tiers: [{ name: 'codex' }, { name: 'claude' }, { name: 'cursor' }],
      refusedTiers: [],
      premiumTiers: [],
      usage: {
        codex: codexHot,
        claude: unknownClaude,
        cursor: measured([{ name: 'primary', used_percent: 20 }]),
      },
      thresholdPercent: 80,
      pinned: false,
    });
    expect(synthetic.entry).toBe('cursor');
    expect(synthetic.changed).toBe(true);
    expect(synthetic.reason).toBe('seat_over_threshold:codex:83');
    expect(synthetic.seats).toEqual({ codex: 83, claude: 'UNKNOWN', cursor: 20 });
  });
});

describe('entry headroom: codex credits and unmetered cursor', () => {
  const LIVE_LADDER = [
    { name: 'zero' },
    { name: 'qwen' },
    { name: 'cursor' },
    { name: 'codex' },
    { name: 'claude' },
    { name: 'frontier' },
  ];
  const LIVE_REFUSED = ['glm', 'qwen'];
  const coolClaude = measured([{ name: 'seven_day', used_percent: 45 }]);
  const codexAt99 = (credits?: SeatReadingLike['credits']): SeatReadingLike => ({
    limit_source: 'measured',
    windows: [
      { name: 'primary', used_percent: 10 },
      { name: 'secondary', used_percent: 99 },
    ],
    ...(credits ? { credits } : {}),
  });
  const cursorUnknown: SeatReadingLike = { limit_source: 'UNKNOWN', windows: [] };

  test('codex_99_with_credits_keeps_codex_entry', () => {
    const result = choose({
      picked: 'codex',
      usage: { codex: codexAt99({ has_credits: true }), claude: coolClaude },
    });
    expect(result.entry).toBe('codex');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('seat_credits:codex:99');
    expect(result.seats).toEqual({ codex: 99, claude: 45 });
  });

  test('codex_99_without_credits_still_steers_away', () => {
    const noCredits = choose({
      picked: 'codex',
      usage: { codex: codexAt99(), claude: coolClaude },
    });
    expect(noCredits.entry).toBe('claude');
    expect(noCredits.changed).toBe(true);
    expect(noCredits.reason).toBe('seat_over_threshold:codex:99');

    const zeroCredits = choose({
      picked: 'codex',
      usage: { codex: codexAt99({ has_credits: false }), claude: coolClaude },
    });
    expect(zeroCredits.entry).toBe('claude');
    expect(zeroCredits.changed).toBe(true);
    expect(zeroCredits.reason).toBe('seat_over_threshold:codex:99');
  });

  test('codex_credits_overage_blocked_steers_away', () => {
    const result = choose({
      picked: 'codex',
      usage: {
        codex: codexAt99({ has_credits: true, overage_limit_reached: true }),
        claude: coolClaude,
      },
    });
    expect(result.entry).toBe('claude');
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('seat_over_threshold:codex:99');
  });

  test('cursor_unknown_is_headroom_destination', () => {
    const result = choose({
      picked: 'codex',
      tiers: [{ name: 'codex' }, { name: 'claude' }, { name: 'cursor' }],
      refusedTiers: [],
      premiumTiers: [],
      usage: {
        codex: codexAt99(),
        claude: measured([{ name: 'seven_day', used_percent: 90 }]),
        cursor: cursorUnknown,
      },
    });
    expect(result.entry).toBe('cursor');
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('seat_over_threshold:codex:99');
    expect(result.seats).toEqual({ codex: 99, claude: 90, cursor: 'UNKNOWN' });
  });

  test('codex_credits_is_headroom_destination', () => {
    const result = choose({
      picked: 'cursor',
      tiers: LIVE_LADDER,
      refusedTiers: LIVE_REFUSED,
      usage: {
        cursor: measured([{ name: 'monthly', used_percent: 90 }]),
        codex: codexAt99({ has_credits: true }),
        claude: measured([{ name: 'seven_day', used_percent: 95 }]),
      },
    });
    expect(result.entry).toBe('codex');
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('seat_over_threshold:cursor:90');
  });

  test('cursor_unknown_pick_kept_unmetered', () => {
    const result = choose({
      picked: 'cursor',
      tiers: LIVE_LADDER,
      refusedTiers: LIVE_REFUSED,
      usage: { cursor: cursorUnknown, codex: codexAt99({ has_credits: true }), claude: coolClaude },
    });
    expect(result.entry).toBe('cursor');
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('seat_unmetered:cursor');

    // A missing cursor reading is not UNKNOWN-measured; it stays unknown.
    const missing = choose({
      picked: 'cursor',
      tiers: LIVE_LADDER,
      refusedTiers: LIVE_REFUSED,
      usage: { codex: codexAt99(), claude: coolClaude },
    });
    expect(missing.entry).toBe('cursor');
    expect(missing.changed).toBe(false);
    expect(missing.reason).toBe('seat_unknown:cursor');
  });

  test('claude_unknown_still_not_headroom', () => {
    const claudeUnknown: SeatReadingLike = {
      limit_source: 'UNKNOWN',
      windows: [{ name: 'five_hour', used_percent: 5 }],
    };
    const asDestination = choose({
      picked: 'codex',
      usage: { codex: codexAt99(), claude: claudeUnknown },
    });
    expect(asDestination.entry).toBe('codex');
    expect(asDestination.changed).toBe(false);
    expect(asDestination.reason).toBe('no_known_headroom:codex:99');

    const asPick = choose({ picked: 'claude', usage: { claude: claudeUnknown } });
    expect(asPick.entry).toBe('claude');
    expect(asPick.changed).toBe(false);
    expect(asPick.reason).toBe('seat_unknown:claude');

    expect(admitClaudeTier({ usage: { claude: claudeUnknown }, thresholdPercent: 80 })).toEqual({
      admitted: false,
      reason: 'claude_seat_unknown',
    });

    // An UNKNOWN codex seat is not unmetered either.
    const codexUnknown = choose({
      picked: 'codex',
      usage: { codex: { limit_source: 'UNKNOWN', windows: [] }, claude: coolClaude },
    });
    expect(codexUnknown.reason).toBe('seat_unknown:codex');
    expect(codexUnknown.entry).toBe('codex');
  });

  test('rungSeatSkip_unchanged_behavior', () => {
    expect(rungSeatSkip('codex', { codex: codexAt99({ has_credits: true }) }, 95)).toBeNull();
    expect(rungSeatSkip('codex', { codex: codexAt99() }, 95)).toEqual({
      tier: 'codex',
      seat: 'codex',
      usedPercent: 99,
      cutoffPercent: 95,
    });
    expect(
      rungSeatSkip(
        'codex',
        { codex: codexAt99({ has_credits: true, overage_limit_reached: true }) },
        95
      )
    ).toEqual({ tier: 'codex', seat: 'codex', usedPercent: 99, cutoffPercent: 95 });
    expect(rungSeatSkip('codex', { codex: codexAt99() }, null)).toBeNull();
    expect(rungSeatSkip('cursor', { cursor: cursorUnknown }, 95)).toBeNull();
    expect(
      rungSeatSkip('claude', { claude: measured([{ name: 'seven_day', used_percent: 97 }]) }, 95)
    ).toEqual({ tier: 'claude', seat: 'claude', usedPercent: 97, cutoffPercent: 95 });
    expect(rungSeatSkip('zero', { codex: codexAt99() }, 95)).toBeNull();
  });
});

/**
 * WO-HARNESS-CODEX-CREDITS-HEADROOM-WHEN-WINDOW-EXHAUSTED-01: the conductor
 * agrees with the run-start seat gate when Fuelglass reports codex at 100 with
 * limit_reached true and allowed false while credits are available.
 */
describe('entry headroom: codex at limit with credits (allowed=false)', () => {
  /** The live 2026-11-04 shape: built as a variable, as parsed JSON carries `allowed`. */
  const codexAtLimit = (credits: { has_credits: boolean; overage_limit_reached?: boolean }) => {
    const raw = {
      limit_source: 'measured' as const,
      windows: [{ name: 'primary', used_percent: 100 }],
      limit_reached: true,
      allowed: false,
      credits,
    };
    const reading: SeatReadingLike = raw;
    return reading;
  };
  const coolClaude = measured([{ name: 'seven_day', used_percent: 45 }]);

  test('Test 4: conductor agrees with the gate at allowed false', () => {
    const codex = codexAtLimit({ has_credits: true, overage_limit_reached: false });
    expect(rungSeatSkip('codex', { codex }, 95)).toBeNull();
    const result = choose({
      picked: 'codex',
      thresholdPercent: 95,
      usage: { codex, claude: coolClaude },
    });
    expect(result.entry).toBe('codex');
    expect(result.changed).toBe(false);
    expect(result.reason.startsWith('seat_credits:codex:')).toBe(true);
  });

  test('Test 5: exhausted or blocked credits still skip the codex rung', () => {
    for (const credits of [
      { has_credits: false, overage_limit_reached: false },
      { has_credits: true, overage_limit_reached: true },
    ]) {
      expect(rungSeatSkip('codex', { codex: codexAtLimit(credits) }, 95)).toEqual({
        tier: 'codex',
        seat: 'codex',
        usedPercent: 100,
        cutoffPercent: 95,
      });
    }
  });
});
