import { getDatabase } from './connection';

export interface OperatorSetting {
  readonly setting_key: string;
  readonly setting_value: string;
  readonly updated_at: string;
  readonly updated_by: string;
  readonly reason: string | null;
}

interface OperatorSettingRow {
  readonly setting_key: string;
  readonly setting_value: string;
  readonly updated_at: Date | string;
  readonly updated_by: string;
  readonly reason: string | null;
}

export function normalizeOperatorSettingTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('invalid_operator_setting_timestamp');
  }
  return timestamp.toISOString();
}

function normalizeSetting(row: OperatorSettingRow): OperatorSetting {
  return {
    setting_key: row.setting_key,
    setting_value: row.setting_value,
    updated_at: normalizeOperatorSettingTimestamp(row.updated_at),
    updated_by: row.updated_by,
    reason: row.reason,
  };
}

export async function getOperatorSetting(key: string): Promise<OperatorSetting | null> {
  const result = await getDatabase().query<OperatorSettingRow>(
    `SELECT setting_key, setting_value, updated_at, updated_by, reason
     FROM operator_settings
     WHERE setting_key = $1`,
    [key]
  );
  const row = result.rows[0];
  if (!row) return null;
  return normalizeSetting(row);
}

export async function setOperatorSetting(
  key: string,
  value: string,
  updatedBy: string,
  reason: string | null
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await getDatabase().query(
    `INSERT INTO operator_settings (setting_key, setting_value, updated_at, updated_by, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (setting_key) DO UPDATE SET
       setting_value = excluded.setting_value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       reason = excluded.reason`,
    [key, value, updatedAt, updatedBy, reason]
  );
}

export async function clearOperatorSetting(key: string): Promise<void> {
  await getDatabase().query('DELETE FROM operator_settings WHERE setting_key = $1', [key]);
}
