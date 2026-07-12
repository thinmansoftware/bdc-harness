import { pool, getDialect } from './connection';

export type KnownBadBindingSource = 'fire_probe' | 'binding_change' | 'operator';
export type KnownBadBindingClearReason = 'operator' | 'fire_reprobe';

export interface KnownBadBindingRow {
  readonly id: string;
  readonly binding_key: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly auth_context_id: string;
  readonly assistant_config_hash: string;
  readonly node_override_hash: string;
  readonly error_class: string;
  readonly http_status: number | null;
  readonly error_body_excerpt: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly hit_count: number;
  readonly source: KnownBadBindingSource;
  readonly cleared_at: string | null;
  readonly clear_reason: KnownBadBindingClearReason | null;
}

export interface UpsertKnownBadBindingInput {
  readonly bindingKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly authContextId: string;
  readonly assistantConfigHash: string;
  readonly nodeOverrideHash: string;
  readonly errorClass: string;
  readonly httpStatus?: number;
  readonly errorBodyExcerpt: string;
  readonly source: KnownBadBindingSource;
}

export async function upsertKnownBadBinding(
  input: UpsertKnownBadBindingInput
): Promise<KnownBadBindingRow> {
  const dialect = getDialect();
  const now = new Date().toISOString();
  const id = dialect.generateUuid();
  const result = await pool.query<KnownBadBindingRow>(
    `INSERT INTO known_bad_bindings
       (id, binding_key, provider_id, model_id, auth_context_id, assistant_config_hash,
        node_override_hash, error_class, http_status, error_body_excerpt, first_seen_at,
        last_seen_at, hit_count, source, cleared_at, clear_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 1, $12, NULL, NULL)
     ON CONFLICT (binding_key) DO UPDATE SET
       provider_id = EXCLUDED.provider_id,
       model_id = EXCLUDED.model_id,
       auth_context_id = EXCLUDED.auth_context_id,
       assistant_config_hash = EXCLUDED.assistant_config_hash,
       node_override_hash = EXCLUDED.node_override_hash,
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
      id,
      input.bindingKey,
      input.providerId,
      input.modelId,
      input.authContextId,
      input.assistantConfigHash,
      input.nodeOverrideHash,
      input.errorClass,
      input.httpStatus ?? null,
      input.errorBodyExcerpt.slice(0, 500),
      now,
      input.source,
    ]
  );
  const row = result.rows[0];
  if (!row) throw new Error('known_bad_binding_upsert_failed');
  return row;
}

export async function findActiveByBindingKey(
  bindingKey: string
): Promise<KnownBadBindingRow | null> {
  const result = await pool.query<KnownBadBindingRow>(
    `SELECT * FROM known_bad_bindings
     WHERE binding_key = $1 AND cleared_at IS NULL
     LIMIT 1`,
    [bindingKey]
  );
  return result.rows[0] ?? null;
}

export async function clearKnownBadBinding(
  bindingKey: string,
  clearReason: KnownBadBindingClearReason
): Promise<KnownBadBindingRow | null> {
  const result = await pool.query<KnownBadBindingRow>(
    `UPDATE known_bad_bindings
     SET cleared_at = $2, clear_reason = $3
     WHERE binding_key = $1 AND cleared_at IS NULL
     RETURNING *`,
    [bindingKey, new Date().toISOString(), clearReason]
  );
  return result.rows[0] ?? null;
}

export async function incrementKnownBadBindingHit(
  bindingKey: string
): Promise<KnownBadBindingRow | null> {
  const result = await pool.query<KnownBadBindingRow>(
    `UPDATE known_bad_bindings
     SET hit_count = hit_count + 1, last_seen_at = $2
     WHERE binding_key = $1 AND cleared_at IS NULL
     RETURNING *`,
    [bindingKey, new Date().toISOString()]
  );
  return result.rows[0] ?? null;
}
