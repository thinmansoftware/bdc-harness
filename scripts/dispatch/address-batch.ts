/**
 * address-batch: a bulk, journaled way to address a flood of stale Dispatch
 * mailbox rows (WO-HARNESS-TASKMASTER-ESCALATE-P0-FLOOD-01, Amendment 1 E and
 * Amendment 4).
 *
 * Usage (run on the host inside archon-app-1, with the harness database):
 *   bun scripts/dispatch/address-batch.ts --recipient <r> --status <s> --kind <k>
 *     --min-age-hours <n> [--audit-file <path>]
 *       -> DRY RUN (the default): prints the matching ids, writes one dry_run
 *          audit line with a dry_run_id, changes nothing.
 *   ... the same filters ... --confirm --dry-run-id <id> --actor <a> --reason <text>
 *     [--xo-bind-file <path>]   (required when --recipient is xo)
 *       -> one guarded UPDATE in ONE transaction; sets addressed_at and
 *          addressed_by='bulk-address:<actor>' only.
 *
 * Exit codes: 0 done; 2 refused (missing filter or argument, dry-run mismatch,
 * xo_bind_required, lease_fence_stale, unsupported database); 3 the update
 * count differed from the dry-run ids, so the transaction rolled back.
 *
 * DELIBERATE DEPARTURE from addressMessage (packages/core/src/db/dispatch.ts):
 * it does not require an acknowledgement by the same principal first
 * (address_before_ack), because most flood rows were never acknowledged. It
 * keeps the guards that fit one statement (still queued, not yet addressed,
 * same recipient and kind) and the XO lease fence. It never acknowledges,
 * cancels or deletes. The builder does not run --confirm on a live mailbox;
 * that is an operator act on a recorded dry run.
 *
 * SQLite only: the kind filter reads $.kind only from valid JSON bodies.
 */
import { createHash } from 'crypto';
import { appendFileSync, readFileSync } from 'fs';
import { getDatabase } from '../../packages/core/src/db/connection';
import {
  validateXoLeaseBind,
  xoLeaseBindPredicate,
  type DispatchQueryExecutor,
  type XoLeaseBind,
} from '../../packages/core/src/db/dispatch';

export const DEFAULT_AUDIT_FILE = '/.archon/inbox-reader/bulk-address-audit.jsonl';
export const KIND_EXPRESSION =
  "CASE WHEN json_valid(body) THEN json_extract(body, '$.kind') ELSE NULL END";
const RECIPIENT_EXPRESSION = 'LOWER(TRIM(COALESCE(resolved_recipient, recipient)))';

const USAGE =
  'usage: address-batch.ts --recipient <r> --status <s> --kind <k> --min-age-hours <n> ' +
  '[--audit-file <path>] [--confirm --dry-run-id <id> --actor <a> --reason <text> ' +
  '[--xo-bind-file <path>]]';

interface BatchDb {
  dialect: string;
  query: DispatchQueryExecutor;
  withTransaction<T>(fn: (query: DispatchQueryExecutor) => Promise<T>): Promise<T>;
}

export interface AddressBatchOptions {
  db?: BatchDb;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /**
   * Test seam only: runs inside the confirm transaction after the dry-run
   * re-check and before the UPDATE, so a test can make the update count differ
   * and prove the rollback (exit 3).
   */
  beforeUpdateForTests?: (query: DispatchQueryExecutor) => Promise<void>;
}

class BatchRefusal extends Error {
  constructor(
    readonly exitCode: number,
    readonly reason: string
  ) {
    super(reason);
  }
}

interface Filter {
  recipient: string;
  status: string;
  kind: string;
  min_age_hours: number;
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new BatchRefusal(2, `unexpected_argument:${arg}`);
    const name = arg.slice(2);
    if (name === 'confirm') {
      args.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new BatchRefusal(2, `missing_value:${name}`);
    args.set(name, value);
    i += 1;
  }
  return args;
}

