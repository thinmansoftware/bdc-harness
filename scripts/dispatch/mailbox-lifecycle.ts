/**
 * One-time XO mailbox cleanup (WO-HARNESS-XO-MAILBOX-LIFECYCLE-01, bdc-xo#5180).
 * The ONLY path for this cleanup: no hand SQL, no cancellation, no deletion.
 *
 * Usage (on the host, inside archon-app-1, against the harness database):
 *   bun scripts/dispatch/mailbox-lifecycle.ts [--recipient xo] [--evidence-file <path>]
 *       -> DRY RUN (the default): prints counts and ids per class and a
 *          confirm_token. Changes nothing.
 *   bun scripts/dispatch/mailbox-lifecycle.ts --execute --confirm <token> --out-dir <dir>
 *       [--recipient xo] [--evidence-file <path>] [--github]
 *       -> recomputes the set; refuses unless its token equals <token> (the
 *          dry run the acting XO approved). Then runs each class in its own
 *          transaction and writes one tm_journal row per class.
 *
 * Classes (recipient scoped by --recipient, default xo):
 *   backfill            addressed rows still status queued -> status done,
 *                       completed_at = addressed_at. Counts for every
 *                       recipient are printed; only --recipient is mutated.
 *   k1_collapse_dispatch / k2_collapse_system
 *                       open rows (queued, unread, unaddressed, undisposed)
 *                       from a system:* sender, grouped by recipient, sender
 *                       and subject (subject_key, else correlation_id). Each
 *                       row is folded into the newest later row of the same
 *                       or a higher priority (an older blocker followed only
 *                       by normal rows stays open); folded rows are
 *                       superseded by supersedeRepeatByNewer (status done,
 *                       route_disposition superseded, never cancelled). K1 is
 *                       sender system:dispatch (Duty Officer escalations and
 *                       XO handoffs); K2 is every other system sender. Only a
 *                       recipient that is an active mailbox principal
 *                       (drain_on_start or notify_only) is collapsed.
 *   k3_disk_alerts      open rows from sender xo whose body begins DISK ALERT.
 *                       Needs --evidence-file: JSON {"taken_at": ISO,
 *                       "host": "<host>", "threshold_percent": <n>,
 *                       "df": "<df -P output>"} taken within 15 minutes. A row
 *                       naming that host, whose mount reads below the
 *                       threshold, is expired by disposeMessageByMachine with
 *                       the evidence as its note. Every other row stays open
 *                       and is listed with the reason.
 *   k4_customer         protected: rows from order-events or whatnot-webhook
 *                       are never mutated by any class; open ones are listed.
 *   k5_large_bodies     bodies over 20000 bytes: exported to <out-dir>/<id>.body
 *                       with large-bodies-manifest.json, re-read and
 *                       sha256-checked, then the live body becomes the stub
 *                       {"archived_to","sha256","bytes"}. All exports happen
 *                       before any class mutates; a failed export changes
 *                       nothing.
 * After execute: <out-dir>/open-work-<recipient>.txt lists the open rows left,
 * one line per gh subject (issue state and prio/owner labels read from GitHub
 * only with --github and GH_TOKEN or GITHUB_TOKEN). It contacts nobody.
 *
 * Seat-authored rows (sender principal not system:*) are never superseded or
 * expired, except by k3. SQLite only (the deployed harness database).
 * Exit codes: 0 done; 2 refused (usage, token missing or mismatched, set
 * changed, schema check failed, unsupported database); 1 failed (an export or
 * a class transaction failed and rolled back).
 */
import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { closeDatabase, getDatabase } from '../../packages/core/src/db/connection';
import {
  disposeMessageByMachine,
  supersedeRepeatByNewer,
  type DispatchQueryExecutor,
} from '../../packages/core/src/db/dispatch';

export const WO_ID = 'WO-HARNESS-XO-MAILBOX-LIFECYCLE-01';
export const MACHINE_ACTOR = 'system:mailbox-lifecycle-01';
const LARGE_BODY_BYTES = 20_000;
const EVIDENCE_MAX_AGE_MS = 15 * 60_000;
const PROTECTED_SENDERS = ['order-events', 'whatnot-webhook'];
const RECIPIENT_EXPRESSION = 'LOWER(TRIM(COALESCE(resolved_recipient, recipient)))';
const NOT_PROTECTED = `sender NOT IN ('order-events', 'whatnot-webhook')
  AND COALESCE(sender_principal_id, '') NOT IN ('order-events', 'whatnot-webhook')`;
