import { describe, expect, test } from 'bun:test';
import { loadRuleset, pickEntryTier } from '../conductor.js';
import {
  bindingUsedPercent,
  chooseHeadroomEntry,
  resolveEntryThreshold,
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
    const codePick = pickEntryTier({ woClass: 'CODE' }, ruleset);
    expect(codePick).toBe('codex');
    const codeEntry = chooseHeadroomEntry({
      picked: codePick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: HOT_CODEX_COOL_CLAUDE,
      thresholdPercent: 80,
      pinned: false,
    });
    expect(codeEntry.entry).toBe('claude');
    expect(codeEntry.changed).toBe(true);
    expect(codeEntry.reason).toBe('seat_over_threshold:codex:83');

    const billingPick = pickEntryTier({ woClass: 'CODE', tags: ['billing'] }, ruleset);
    expect(billingPick).toBe('claude');
    const billingEntry = chooseHeadroomEntry({
      picked: billingPick,
      tiers,
      refusedTiers,
      premiumTiers,
      usage: HOT_CODEX_COOL_CLAUDE,
      thresholdPercent: 80,
      pinned: false,
    });
    expect(billingEntry.entry).toBe('claude');
    expect(billingEntry.changed).toBe(false);
    expect(billingEntry.reason).toBe('seat_ok:claude:45');
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

  test('audit-record-includes-measured-seats-below-the-pick', () => {
    const hotClaude = choose({
      picked: 'claude',
      usage: {
        cursor: measured([{ name: 'primary', used_percent: 12 }]),
        codex: measured([{ name: 'primary', used_percent: 10 }]),
        claude: measured([{ name: 'seven_day', used_percent: 95 }]),
      },
    });
    expect(hotClaude.entry).toBe('claude');
    expect(hotClaude.changed).toBe(false);
    expect(hotClaude.reason).toBe('no_known_headroom:claude:95');
    expect(hotClaude.seats).toEqual({ cursor: 12, codex: 10, claude: 95 });

    const claudeOnly = choose({
      picked: 'claude',
      usage: {
        claude: measured([{ name: 'seven_day', used_percent: 45 }]),
      },
    });
    expect(claudeOnly.seats).toEqual({ claude: 45 });

    const omittedLater = choose({
      picked: 'codex',
      usage: {
        cursor: measured([{ name: 'primary', used_percent: 12 }]),
        codex: measured([{ name: 'primary', used_percent: 40 }]),
      },
    });
    expect(omittedLater.entry).toBe('codex');
    expect(omittedLater.reason).toBe('seat_ok:codex:40');
    expect(omittedLater.seats).toEqual({ cursor: 12, codex: 40, claude: 'UNKNOWN' });
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
