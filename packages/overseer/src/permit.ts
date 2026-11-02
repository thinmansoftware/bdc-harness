import { M31_ACTION_KINDS, type M31ActionPermit } from '@archon/core/db/merge-steward';

const STRING_FIELDS = [
  'permit_id',
  'proposal_id',
  'execution_id',
  'repository',
  'head_sha',
  'base_branch',
  'base_sha',
  'snapshot_id',
  'capability',
  'issued_at',
  'valid_until',
] as const;

/** Parse an untrusted serialized permit without weakening the M-31 shape. */
export function parseM31ActionPermit(value: unknown): M31ActionPermit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string' || !record[field].trim()) return null;
  }
  if (!Number.isInteger(record.pr_number) || (record.pr_number as number) <= 0) return null;
  if (
    typeof record.action_kind !== 'string' ||
    !(M31_ACTION_KINDS as readonly string[]).includes(record.action_kind)
  ) {
    return null;
  }
  return { ...(record as unknown as M31ActionPermit) };
}

/** Read the one canonical metadata slot used by watcher and alternate callers. */
export function permitFromMetadata(
  metadata: Record<string, unknown> | undefined
): M31ActionPermit | null {
  return parseM31ActionPermit(metadata?.overseer_m31_permit);
}