const OPEN = `status = 'queued' AND acknowledged_at IS NULL AND addressed_at IS NULL
  AND route_disposition IS NULL`;
const MUTATING_CLASSES = [
  'backfill',
  'k1_collapse_dispatch',
  'k2_collapse_system',
  'k3_disk_alerts',
  'k5_large_bodies',
] as const;
type MutatingClass = (typeof MUTATING_CLASSES)[number];

const USAGE =
  'usage: mailbox-lifecycle.ts [--recipient <r>] [--evidence-file <path>] ' +
  '[--execute --confirm <token> --out-dir <dir> [--github]]';

interface LifecycleDb {
  dialect: string;
  query: DispatchQueryExecutor;
  withTransaction<T>(
    fn: (query: DispatchQueryExecutor) => Promise<T>,
    options?: { immediate?: boolean }
  ): Promise<T>;
}

export interface MailboxLifecycleOptions {
  db?: LifecycleDb;
  now?: () => Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

class Refusal extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

interface Args {
  recipient: string;
  execute: boolean;
  confirm: string | null;
  evidenceFile: string | null;
  outDir: string | null;
  github: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    recipient: 'xo',
    execute: false,
    confirm: null,
    evidenceFile: null,
    outDir: null,
    github: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Refusal(2, USAGE);
      index += 1;
      return next;
    };
    if (flag === '--recipient') args.recipient = value().trim().toLowerCase();
    else if (flag === '--execute') args.execute = true;
    else if (flag === '--confirm') args.confirm = value().trim();
    else if (flag === '--evidence-file') args.evidenceFile = value();
    else if (flag === '--out-dir') args.outDir = value();
    else if (flag === '--github') args.github = true;
    else throw new Refusal(2, `unknown_argument:${flag ?? ''}; ${USAGE}`);
  }
  if (!args.recipient) throw new Refusal(2, USAGE);
  return args;
}

interface OpenRow {
  id: string;
  sender: string;
  sender_principal_id: string | null;
  recipient: string;
  subject_key: string | null;
  correlation_id: string;
  created_at: string;
  priority: string;
  head: string;
}

/** Same ranking as the runtime collapse in packages/core/src/db/dispatch.ts. */
const PRIORITY_RANK: Readonly<Record<string, number>> = { blocker: 0, normal: 1, heartbeat: 2 };
const rankOf = (priority: string): number => PRIORITY_RANK[priority] ?? PRIORITY_RANK.normal ?? 1;

interface SupersedePair {
  older: string;
  newer: string;
}

interface DiskDecision {
  id: string;
  note: string;
}

interface LargeBody {
  id: string;
  sender: string;
  subject: string | null;
  bytes: number;
}

interface Plan {
  recipient: string;
  schemaOk: boolean;
  schemaDetail: string;
  backfillAll: Record<string, number>;
  backfill: string[];
  k1: SupersedePair[];
  k2: SupersedePair[];
  collapseSenders: string[];
  k3: DiskDecision[];
  k3Refusal: string | null;
  k3LeftOpen: { id: string; reason: string }[];
  k4: string[];
  k5: LargeBody[];
  exhaustedSubjectless: number;
  openAfter: OpenRow[];
}

function classIds(plan: Plan, name: MutatingClass): string[] {
  switch (name) {
    case 'backfill':
      return [...plan.backfill].sort();
    case 'k1_collapse_dispatch':
      return plan.k1.map(pair => pair.older).sort();
    case 'k2_collapse_system':
      return plan.k2.map(pair => pair.older).sort();
    case 'k3_disk_alerts':
      return plan.k3.map(item => item.id).sort();
    case 'k5_large_bodies':
      return plan.k5.map(item => item.id).sort();
  }
}

/** The confirm token: sha256 over the sorted ids and the count of each class. */
export function confirmToken(plan: Plan): string {
  const classes = MUTATING_CLASSES.map(name => {
    const ids = classIds(plan, name);
    return { class: name, count: ids.length, ids };
  });
  return createHash('sha256')
    .update(JSON.stringify({ wo: WO_ID, recipient: plan.recipient, classes }))
    .digest('hex');
}