function stringArg(args: Map<string, string | true>, name: string): string | null {
  const value = args.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readFilter(args: Map<string, string | true>): Filter {
  const recipient = stringArg(args, 'recipient');
  const status = stringArg(args, 'status');
  const kind = stringArg(args, 'kind');
  const age = stringArg(args, 'min-age-hours');
  if (!recipient || !status || !kind || !age) throw new BatchRefusal(2, 'filters_required');
  if (!/^\d+$/.test(age)) throw new BatchRefusal(2, 'min_age_hours_not_an_integer');
  return { recipient: recipient.toLowerCase(), status, kind, min_age_hours: Number(age) };
}

function filterExpression(filter: Filter, cutoffIso: string): string {
  return (
    `${RECIPIENT_EXPRESSION} = '${filter.recipient}' AND status = '${filter.status}' AND ` +
    `${KIND_EXPRESSION} = '${filter.kind}' AND created_at <= '${cutoffIso}' AND ` +
    'addressed_at IS NULL AND addressed_by IS NULL'
  );
}

async function matchingIds(
  query: DispatchQueryExecutor,
  filter: Filter,
  cutoffIso: string
): Promise<string[]> {
  const result = await query<{ id: string }>(
    `SELECT id FROM agent_dispatch_messages
     WHERE ${RECIPIENT_EXPRESSION} = $1 AND status = $2 AND ${KIND_EXPRESSION} = $3
       AND created_at <= $4 AND addressed_at IS NULL AND addressed_by IS NULL
     ORDER BY created_at, id`,
    [filter.recipient, filter.status, filter.kind, cutoffIso]
  );
  return result.rows.map(row => row.id);
}

/** The dry-run id: a hash of the filter and the exact id list. */
export function dryRunId(filter: Filter, ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ filter, ids })).digest('hex');
}

function readBind(path: string): XoLeaseBind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new BatchRefusal(2, 'xo_bind_required');
  }
  const bind = parsed as Partial<XoLeaseBind> | null;
  if (
    bind?.kind !== 'xo_lease' ||
    typeof bind.lease_id !== 'string' ||
    typeof bind.fencing_token !== 'number' ||
    typeof bind.holder_token_hash !== 'string' ||
    typeof bind.holder_principal_id !== 'string'
  ) {
    throw new BatchRefusal(2, 'xo_bind_required');
  }
  return bind as XoLeaseBind;
}

