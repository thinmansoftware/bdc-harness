export const MAINTENANCE_WINDOW_START = process.env.MAINTENANCE_WINDOW_START ?? '01:00';
export const MAINTENANCE_WINDOW_END = process.env.MAINTENANCE_WINDOW_END ?? '05:00';
export const MAINTENANCE_WINDOW_TZ = process.env.MAINTENANCE_WINDOW_TZ ?? 'America/New_York';

export interface MaintenanceWindowConfig {
  start?: string;
  end?: string;
  timeZone?: string;
}

export interface MaintenanceWindowResult {
  inside: boolean;
  windowKey: string | null;
  error?: string;
}

function minutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export function getMaintenanceWindow(
  now: Date,
  config: MaintenanceWindowConfig = {}
): MaintenanceWindowResult {
  const startText = config.start ?? MAINTENANCE_WINDOW_START;
  const endText = config.end ?? MAINTENANCE_WINDOW_END;
  const timeZone = config.timeZone ?? MAINTENANCE_WINDOW_TZ;
  const start = minutes(startText);
  const end = minutes(endText);
  if (start === null || end === null || start === end) {
    return { inside: false, windowKey: null, error: 'invalid maintenance window boundaries' };
  }
  try {
    const values: Record<string, string> = {};
    for (const part of new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)) {
      if (part.type !== 'literal') values[part.type] = part.value;
    }
    const current = Number(values.hour) * 60 + Number(values.minute);
    const wraps = start > end;
    const inside = wraps ? current >= start || current < end : current >= start && current < end;
    if (!inside) return { inside: false, windowKey: null };
    let date = `${values.year}-${values.month}-${values.day}`;
    if (wraps && current < end) {
      const localNoonUtc = new Date(`${date}T12:00:00.000Z`);
      localNoonUtc.setUTCDate(localNoonUtc.getUTCDate() - 1);
      date = localNoonUtc.toISOString().slice(0, 10);
    }
    return { inside: true, windowKey: `${timeZone}:${date}:${startText}-${endText}` };
  } catch (error) {
    return { inside: false, windowKey: null, error: (error as Error).message };
  }
}

export function isInMaintenanceWindow(now: Date, config?: MaintenanceWindowConfig): boolean {
  return getMaintenanceWindow(now, config).inside;
}