async function checkSchema(query: DispatchQueryExecutor): Promise<{ ok: boolean; detail: string }> {
  const table = await query<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_dispatch_messages'"
  );
  const ddl = table.rows[0]?.sql ?? '';
  const statusHasDone = /status[^,]*CHECK[^,]*'done'/is.test(ddl) || ddl.includes("'done'");
  const columns = await query<{ name: string }>(
    "SELECT name FROM pragma_table_info('agent_dispatch_messages')"
  );
  const names = new Set(columns.rows.map(row => row.name));
  const required = [
    'status',
    'completed_at',
    'addressed_at',
    'route_disposition',
    'route_disposed_at',
    'result_body',
    'subject_key',
    'sender_principal_id',
  ];
  const missing = required.filter(name => !names.has(name));
  return {
    ok: statusHasDone && missing.length === 0,
    detail: `status_check_has_done=${statusHasDone ? 'yes' : 'no'} missing_columns=${
      missing.length ? missing.join(',') : 'none'
    }`,
  };
}

async function isMailboxPrincipal(
  query: DispatchQueryExecutor,
  principal: string
): Promise<boolean> {
  const result = await query<{ delivery_mode: string; active: unknown }>(
    'SELECT delivery_mode, active FROM dispatch_principals WHERE principal_id = $1',
    [principal]
  );
  const row = result.rows[0];
  if (!row) return false;
  const active = row.active === 1 || row.active === true || String(row.active) === 'true';
  return active && (row.delivery_mode === 'drain_on_start' || row.delivery_mode === 'notify_only');
}

interface DiskEvidence {
  takenAt: number;
  host: string;
  threshold: number;
  mounts: Map<string, number>;
  raw: string;
}