export async function runAddressBatch(
  argv: string[],
  options: AddressBatchOptions = {}
): Promise<number> {
  const out =
    options.out ??
    ((line: string): void => {
      console.log(line);
    });
  const err =
    options.err ??
    ((line: string): void => {
      console.error(line);
    });
  const env = options.env ?? process.env;
  try {
    const args = parseArgs(argv);
    const filter = readFilter(args);
    const db = options.db ?? (getDatabase() as unknown as BatchDb);
    if (db.dialect !== 'sqlite') throw new BatchRefusal(2, 'sqlite_only');
    const now = (options.now ?? ((): Date => new Date()))();
    const nowIso = now.toISOString();
    const cutoffIso = new Date(now.getTime() - filter.min_age_hours * 3_600_000).toISOString();
    const auditFile =
      stringArg(args, 'audit-file') ?? env.BULK_ADDRESS_AUDIT_FILE ?? DEFAULT_AUDIT_FILE;
    const audit = (line: Record<string, unknown>): void => {
      appendFileSync(auditFile, `${JSON.stringify(line)}\n`, 'utf8');
    };

    if (!args.has('confirm')) {
      const ids = await matchingIds((sql, params) => db.query(sql, params), filter, cutoffIso);
      const id = dryRunId(filter, ids);
      out(`filter: ${filterExpression(filter, cutoffIso)}`);
      out(`kind expression: ${KIND_EXPRESSION}`);
      for (const messageId of ids) out(messageId);
      out(`count: ${ids.length}`);
      out(`dry_run_id: ${id}`);
      audit({ type: 'dry_run', at: nowIso, filter, ids, dry_run_id: id, count: ids.length });
      return 0;
    }

    const expectedId = stringArg(args, 'dry-run-id');
    const actor = stringArg(args, 'actor');
    const reason = stringArg(args, 'reason');
    const bindFile = stringArg(args, 'xo-bind-file');
    if (!expectedId) throw new BatchRefusal(2, 'dry_run_id_required');
    if (!actor || !reason) throw new BatchRefusal(2, 'actor_and_reason_required');
    // Only a still-queued row can be addressed (the UPDATE's own guard), so a
    // confirm on any other status could never match its dry run.
    if (filter.status !== 'queued') throw new BatchRefusal(2, 'confirm_requires_status_queued');
    if (filter.recipient === 'xo' && !bindFile) throw new BatchRefusal(2, 'xo_bind_required');
    // A bind is accepted for the xo mailbox only (validateXoLeaseBind returns
    // lease_fence_stale for a bind given to another principal).
    if (filter.recipient !== 'xo' && bindFile) throw new BatchRefusal(2, 'lease_fence_stale');
    const bind = bindFile ? readBind(bindFile) : undefined;
    const addressedBy = `bulk-address:${actor}`;

    const confirmed = await db.withTransaction(async query => {
      const ids = await matchingIds(query, filter, cutoffIso);
      if (dryRunId(filter, ids) !== expectedId) throw new BatchRefusal(2, 'dry_run_mismatch');
      const stale = await validateXoLeaseBind(query, filter.recipient, bind);
      if (stale) throw new BatchRefusal(2, stale.reason);
      if (options.beforeUpdateForTests) await options.beforeUpdateForTests(query);
      const predicate = xoLeaseBindPredicate(filter.recipient, bind);
      // $1-$3 are the update's own; the lease predicate owns $4-$8 (padded with
      // nulls when it is empty); the filters start at $9.
      const predicateParams = [...predicate.params];
      while (predicateParams.length < 5) predicateParams.push(null);
      const update = await query(
        `UPDATE agent_dispatch_messages
         SET addressed_at = $2, addressed_by = $3
         WHERE id IN (SELECT value FROM json_each($1))
           AND status = 'queued'
           AND addressed_at IS NULL
           AND addressed_by IS NULL
           AND ${RECIPIENT_EXPRESSION} = $9
           AND ${KIND_EXPRESSION} = $10${predicate.sql}`,
        [
          JSON.stringify(ids),
          nowIso,
          addressedBy,
          ...predicateParams,
          filter.recipient,
          filter.kind,
        ]
      );
      if (update.rowCount !== ids.length) throw new BatchRefusal(3, 'count_mismatch_rolled_back');
      // Two audit lines bracket the COMMIT. 'confirm_pending' is written INSIDE
      // the transaction: if that append fails, the update rolls back, so no row
      // is ever addressed without an audit line. 'confirm' is written after the
      // COMMIT: a pending line with no confirm line means the COMMIT (or the
      // second append) did not complete, and the rows say which.
      audit({
        type: 'confirm_pending',
        at: nowIso,
        actor,
        reason,
        filter,
        dry_run_id: expectedId,
        dry_run_ids: ids,
        count: update.rowCount,
      });
      return ids;
    });

    audit({
      type: 'confirm',
      at: nowIso,
      actor,
      reason,
      filter,
      dry_run_id: expectedId,
      dry_run_ids: confirmed,
      confirmed_ids: confirmed,
      count: confirmed.length,
    });
    out(`addressed: ${confirmed.length}`);
    return 0;
  } catch (error) {
    if (error instanceof BatchRefusal) {
      err(`refused: ${error.reason}`);
      if (error.exitCode === 2) err(USAGE);
      return error.exitCode;
    }
    throw error;
  }
}

if (import.meta.main) {
  runAddressBatch(process.argv.slice(2)).then(
    code => process.exit(code),
    (error: unknown) => {
      console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
}
