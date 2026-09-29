/**
 * headroom.ts -- Pure entry-tier seat headroom decision.
 *
 * Routing only. Never holds or refuses a fire. The run-start seat gate
 * remains the only wall. No probes, credentials, or provider calls.
 */

export type SeatId = 'claude' | 'codex' | 'cursor';

export interface SeatWindowLike {
  name: string;
  used_percent: number;
}

export interface SeatReadingLike {
  limit_source: 'measured' | 'UNKNOWN';
  windows: SeatWindowLike[];
  limit_reached?: boolean;
}

export type SeatUsageSnapshot = Partial<Record<SeatId, SeatReadingLike>>;

export const DEFAULT_ENTRY_HEADROOM_THRESHOLD_PERCENT = 80;

const THRESHOLD_PATTERN = /^(?:[1-9]|[1-9][0-9])$/;

export function resolveEntryThreshold(env: Record<string, string | undefined>): number {
  const raw = env.SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT;
  if (raw !== undefined && THRESHOLD_PATTERN.test(raw)) return Number(raw);
  return DEFAULT_ENTRY_HEADROOM_THRESHOLD_PERCENT;
}

/**
 * Binding used-percent for one seat.
 * UNKNOWN limit source and a missing reading are UNKNOWN (null).
 * limit_reached wins over window percents. Otherwise the max window wins.
 */
export function bindingUsedPercent(reading: SeatReadingLike | undefined): number | null {
  if (reading === undefined) return null;
  if (reading.limit_source === 'UNKNOWN') return null;
  if (reading.limit_reached === true) return 100;
  if (!Array.isArray(reading.windows) || reading.windows.length === 0) return null;
  let max: number | null = null;
  for (const seatWindow of reading.windows) {
    const value = seatWindow?.used_percent;
    if (typeof value !== 'number') continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

/** Subscription seat that pays for a ladder tier. Per-token tiers return null. */
export function seatForTier(tierName: string): SeatId | null {
  if (tierName === 'codex') return 'codex';
  if (tierName === 'claude' || tierName === 'frontier') return 'claude';
  if (tierName === 'cursor') return 'cursor';
  return null;
}

export interface EntrySelection {
  picked: string;
  entry: string;
  changed: boolean;
  reason: string;
  thresholdPercent: number;
  seats: Partial<Record<SeatId, number | 'UNKNOWN'>>;
}

export function chooseHeadroomEntry(input: {
  picked: string;
  tiers: { name: string }[];
  refusedTiers: string[];
  premiumTiers: string[];
  usage: SeatUsageSnapshot | null;
  thresholdPercent: number;
  pinned: boolean;
}): EntrySelection {
  const { picked, tiers, refusedTiers, premiumTiers, usage, thresholdPercent, pinned } = input;
  const seats = usage === null || usage === undefined ? {} : seatsFromPick(picked, tiers, usage);
  const keep = (reason: string): EntrySelection => ({
    picked,
    entry: picked,
    changed: false,
    reason,
    thresholdPercent,
    seats,
  });

  if (pinned) return keep('pinned');
  if (usage === null || usage === undefined) return keep('seat_usage_unavailable');

  const seat = seatForTier(picked);
  if (seat === null) return keep('no_seat');

  const binding = bindingUsedPercent(usage[seat]);
  if (binding === null) return keep(`seat_unknown:${seat}`);
  const percent = String(binding);
  if (binding < thresholdPercent) return keep(`seat_ok:${seat}:${percent}`);

  const start = tiers.findIndex(tier => tier.name === picked);
  const later = start === -1 ? [] : tiers.slice(start + 1);
  for (const tier of later) {
    if (refusedTiers.includes(tier.name) || premiumTiers.includes(tier.name)) continue;
    const destination = seatForTier(tier.name);
    if (destination === null || destination === seat) continue;
    const destinationBinding = bindingUsedPercent(usage[destination]);
    if (destinationBinding === null || destinationBinding >= thresholdPercent) continue;
    return {
      picked,
      entry: tier.name,
      changed: tier.name !== picked,
      reason: `seat_over_threshold:${seat}:${percent}`,
      thresholdPercent,
      seats,
    };
  }

  return keep(`no_known_headroom:${seat}:${percent}`);
}

function seatsFromPick(
  picked: string,
  tiers: { name: string }[],
  usage: SeatUsageSnapshot
): Partial<Record<SeatId, number | 'UNKNOWN'>> {
  const seats: Partial<Record<SeatId, number | 'UNKNOWN'>> = {};
  const start = tiers.findIndex(tier => tier.name === picked);
  const names = start === -1 ? [picked] : tiers.slice(start).map(tier => tier.name);
  for (const name of names) {
    const seat = seatForTier(name);
    if (seat === null || seats[seat] !== undefined) continue;
    const binding = bindingUsedPercent(usage[seat]);
    seats[seat] = binding === null ? 'UNKNOWN' : binding;
  }
  return seats;
}