function readEvidence(path: string | null, now: Date): DiskEvidence | string {
  if (!path) return 'evidence_missing';
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'evidence_unreadable';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'evidence_invalid';
  const record = parsed as Record<string, unknown>;
  const takenAt = typeof record.taken_at === 'string' ? Date.parse(record.taken_at) : NaN;
  const host = typeof record.host === 'string' ? record.host.trim() : '';
  const threshold = Number(record.threshold_percent);
  const df = typeof record.df === 'string' ? record.df : '';
  if (!Number.isFinite(takenAt) || !host || !Number.isFinite(threshold) || !df) {
    return 'evidence_invalid';
  }
  const age = now.getTime() - takenAt;
  if (age > EVIDENCE_MAX_AGE_MS || age < -60_000) return 'evidence_stale';
  const mounts = new Map<string, number>();
  for (const line of df.split(/\r?\n/)) {
    const match = /(\d+)%\s+(\/\S*)\s*$/.exec(line);
    if (match?.[1] && match[2]) mounts.set(match[2], Number(match[1]));
  }
  if (mounts.size === 0) return 'evidence_no_mounts';
  return { takenAt, host, threshold, mounts, raw: df };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decideDiskAlert(
  row: { id: string; body: string },
  evidence: DiskEvidence
): { note: string } | { reason: string } {
  if (!row.body.includes(evidence.host)) return { reason: 'host_mismatch' };
  const mountMatch = new RegExp(`${escapeRegExp(evidence.host)}\\s+(\\/\\S*)`).exec(row.body);
  const mount = mountMatch?.[1] ?? '/';
  const percent = evidence.mounts.get(mount);
  if (percent === undefined) return { reason: `mount_not_in_reading:${mount}` };
  if (percent >= evidence.threshold) return { reason: `above_threshold:${String(percent)}%` };
  return {
    note: JSON.stringify({
      reason: 'disk_alert_resolved',
      wo: WO_ID,
      host: evidence.host,
      mount,
      use_percent: `${String(percent)}%`,
      threshold_percent: evidence.threshold,
      taken_at: new Date(evidence.takenAt).toISOString(),
      df: evidence.raw,
    }),
  };
}

async function buildPlan(query: DispatchQueryExecutor, args: Args, now: Date): Promise<Plan> {
  const recipient = args.recipient;
  const schema = await checkSchema(query);

  const addressed = await query<{ id: string; r: string }>(
    `SELECT id, ${RECIPIENT_EXPRESSION} AS r FROM agent_dispatch_messages
     WHERE status = 'queued' AND addressed_at IS NOT NULL AND ${NOT_PROTECTED}
     ORDER BY id`
  );
  const backfillAll: Record<string, number> = {};
  const backfill: string[] = [];
  for (const row of addressed.rows) {
    backfillAll[row.r] = (backfillAll[row.r] ?? 0) + 1;
    if (row.r === recipient) backfill.push(row.id);
  }

  const open = (
    await query<OpenRow>(
      `SELECT id, sender, sender_principal_id, recipient, subject_key, correlation_id, created_at,
              priority, substr(body, 1, 200) AS head
       FROM agent_dispatch_messages
       WHERE ${RECIPIENT_EXPRESSION} = $1 AND ${OPEN}
       ORDER BY created_at ASC, COALESCE(seq, rowid) ASC`,
      [recipient]
    )
  ).rows;

  const k1: SupersedePair[] = [];
  const k2: SupersedePair[] = [];
  const senders = new Set<string>();
  if (await isMailboxPrincipal(query, recipient)) {
    const groups = new Map<string, OpenRow[]>();
    for (const row of open) {
      const principal = row.sender_principal_id ?? '';
      if (!principal.startsWith('system:')) continue;
      if (PROTECTED_SENDERS.includes(row.sender) || PROTECTED_SENDERS.includes(principal)) continue;
      const key = [row.recipient, principal, row.subject_key ?? `corr:${row.correlation_id}`].join(
        '\n'
      );
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      // Priority-safe, as at runtime: a row is folded only into the newest later row of the same
      // or a higher priority, which itself stays open (every row after it ranks strictly lower).
      // An older blocker followed only by normal rows stays open.
      rows.forEach((older, index) => {
        let newer: OpenRow | undefined;
        for (const candidate of rows.slice(index + 1)) {
          if (rankOf(candidate.priority) <= rankOf(older.priority)) newer = candidate;
        }
        if (!newer) return;
        const pair = { older: older.id, newer: newer.id };
        if (newer.sender_principal_id === 'system:dispatch') k1.push(pair);
        else k2.push(pair);
        senders.add(newer.sender_principal_id ?? '');
      });
    }
  }

  const diskRows = (
    await query<{ id: string; body: string }>(
      `SELECT id, substr(body, 1, 2000) AS body FROM agent_dispatch_messages
       WHERE ${RECIPIENT_EXPRESSION} = $1 AND ${OPEN} AND sender = 'xo'
         AND body LIKE 'DISK ALERT%' AND ${NOT_PROTECTED}
       ORDER BY id`,
      [recipient]
    )
  ).rows;
  const evidence = readEvidence(args.evidenceFile, now);
  const k3: DiskDecision[] = [];
  const k3LeftOpen: { id: string; reason: string }[] = [];
  const k3Refusal = typeof evidence === 'string' && diskRows.length > 0 ? evidence : null;
  for (const row of diskRows) {
    if (typeof evidence === 'string') {
      k3LeftOpen.push({ id: row.id, reason: evidence });
      continue;
    }
    const decision = decideDiskAlert(row, evidence);
    if ('note' in decision) k3.push({ id: row.id, note: decision.note });
    else k3LeftOpen.push({ id: row.id, reason: decision.reason });
  }

  const k4 = (
    await query<{ id: string }>(
      `SELECT id FROM agent_dispatch_messages
       WHERE ${RECIPIENT_EXPRESSION} = $1 AND ${OPEN} AND NOT (${NOT_PROTECTED})
       ORDER BY id`,
      [recipient]
    )
  ).rows.map(row => row.id);

  const k5 = (
    await query<{
      id: string;
      sender: string;
      subject_key: string | null;
      correlation_id: string;
      bytes: number | string;
    }>(
      `SELECT id, sender, subject_key, correlation_id, length(CAST(body AS BLOB)) AS bytes
       FROM agent_dispatch_messages
       WHERE ${RECIPIENT_EXPRESSION} = $1 AND length(CAST(body AS BLOB)) > $2 AND ${NOT_PROTECTED}
       ORDER BY id`,
      [recipient, LARGE_BODY_BYTES]
    )
  ).rows.map(row => ({
    id: row.id,
    sender: row.sender,
    subject: row.subject_key ?? row.correlation_id,
    bytes: Number(row.bytes),
  }));

  const retired = new Set([...k1, ...k2].map(pair => pair.older));
  for (const item of k3) retired.add(item.id);
  const openAfter = open.filter(row => !retired.has(row.id));
  const exhaustedSubjectless = openAfter.filter(
    row => row.subject_key === null && row.head.startsWith('Taskmaster expectation EXHAUSTED')
  ).length;

  return {
    recipient,
    schemaOk: schema.ok,
    schemaDetail: schema.detail,
    backfillAll,
    backfill,
    k1,
    k2,
    collapseSenders: [...senders].sort(),
    k3,
    k3Refusal,
    k3LeftOpen,
    k4,
    k5,
    exhaustedSubjectless,
    openAfter,
  };
}

function printPlan(plan: Plan, mode: string, out: (line: string) => void): void {
  out(`mailbox-lifecycle ${WO_ID} mode=${mode} recipient=${plan.recipient}`);
  out(`schema: ${plan.schemaDetail}`);
  const all = Object.entries(plan.backfillAll)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recipient, count]) => `${recipient}=${String(count)}`);
  out(`backfill_all_recipients: ${all.length ? all.join(' ') : '(none)'}`);
  for (const name of MUTATING_CLASSES) {
    const ids = classIds(plan, name);
    out(`class ${name}: count=${String(ids.length)} ids=${ids.join(',')}`);
    if (name === 'k1_collapse_dispatch' || name === 'k2_collapse_system') {
      const pairs = name === 'k1_collapse_dispatch' ? plan.k1 : plan.k2;
      for (const pair of pairs) out(`  supersede ${pair.older} -> ${pair.newer}`);
    }
  }
  out(
    `collapse_system_senders: ${plan.collapseSenders.length ? plan.collapseSenders.join(', ') : '(none)'}`
  );
  if (plan.k3Refusal) out(`k3_refused: ${plan.k3Refusal}`);
  if (plan.k3LeftOpen.length) {
    out(`k3_left_open: ${plan.k3LeftOpen.map(item => `${item.id} (${item.reason})`).join(', ')}`);
  }
  out(`protected k4_customer: count=${String(plan.k4.length)} ids=${plan.k4.join(',')}`);
  out(`k5_bytes: ${plan.k5.map(item => `${item.id}=${String(item.bytes)}`).join(',')}`);
  out(`exhausted_subjectless_uncollapsed: ${String(plan.exhaustedSubjectless)}`);
  const subjects = new Set(
    plan.openAfter.map(row => row.subject_key ?? `corr:${row.correlation_id}`)
  );
  out(
    `open_after: rows=${String(plan.openAfter.length)} distinct_subjects=${String(subjects.size)}`
  );
  out(
    `open_count_sql: SELECT COUNT(*) FROM agent_dispatch_messages WHERE ${RECIPIENT_EXPRESSION} = '${plan.recipient}' AND status = 'queued' AND addressed_at IS NULL AND route_disposition IS NULL`
  );
  out(`confirm_token: ${confirmToken(plan)}`);
}

