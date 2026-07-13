import { createHash, randomUUID } from 'crypto';
import { getDatabase } from './connection';

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

export type BoardSeat = 'john' | 'general' | 'xo';

export interface BoardPrincipal {
  readonly principal_id: string;
  readonly seat_id: BoardSeat;
  readonly roles: readonly string[];
}

export interface BoardPrincipalDependencies {
  readonly resolvePrincipal?: (proof: BoardPrincipalProof) => Promise<BoardPrincipal | null>;
}

export interface BoardPrincipalProof {
  readonly principal_token?: string;
  readonly holder_id?: string;
  readonly holder_token?: string;
}

let defaultPrincipalResolver:
  | ((proof: BoardPrincipalProof) => Promise<BoardPrincipal | null>)
  | undefined;

export function setBoardPrincipalResolverForTests(
  resolver: ((proof: BoardPrincipalProof) => Promise<BoardPrincipal | null>) | undefined
): void {
  defaultPrincipalResolver = resolver;
}

export interface XoLease {
  readonly lease_id: string;
  readonly principal_id: string;
  readonly seat_id: BoardSeat;
  readonly holder_id: string;
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly released_at: string | null;
}

interface XoLeaseRow extends XoLease {
  readonly id: number;
  readonly holder_token_hash: string;
}

export interface XoLeaseResult {
  readonly ok: boolean;
  readonly lease?: XoLease;
  readonly reason?: 'active_xo_lease_exists' | 'stale_xo_lease_token' | 'no_valid_xo_lease';
}

export interface BoardAuditEventInput {
  readonly event_type: string;
  readonly actor_principal_id?: string | null;
  readonly actor_seat_id?: string | null;
  readonly xo_lease_id?: string | null;
  readonly xo_fencing_token?: number | null;
  readonly motion_id?: string | null;
  readonly motion_revision_sha?: string | null;
  readonly details?: Record<string, unknown>;
  readonly created_at?: string;
}

export async function authenticateBoardPrincipal(
  proof: BoardPrincipalProof,
  dependencies: BoardPrincipalDependencies = {}
): Promise<BoardPrincipal> {
  const resolver = dependencies.resolvePrincipal ?? defaultPrincipalResolver;
  if (!resolver) {
    throw new Error('board_principal_auth_unconfigured');
  }
  const principal = await resolver(proof);
  if (!principal || !principal.principal_id || !principal.seat_id) {
    throw new Error('board_principal_auth_rejected');
  }
  if (!['john', 'general', 'xo'].includes(principal.seat_id)) {
    throw new Error('board_principal_auth_rejected');
  }
  return principal;
}

