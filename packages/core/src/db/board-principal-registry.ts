/**
 * Production board principal resolver.
 *
 * WO-HARNESS-ACP-DISPATCH-SLICE-01 criterion C. Before this module,
 * `authenticateBoardPrincipal` had exactly one resolver setter --
 * `setBoardPrincipalResolverForTests`, which throws outside test envs -- so
 * every production call threw `board_principal_auth_unconfigured`. That made
 * all ten board-authority routes dead on arrival and left `board_xo_leases`
 * permanently empty, which in turn left XO-addressed dispatch messages with
 * no routing target (the 2026-07-16 dead-letter class).
 *
 * Design note (M-118): identity is deliberately expressed with the SAME
 * mechanism the dispatch worker already uses for board delivery credentials
 * (`packages/server/src/auth/dispatch-worker-credential.ts`): env-configured
 * records, sha256 token digests, timing-safe comparison. One identity scheme
 * for the harness, not two competing ones.
 *
 * Configure with BOARD_PRINCIPALS_JSON, an array of:
 *   {
 *     "principal_id": "xo-desktop-claude",
 *     "seat_id": "xo",
 *     "roles": ["board"],
 *     "token_sha256": "<64 hex chars>",
 *     "status": "active"
 *   }
 *
 * The raw token is NEVER stored here or in git (Rule 6) -- only its digest.
 */
import { createHash, timingSafeEqual } from 'crypto';
import type { BoardPrincipal, BoardPrincipalProof, BoardSeat } from './board-authority';

const VALID_SEATS: readonly BoardSeat[] = ['john', 'general', 'xo'];

export interface BoardPrincipalRecord {
  readonly principal_id: string;
  readonly seat_id: BoardSeat;
  readonly roles: readonly string[];
  readonly token_sha256: string;
  readonly status: 'active' | 'retiring' | 'disabled';
}

export function parseBoardPrincipalRecords(raw: string | undefined): BoardPrincipalRecord[] {
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('board_principals_config_invalid');
  }
  if (!Array.isArray(parsed)) throw new Error('board_principals_config_invalid');
  const seen = new Set<string>();
  return parsed.map(value => {
    if (!value || typeof value !== 'object') throw new Error('board_principals_config_invalid');
    const record = value as Partial<BoardPrincipalRecord>;
    if (
      typeof record.principal_id !== 'string' ||
      record.principal_id.length === 0 ||
      typeof record.seat_id !== 'string' ||
      !VALID_SEATS.includes(record.seat_id) ||
      !Array.isArray(record.roles) ||
      typeof record.token_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.token_sha256) ||
      !['active', 'retiring', 'disabled'].includes(String(record.status))
    ) {
      throw new Error('board_principals_config_invalid');
    }
    if (seen.has(record.principal_id)) throw new Error('board_principals_config_invalid');
    seen.add(record.principal_id);
    return record as BoardPrincipalRecord;
  });
}

/**
 * Resolves a principal from a proof. Returns null when no record matches --
 * `authenticateBoardPrincipal` converts that into `board_principal_auth_rejected`.
 *
 * Accepts either `principal_token` (the documented field) or `holder_token`
 * (what the lease acquire/renew bodies already carry), so a caller acquiring
 * a lease does not have to send the same secret twice.
 */
export function createBoardPrincipalResolver(options?: {
  readonly configJson?: string;
}): (proof: BoardPrincipalProof) => Promise<BoardPrincipal | null> {
  return async (proof: BoardPrincipalProof): Promise<BoardPrincipal | null> => {
    const records = parseBoardPrincipalRecords(
      options?.configJson ?? process.env.BOARD_PRINCIPALS_JSON
    );
    if (records.length === 0) return null;

    const token = proof.principal_token ?? proof.holder_token;
    if (!token || token.length === 0) return null;
    const digest = hashToken(token);

    const candidates = proof.holder_id
      ? records.filter(record => record.principal_id === proof.holder_id)
      : records;

    for (const record of candidates) {
      if (record.status === 'disabled') continue;
      if (!hashEquals(digest, record.token_sha256)) continue;
      return {
        principal_id: record.principal_id,
        seat_id: record.seat_id,
        roles: record.roles,
      };
    }
    return null;
  };
}

/** True when a production principal registry is configured. */
export function isBoardPrincipalRegistryConfigured(configJson?: string): boolean {
  const raw = configJson ?? process.env.BOARD_PRINCIPALS_JSON;
  if (!raw || raw.trim().length === 0) return false;
  try {
    return parseBoardPrincipalRecords(raw).length > 0;
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