interface ExportedBody {
  id: string;
  file: string;
  sender: string;
  subject: string | null;
  bytes: number;
  sha256: string;
}

/** Export every large body and verify it on disk BEFORE any class mutates. */
async function exportLargeBodies(
  query: DispatchQueryExecutor,
  plan: Plan,
  outDir: string
): Promise<ExportedBody[]> {
  if (plan.k5.length === 0) return [];
  mkdirSync(outDir, { recursive: true });
  const exported: ExportedBody[] = [];
  for (const item of plan.k5) {
    if (!/^[A-Za-z0-9._-]+$/.test(item.id)) throw new Error(`unsafe_row_id:${item.id}`);
    const result = await query<{ body: string }>(
      'SELECT body FROM agent_dispatch_messages WHERE id = $1',
      [item.id]
    );
    const body = result.rows[0]?.body;
    if (body === undefined) throw new Error(`row_missing:${item.id}`);
    const bytes = Buffer.from(body, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${item.id}.body`;
    writeFileSync(join(outDir, file), bytes);
    const reread = createHash('sha256')
      .update(readFileSync(join(outDir, file)))
      .digest('hex');
    if (reread !== sha256) throw new Error(`export_sha_mismatch:${item.id}`);
    exported.push({
      id: item.id,
      file,
      sender: item.sender,
      subject: item.subject,
      bytes: bytes.length,
      sha256,
    });
  }
  writeFileSync(
    join(outDir, 'large-bodies-manifest.json'),
    `${JSON.stringify(exported, null, 2)}\n`
  );
  return exported;
}

async function journal(
  query: DispatchQueryExecutor,
  name: MutatingClass,
  ids: string[],
  plan: Plan,
  token: string,
  now: Date
): Promise<void> {
  const key = `mailbox-lifecycle:${name}:${token}`;
  const existing = await query<{ id: string }>(
    'SELECT id FROM tm_journal WHERE idempotency_key = $1',
    [key]
  );
  if (existing.rows.length > 0) throw new Refusal(2, `already_executed:${key}`);
  await query(
    `INSERT INTO tm_journal
       (id, created_at, thread_ref, action_type, proposal_json, idempotency_key, outcome)
     VALUES ($1, $2, $3, 'digest', $4, $5, 'expired')`,
    [
      randomUUID(),
      now.toISOString(),
      `mailbox-lifecycle:${plan.recipient}`,
      JSON.stringify({
        wo: WO_ID,
        note: `${WO_ID} one-time mailbox cleanup, class ${name}, recipient ${plan.recipient}. Run on the acting XO's confirmation of the dry run.`,
        class: name,
        recipient: plan.recipient,
        actor: MACHINE_ACTOR,
        count: ids.length,
        first_id: ids[0] ?? null,
        last_id: ids[ids.length - 1] ?? null,
        ids,
        confirm_token: token,
      }),
      key,
    ]
  );
}

