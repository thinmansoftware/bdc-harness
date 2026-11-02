import { getDatabase } from './connection';

export interface SeatUsageReading {
  readonly seat: string;
  readonly used_percent: number;
  readonly remaining_percent: number;
  readonly resets_at: string;
  readonly observed_at: string;
  readonly source: string;
  readonly received_at: string;
}

export interface SeatUsageReadingInput {
  readonly seat: string;
  readonly used_percent: number;
  readonly remaining_percent: number;
  readonly resets_at: string;
  readonly observed_at: string;
  readonly source: string;
}

interface SeatUsageReadingRow {
  readonly seat: string;
  readonly used_percent: number | string;
  readonly remaining_percent: number | string;
  readonly resets_at: Date | string;
  readonly observed_at: Date | string;
  readonly source: string;
  readonly received_at: Date | string;
}

function normalizeTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('invalid_seat_usage_reading_timestamp');
  }
  return timestamp.toISOString();
}

function normalizePercent(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error('invalid_seat_usage_reading_percent');
  }
  return parsed;
}

function normalizeReading(row: SeatUsageReadingRow): SeatUsageReading {
  return {
    seat: row.seat,
    used_percent: normalizePercent(row.used_percent),
    remaining_percent: normalizePercent(row.remaining_percent),
    resets_at: normalizeTimestamp(row.resets_at),
    observed_at: normalizeTimestamp(row.observed_at),
    source: row.source,
    received_at: normalizeTimestamp(row.received_at),
  };
}

export async function upsertSeatUsageReading(input: SeatUsageReadingInput): Promise<void> {
  const receivedAt = new Date().toISOString();
  await getDatabase().query(
    `INSERT INTO seat_usage_readings (
       seat, used_percent, remaining_percent, resets_at, observed_at, source, received_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (seat) DO UPDATE SET
       used_percent = excluded.used_percent,
       remaining_percent = excluded.remaining_percent,
       resets_at = excluded.resets_at,
       observed_at = excluded.observed_at,
       source = excluded.source,
       received_at = excluded.received_at`,
    [
      input.seat,
      input.used_percent,
      input.remaining_percent,
      input.resets_at,
      input.observed_at,
      input.source,
      receivedAt,
    ]
  );
}

export async function getLatestSeatUsageReading(seat: string): Promise<SeatUsageReading | null> {
  const result = await getDatabase().query<SeatUsageReadingRow>(
    `SELECT seat, used_percent, remaining_percent, resets_at, observed_at, source, received_at
     FROM seat_usage_readings
     WHERE seat = $1`,
    [seat]
  );
  const row = result.rows[0];
  if (!row) return null;
  return normalizeReading(row);
}
