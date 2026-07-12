import { randomUUID } from 'crypto';
import { getDatabase } from './connection';

export type KnownBadBindingClearReason = 'operator' | 'fire_reprobe';

export interface KnownBadBinding {
  id: string;
  binding_key: string;
  provider_id: string;
  model_id: string;
  auth_context_id: string;
  assistant_config_hash: string;
  node_override_hash: string;
  error_class: string;
  http_status: number | null;
  error_body_excerpt: string;
  first_seen_at: string;
  last_seen_at: string;
  hit_count: number;
  source: string;
  cleared_at: string | null;
  clear_reason: string | null;
}

export interface UpsertKnownBadBindingInput {
  binding_key: string;
  provider_id: string;
  model_id: string;
  auth_context_id: string;
  assistant_config_hash: string;
  node_override_hash: string;
  error_class: string;
  http_status?: number | null;
  error_body_excerpt: string;
  source: string;
}

interface KnownBadBindingRow extends Omit<KnownBadBinding, 'hit_count' | 'http_status'> {
  hit_count: number | string;
  http_status: number | string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeNullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : normalizeTimestamp(value);
}

function normalize(row: KnownBadBindingRow): KnownBadBinding {
  return {
    ...row,
    http_status: row.http_status === null ? null : Number(row.http_status),
    first_seen_at: normalizeTimestamp(row.first_seen_at),
    last_seen_at: normalizeTimestamp(row.last_seen_at),
    hit_count: Number(row.hit_count),
    cleared_at: normalizeNullableTimestamp(row.cleared_at),
  };
}

export async function upsertKnownBadBinding(
  input: UpsertKnownBadBindingInput
): Promise<KnownBadBinding> {
  const now = nowIso();
  const result = await getDatabase().query<KnownBadBindingRow>(
    `INSERT INTO known_bad_bindings
     (id, binding_key, provider_id, model_id, auth_context_id, assistant_config_hash,
      node_override_hash, error_class, http_status, error_body_excerpt, first_seen_at,
      last_seen_at, hit_count, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 1, $12)
     ON CONFLICT (binding_key) DO UPDATE SET
       error_class = EXCLUDED.error_class,
       http_status = EXCLUDED.http_status,
       error_body_excerpt = EXCLUDED.error_body_excerpt,
       last_seen_at = EXCLUDED.last_seen_at,
       hit_count = known_bad_bindings.hit_count + 1,
       source = EXCLUDED.source,
       cleared_at = NULL,
       clear_reason = NULL
     RETURNING *`,
    [
      randomUUID(),
      input.binding_key,
      input.provider_id,
      input.model_id,
      input.auth_context_id,
      input.assistant_config_hash,
      input.node_override_hash,
      input.error_class,
      input.http_status ?? null,
      input.error_body_excerpt,
      now,
      input.source,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to upsert known bad binding');
  return normalize(row);
}

export async function getActiveKnownBadBinding(
  bindingKey: string
): Promise<KnownBadBinding | null> {
  const result = await getDatabase().query<KnownBadBindingRow>(
    'SELECT * FROM known_bad_bindings WHERE binding_key = $1 AND cleared_at IS NULL',
    [bindingKey]
  );
  const row = result.rows[0];
  return row ? normalize(row) : null;
}

export async function incrementKnownBadBindingHit(bindingKey: string): Promise<KnownBadBinding | null> {
  const db = getDatabase();
  if (db.dialect === 'postgres') {
    const result = await db.query<KnownBadBindingRow>(
      `UPDATE known_bad_bindings
       SET hit_count = hit_count + 1, last_seen_at = $2
       WHERE binding_key = $1 AND cleared_at IS NULL
       RETURNING *`,
      [bindingKey, nowIso()]
    );
    const row = result.rows[0];
    return row ? normalize(row) : null;
  }
  const result = await db.query(
    `UPDATE known_bad_bindings
     SET hit_count = hit_count + 1, last_seen_at = $2
     WHERE binding_key = $1 AND cleared_at IS NULL`,
    [bindingKey, nowIso()]
  );
  if (result.rowCount !== 1) return null;
  return getActiveKnownBadBinding(bindingKey);
}

export async function clearKnownBadBinding(
  bindingKey: string,
  reason: KnownBadBindingClearReason
): Promise<KnownBadBinding | null> {
  const db = getDatabase();
  const now = nowIso();
  if (db.dialect === 'postgres') {
    const result = await db.query<KnownBadBindingRow>(
      `UPDATE known_bad_bindings
       SET cleared_at = $2, clear_reason = $3
       WHERE binding_key = $1 AND cleared_at IS NULL
       RETURNING *`,
      [bindingKey, now, reason]
    );
    const row = result.rows[0];
    return row ? normalize(row) : null;
  }
  const result = await db.query(
    `UPDATE known_bad_bindings
     SET cleared_at = $2, clear_reason = $3
     WHERE binding_key = $1 AND cleared_at IS NULL`,
    [bindingKey, now, reason]
  );
  if (result.rowCount !== 1) return null;
  const rows = await db.query<KnownBadBindingRow>(
    'SELECT * FROM known_bad_bindings WHERE binding_key = $1',
    [bindingKey]
  );
  return rows.rows[0] ? normalize(rows.rows[0]) : null;
}