async function runClass(
  db: LifecycleDb,
  name: MutatingClass,
  plan: Plan,
  token: string,
  now: Date,
  exported: ExportedBody[]
): Promise<number> {
  const ids = classIds(plan, name);
  if (ids.length === 0) return 0;
  await db.withTransaction(
    async query => {
      if (name === 'backfill') {
        const update = await query(
          `UPDATE agent_dispatch_messages
           SET status = 'done', completed_at = addressed_at
           WHERE id IN (SELECT value FROM json_each($1))
             AND status = 'queued' AND addressed_at IS NOT NULL AND ${NOT_PROTECTED}`,
          [JSON.stringify(ids)]
        );
        if (update.rowCount !== ids.length) throw new Error('backfill_count_mismatch');
      } else if (name === 'k1_collapse_dispatch' || name === 'k2_collapse_system') {
        const pairs = name === 'k1_collapse_dispatch' ? plan.k1 : plan.k2;
        for (const pair of pairs) {
          const done = await supersedeRepeatByNewer(
            { older_id: pair.older, newer_id: pair.newer, actor: MACHINE_ACTOR },
            query
          );
          if (!done) throw new Error(`supersede_refused:${pair.older}`);
        }
      } else if (name === 'k3_disk_alerts') {
        for (const item of plan.k3) {
          const disposed = await disposeMessageByMachine(
            {
              id: item.id,
              actor: MACHINE_ACTOR,
              disposition: 'expired',
              requireNoReceipt: true,
              note: item.note,
            },
            query
          );
          if (!disposed.ok) throw new Error(`expire_refused:${item.id}:${disposed.reason}`);
        }
      } else {
        for (const item of exported) {
          const current = await query<{ body: string }>(
            'SELECT body FROM agent_dispatch_messages WHERE id = $1',
            [item.id]
          );
          const body = current.rows[0]?.body ?? '';
          const sha = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
          if (sha !== item.sha256) throw new Error(`body_changed_since_export:${item.id}`);
          const stub = JSON.stringify({
            archived_to: item.file,
            sha256: item.sha256,
            bytes: item.bytes,
          });
          const update = await query('UPDATE agent_dispatch_messages SET body = $2 WHERE id = $1', [
            item.id,
            stub,
          ]);
          if (update.rowCount !== 1) throw new Error(`stub_failed:${item.id}`);
        }
      }
      await journal(query, name, ids, plan, token, now);
    },
    { immediate: true }
  );
  return ids.length;
}

interface IssueInfo {
  state: string;
  priority: string;
  owner: string;
}