export async function appendBoardAuditEvent(input: BoardAuditEventInput): Promise<string> {
  const id = randomUUID();
  const db = getDatabase();
  await db.query(
    `INSERT INTO board_audit_events (
       id, event_type, actor_principal_id, actor_seat_id, xo_lease_id, xo_fencing_token,
       motion_id, motion_revision_sha, details, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.event_type,
      input.actor_principal_id ?? null,
      input.actor_seat_id ?? null,
      input.xo_lease_id ?? null,
      input.xo_fencing_token ?? null,
      input.motion_id ?? null,
      input.motion_revision_sha ?? null,
      JSON.stringify(input.details ?? {}),
      input.created_at ?? (await databaseNow()),
    ]
  );
  return id;
}

export async function getCurrentXoLease(): Promise<XoLease | null> {
  const now = await databaseNow();
  const result = await getDatabase().query<XoLeaseRow>(
    `SELECT * FROM board_xo_leases
     WHERE id = 1 AND released_at IS NULL AND expires_at > $1`,
    [now]
  );
  return result.rows[0] ? normalizeLease(result.rows[0]) : null;
}

export async function resolveBoardRecipient(): Promise<
  | { ok: true; principal_id: string; seat_id: BoardSeat; lease_id: string; fencing_token: number }
  | { ok: false; reason: 'no_valid_xo_lease' }
> {
  const lease = await getCurrentXoLease();
  if (!lease) return { ok: false, reason: 'no_valid_xo_lease' };
  return {
    ok: true,
    principal_id: lease.principal_id,
    seat_id: lease.seat_id,
    lease_id: lease.lease_id,
    fencing_token: lease.fencing_token,
  };
}

export async function acquireXoLease(input: {
  readonly principal: BoardPrincipal;
  readonly holder_id: string;
  readonly holder_token: string;
  readonly lease_duration_ms?: number;
}): Promise<XoLeaseResult> {
  const db = getDatabase();
  const now = await databaseNow();
  const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);
  const tokenHash = hashHolderToken(input.holder_token);

  return db.withTransaction(async txQuery => {
    const existingResult = await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1');
    const existing = existingResult.rows[0];

    if (existing && isActive(existing, now)) {
      if (existing.holder_id === input.holder_id && existing.holder_token_hash === tokenHash) {
        return { ok: true, lease: normalizeLease(existing) };
      }
      await insertAuditWithQuery(txQuery, {
        event_type: 'xo_lease_acquire_rejected',
        actor_principal_id: input.principal.principal_id,
        actor_seat_id: input.principal.seat_id,
        xo_lease_id: existing.lease_id,
        xo_fencing_token: existing.fencing_token,
        details: { reason: 'active_xo_lease_exists' },
        created_at: now,
      });
      return { ok: false, reason: 'active_xo_lease_exists' };
    }

    if (!existing) {
      await txQuery(
        `INSERT INTO board_xo_leases (
           id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
           fencing_token, acquired_at, renewed_at, expires_at, released_at
         )
         VALUES (1, $1, $2, $3, $4, $5, 1, $6, NULL, $7, NULL)`,
        [
          randomUUID(),
          input.principal.principal_id,
          input.principal.seat_id,
          input.holder_id,
          tokenHash,
          now,
          expiresAt,
        ]
      );
    } else {
      await txQuery(
        `UPDATE board_xo_leases
         SET lease_id = $1,
             principal_id = $2,
             seat_id = $3,
             holder_id = $4,
             holder_token_hash = $5,
             fencing_token = fencing_token + 1,
             acquired_at = $6,
             renewed_at = NULL,
             expires_at = $7,
             released_at = NULL
         WHERE id = 1 AND (released_at IS NOT NULL OR expires_at <= $6)`,
        [
          randomUUID(),
          input.principal.principal_id,
          input.principal.seat_id,
          input.holder_id,
          tokenHash,
          now,
          expiresAt,
        ]
      );
    }

    const current = await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1');
    const row = current.rows[0];
    if (
      !row ||
      row.holder_id !== input.holder_id ||
      row.holder_token_hash !== tokenHash ||
      row.principal_id !== input.principal.principal_id
    ) {
      return { ok: false, reason: 'active_xo_lease_exists' };
    }

    await insertAuditWithQuery(txQuery, {
      event_type: 'xo_lease_acquired',
      actor_principal_id: input.principal.principal_id,
      actor_seat_id: input.principal.seat_id,
      xo_lease_id: row.lease_id,
      xo_fencing_token: row.fencing_token,
      details: { holder_id: input.holder_id, expires_at: row.expires_at },
      created_at: now,
    });
    return { ok: true, lease: normalizeLease(row) };
  });
}

export async function renewXoLease(input: {
  readonly principal: BoardPrincipal;
  readonly holder_id: string;
  readonly holder_token: string;
  readonly fencing_token: number;
  readonly lease_duration_ms?: number;
}): Promise<XoLeaseResult> {
  const db = getDatabase();
  const now = await databaseNow();
  const expiresAt = addMillisecondsIso(now, input.lease_duration_ms ?? DEFAULT_LEASE_DURATION_MS);
  const tokenHash = hashHolderToken(input.holder_token);

  return db.withTransaction(async txQuery => {
    const existing = (await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1'))
      .rows[0];
    if (
      !existing ||
      !isActive(existing, now) ||
      existing.holder_id !== input.holder_id ||
      existing.holder_token_hash !== tokenHash ||
      existing.fencing_token !== input.fencing_token
    ) {
      await insertAuditWithQuery(txQuery, {
        event_type: 'xo_lease_renew_rejected',
        actor_principal_id: input.principal.principal_id,
        actor_seat_id: input.principal.seat_id,
        xo_lease_id: existing?.lease_id ?? null,
        xo_fencing_token: existing?.fencing_token ?? null,
        details: { reason: 'stale_xo_lease_token' },
        created_at: now,
      });
      return { ok: false, reason: 'stale_xo_lease_token' };
    }

    await txQuery(
      `UPDATE board_xo_leases
       SET renewed_at = $1, expires_at = $2
       WHERE id = 1 AND holder_id = $3 AND holder_token_hash = $4 AND fencing_token = $5
         AND released_at IS NULL AND expires_at > $1`,
      [now, expiresAt, input.holder_id, tokenHash, input.fencing_token]
    );
    const row = (await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1')).rows[0];
    await insertAuditWithQuery(txQuery, {
      event_type: 'xo_lease_renewed',
      actor_principal_id: input.principal.principal_id,
      actor_seat_id: input.principal.seat_id,
      xo_lease_id: row.lease_id,
      xo_fencing_token: row.fencing_token,
      details: { expires_at: row.expires_at },
      created_at: now,
    });
    return { ok: true, lease: normalizeLease(row) };
  });
}

export async function releaseXoLease(input: {
  readonly principal: BoardPrincipal;
  readonly holder_id: string;
  readonly holder_token: string;
  readonly fencing_token: number;
}): Promise<XoLeaseResult> {
  const db = getDatabase();
  const now = await databaseNow();
  const tokenHash = hashHolderToken(input.holder_token);

  return db.withTransaction(async txQuery => {
    const existing = (await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1'))
      .rows[0];
    if (
      !existing ||
      !isActive(existing, now) ||
      existing.holder_id !== input.holder_id ||
      existing.holder_token_hash !== tokenHash ||
      existing.fencing_token !== input.fencing_token
    ) {
      await insertAuditWithQuery(txQuery, {
        event_type: 'xo_lease_release_rejected',
        actor_principal_id: input.principal.principal_id,
        actor_seat_id: input.principal.seat_id,
        xo_lease_id: existing?.lease_id ?? null,
        xo_fencing_token: existing?.fencing_token ?? null,
        details: { reason: 'stale_xo_lease_token' },
        created_at: now,
      });
      return { ok: false, reason: 'stale_xo_lease_token' };
    }

    await txQuery(
      `UPDATE board_xo_leases
       SET released_at = $1
       WHERE id = 1 AND holder_id = $2 AND holder_token_hash = $3 AND fencing_token = $4
         AND released_at IS NULL AND expires_at > $1`,
      [now, input.holder_id, tokenHash, input.fencing_token]
    );
    const row = (await txQuery<XoLeaseRow>('SELECT * FROM board_xo_leases WHERE id = 1')).rows[0];
    await insertAuditWithQuery(txQuery, {
      event_type: 'xo_lease_released',
      actor_principal_id: input.principal.principal_id,
      actor_seat_id: input.principal.seat_id,
      xo_lease_id: row.lease_id,
      xo_fencing_token: row.fencing_token,
      details: { released_at: row.released_at },
      created_at: now,
    });
    return { ok: true, lease: normalizeLease(row) };
  });
}

async function databaseNow(): Promise<string> {
  const db = getDatabase();
  const sql =
    db.dialect === 'sqlite'
      ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now"
      : "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now";
  const result = await db.query<{ now: string }>(sql);
  return result.rows[0]?.now ?? new Date().toISOString();
}

function hashHolderToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function addMillisecondsIso(baseIso: string, ms: number): string {
  return new Date(new Date(baseIso).getTime() + ms).toISOString();
}

function isActive(row: XoLeaseRow, now: string): boolean {
  return row.released_at === null && row.expires_at > now;
}

function normalizeLease(row: XoLeaseRow): XoLease {
  return {
    lease_id: row.lease_id,
    principal_id: row.principal_id,
    seat_id: row.seat_id,
    holder_id: row.holder_id,
    fencing_token: Number(row.fencing_token),
    acquired_at: row.acquired_at,
    renewed_at: row.renewed_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
  };
}

async function insertAuditWithQuery(
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>,
  input: BoardAuditEventInput
): Promise<void> {
  await query(
    `INSERT INTO board_audit_events (
       id, event_type, actor_principal_id, actor_seat_id, xo_lease_id, xo_fencing_token,
       motion_id, motion_revision_sha, details, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      input.event_type,
      input.actor_principal_id ?? null,
      input.actor_seat_id ?? null,
      input.xo_lease_id ?? null,
      input.xo_fencing_token ?? null,
      input.motion_id ?? null,
      input.motion_revision_sha ?? null,
      JSON.stringify(input.details ?? {}),
      input.created_at ?? new Date().toISOString(),
    ]
  );
}