async function readIssue(
  subject: string,
  options: MailboxLifecycleOptions,
  enabled: boolean
): Promise<IssueInfo> {
  const unknown = { state: 'unknown', priority: 'unknown', owner: 'unknown' };
  if (!enabled) return unknown;
  const match = /^gh:([^/]+)\/([^#]+)#(\d+)$/.exec(subject);
  const env = options.env ?? process.env;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (!match || !token) return unknown;
  try {
    const response = await (options.fetch ?? fetch)(
      `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[3]}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) return unknown;
    const issue = (await response.json()) as { state?: string; labels?: { name?: string }[] };
    const labels = (issue.labels ?? []).map(label => label.name ?? '');
    return {
      state: issue.state ?? 'unknown',
      priority: labels.find(label => /^(prio|priority):/i.test(label)) ?? 'none',
      owner: labels.find(label => /^owner:/i.test(label)) ?? 'none',
    };
  } catch {
    return unknown;
  }
}

async function writeOpenWork(
  query: DispatchQueryExecutor,
  args: Args,
  outDir: string,
  options: MailboxLifecycleOptions
): Promise<string> {
  const rows = (
    await query<OpenRow>(
      `SELECT id, sender, sender_principal_id, recipient, subject_key, correlation_id, created_at,
              substr(body, 1, 120) AS head
       FROM agent_dispatch_messages
       WHERE ${RECIPIENT_EXPRESSION} = $1 AND ${OPEN}
       ORDER BY created_at ASC`,
      [args.recipient]
    )
  ).rows;
  const bySubject = new Map<string, OpenRow[]>();
  const other: OpenRow[] = [];
  for (const row of rows) {
    if (row.subject_key?.startsWith('gh:')) {
      bySubject.set(row.subject_key, [...(bySubject.get(row.subject_key) ?? []), row]);
    } else other.push(row);
  }
  const lines = [
    `# Open ${args.recipient} mailbox work after ${WO_ID} (for Taskmaster and the arc owners).`,
    '# subject | open_rows | issue_state | priority_label | owner_label | newest_id | senders',
  ];
  for (const [subject, group] of [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const info = await readIssue(subject, options, args.github);
    const newest = group[group.length - 1];
    const senders = [...new Set(group.map(row => row.sender))].sort().join(',');
    lines.push(
      `${subject} | ${String(group.length)} | ${info.state} | ${info.priority} | ${info.owner} | ${newest?.id ?? ''} | ${senders}`
    );
  }
  for (const row of other) {
    const head = row.head.replace(/\s+/g, ' ').slice(0, 80);
    lines.push(
      `(no gh subject) ${row.id} | sender=${row.sender} | subject=${row.subject_key ?? 'none'} | ${head}`
    );
  }
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `open-work-${args.recipient}.txt`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

export async function runMailboxLifecycle(
  argv: string[],
  options: MailboxLifecycleOptions = {}
): Promise<{ code: number; token: string | null }> {
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
  const now = (options.now ?? ((): Date => new Date()))();
  try {
    const args = parseArgs(argv);
    const db = options.db ?? (getDatabase() as unknown as LifecycleDb);
    if (db.dialect !== 'sqlite') throw new Refusal(2, 'sqlite_only');
    const query: DispatchQueryExecutor = (sql, params) => db.query(sql, params);
    const plan = await buildPlan(query, args, now);
    const token = confirmToken(plan);
    printPlan(plan, args.execute ? 'execute' : 'dry-run', out);
    if (!args.execute) return { code: 0, token };

    if (!args.confirm) throw new Refusal(2, 'confirm_token_required');
    if (args.confirm !== token) throw new Refusal(2, 'confirm_token_mismatch');
    if (!plan.schemaOk) throw new Refusal(2, `schema_check_failed:${plan.schemaDetail}`);
    if (!args.outDir) throw new Refusal(2, 'out_dir_required');

    let exported: ExportedBody[];
    try {
      exported = await exportLargeBodies(query, plan, args.outDir);
    } catch (error) {
      err(`k5_export_failed: ${(error as Error).message}; nothing was changed`);
      return { code: 1, token };
    }

    const done: string[] = [];
    for (const name of MUTATING_CLASSES) {
      const count = await runClass(db, name, plan, token, now, exported);
      done.push(`${name}=${String(count)}`);
    }
    out(`executed: ${done.join(' ')}`);
    out(`open_work_list: ${await writeOpenWork(query, args, args.outDir, options)}`);
    return { code: 0, token };
  } catch (error) {
    if (error instanceof Refusal) {
      err(`refused: ${error.message}`);
      return { code: error.code, token: null };
    }
    err(`failed: ${(error as Error).message}`);
    return { code: 1, token: null };
  }
}

async function main(): Promise<void> {
  const result = await runMailboxLifecycle(process.argv.slice(2));
  process.exitCode = result.code;
}

if (import.meta.main) {
  main()
    .then(async () => {
      await closeDatabase();
    })
    .catch(async (error: unknown) => {
      console.error('mailbox-lifecycle failed:', error);
      await closeDatabase();
      process.exitCode = 1;
    });
}
