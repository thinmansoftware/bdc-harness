/**
 * Dispatch inbox reader (WO-HARNESS-DISPATCH-INBOX-READER-01).
 *
 * An unattended, deterministic reader over the `xo` mailbox (and, when switched
 * on, `operator`). Every run classifies each open message, writes a persisted
 * digest the XO reads at session start, and -- only in enforce mode -- retires
 * provably-informational and collapsed-reminder rows by MACHINE DISPOSITION
 * ('expired') and nothing else. Every message that could need a human is left
 * untouched and listed. Stale actionable mail and a stopped reader raise alert
 * rows.
 *
 * The scheduler skeleton (module-singleton timer, inFlight guard, env interval
 * with 0 = off, unref, immediate first tick) mirrors operator-inbox-consumer.ts.
 * Worker registration + per-run heartbeat mirror duty-officer-clock.ts so the
 * existing worker-heartbeat alarm can watch this reader.
 *
 * The read-before-dispose prohibitions this reader operates under (it never
 * writes a human receipt and never retracts a message) are documented in
 * docs/dispatch-receipts.md ("Inbox reader"), not in this source.
 */
import { createHash } from 'crypto';
import { open, mkdir, rename, readFile, appendFile, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import {
  disposeMessageByMachine,
  heartbeatWorker,
  listMessages,
  registerWorker,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import { createLogger, getArchonHome } from '@archon/paths';
import {
  classifyInboxMessage,
  type InboxClass,
  type InboxClassification,
  type InboxClassifierInput,
} from './inbox-reader-rules';
import type { SurfaceEntry } from './operator-inbox-consumer';

const log = createLogger('dispatch/inbox-reader');

export const INBOX_READER_WORKER_ID = 'inbox-reader';
export const INBOX_READER_ACTOR = 'system:inbox-reader';

export const DEFAULT_INBOX_READER_INTERVAL_MS = 300_000;
const DEFAULT_MAX_PER_RUN = 500;
const MIN_AGE_FLOOR_MS = 600_000;
const DEFAULT_MIN_AGE_MS = 600_000;

/** Maps a rule_id to its spec R-label for the disposal reason string. */
const RULE_LABELS: Record<string, string> = {
  info_review_posted: 'R1',
  info_submit_intermediate: 'R2',
  info_ingest_receipt: 'R3',
  nudge_taskmaster_daily: 'R4',
  nudge_duty_officer_pass: 'R5',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type InboxReaderMode = 'dry-run' | 'enforce';
export type InboxReaderOperatorOwner = 'consumer' | 'reader';

export interface InboxReaderConfig {
  intervalMs: number;
  mode: InboxReaderMode;
  maxPerRun: number;
  minAgeMs: number;
  operatorOwner: InboxReaderOperatorOwner;
  recipients: string[];
  actionableAlertHours: number;
  gapAlertHours: number;
  alertRepeatHours: number;
  retentionDays: number;
}

function parseIntegerEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parsePositiveNumberEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Pure config resolver (Section 4b). Invalid values fall back to the default. */
export function resolveInboxReaderConfig(env: NodeJS.ProcessEnv): InboxReaderConfig {
  const rawInterval = env.INBOX_READER_INTERVAL_MS;
  const parsedInterval = Number.parseInt(rawInterval ?? '', 10);
  const intervalMs =
    Number.isInteger(parsedInterval) && parsedInterval >= 0
      ? parsedInterval
      : DEFAULT_INBOX_READER_INTERVAL_MS;

  const mode: InboxReaderMode = env.INBOX_READER_MODE === 'enforce' ? 'enforce' : 'dry-run';
  if (env.INBOX_READER_MODE !== undefined && env.INBOX_READER_MODE !== 'enforce') {
    log.warn({ value: env.INBOX_READER_MODE }, 'inbox_reader.mode_not_enforce_defaulting_dry_run');
  }

  const maxPerRun = Math.max(
    1,
    Math.min(parseIntegerEnv(env.INBOX_READER_MAX_PER_RUN, DEFAULT_MAX_PER_RUN), 500)
  );
  const minAgeMs = Math.max(
    MIN_AGE_FLOOR_MS,
    parseIntegerEnv(env.INBOX_READER_MIN_AGE_MS, DEFAULT_MIN_AGE_MS)
  );

  const operatorOwner: InboxReaderOperatorOwner =
    env.INBOX_READER_OPERATOR_OWNER === 'reader' ? 'reader' : 'consumer';
  const recipients = operatorOwner === 'reader' ? ['xo', 'operator'] : ['xo'];

  return {
    intervalMs,
    mode,
    maxPerRun,
    minAgeMs,
    operatorOwner,
    recipients,
    actionableAlertHours: parsePositiveNumberEnv(env.INBOX_READER_ACTIONABLE_ALERT_HOURS, 24),
    gapAlertHours: parsePositiveNumberEnv(env.INBOX_READER_GAP_ALERT_HOURS, 2),
    alertRepeatHours: parsePositiveNumberEnv(env.INBOX_READER_ALERT_REPEAT_HOURS, 6),
    retentionDays: Math.max(1, parseIntegerEnv(env.INBOX_READER_RETENTION_DAYS, 14)),
  };
}

/**
 * The existing operator-inbox-consumer must NOT start when the reader owns the
 * operator mailbox. Only the exact literal 'reader' hands over.
 */
export function shouldStartOperatorInboxConsumer(env: NodeJS.ProcessEnv): boolean {
  return resolveInboxReaderConfig(env).operatorOwner !== 'reader';
}

// ---------------------------------------------------------------------------
// Digest and alert shapes
// ---------------------------------------------------------------------------

export interface RecipientCounts {
  listed: number;
  INFO_DUPLICATE: number;
  NUDGE: number;
  ACTIONABLE: number;
  too_young: number;
  acked_open: number;
  skipped: number;
}

export interface ActionableEntry {
  id: string;
  recipient: string;
  sender: string;
  task_type: string;
  priority: string;
  subject_key: string | null;
  created_at: string;
  age_hours: number;
  rule_id: string;
  reason: string;
  excerpt: string;
}

export interface NudgeGroup {
  recipient: string;
  collapse_key: string;
  count: number;
  newest_created_at: string;
  oldest_created_at: string;
  ids: string[];
}

export interface DisposalPlanEntry {
  id: string;
  recipient: string;
  rule_id: string;
  reason: string;
}

export interface DisposalResultEntry {
  id: string;
  ok: boolean;
  reason: string | null;
}

export interface AlertRow {
  at: string;
  kind: string;
  recipient: string | null;
  count: number;
  oldest_created_at: string | null;
  ids: string[];
  detail: string;
}

export interface InboxDigest {
  run_id: string;
  started_at: string;
  finished_at: string;
  mode: InboxReaderMode;
  recipients: string[];
  operator_owner: InboxReaderOperatorOwner;
  counts: Record<string, RecipientCounts>;
  counts_by_rule: Record<string, number>;
  actionable: ActionableEntry[];
  nudges: NudgeGroup[];
  disposal_plan: DisposalPlanEntry[];
  disposal_results: DisposalResultEntry[];
  alerts: AlertRow[];
  content_hash: string;
  run_file: string | null;
  disposal_summary: { disposed: number; skipped_race: number; errors: number };
}

export interface InboxReaderRunResult {
  runId: string;
  digest: InboxDigest | null;
  digestWriteFailed: boolean;
  listErrors: string[];
  disposalErrors: string[];
  skippedRace: number;
  alertsWritten: AlertRow[];
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface InboxReaderDeps {
  listMessages: (filters: {
    recipient: string;
    status: 'queued';
    limit: number;
  }) => Promise<InboxClassifierInput[]>;
  disposeMessageByMachine: (data: {
    id: string;
    actor: string;
    disposition: 'expired';
    requireNoReceipt: boolean;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  heartbeatWorker: (data: { worker_id: string }) => Promise<unknown>;
  now: () => Date;
  rootDir: string;
  fs: InboxReaderFs;
}

export interface InboxReaderFs {
  writeFileAtomic: (path: string, contents: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  appendLine: (path: string, line: string) => Promise<void>;
  ensureDir: (path: string) => Promise<void>;
  listDir: (path: string) => Promise<string[]>;
  removeFile: (path: string) => Promise<void>;
}

/** Default filesystem: tmp + fsync + rename for durable atomic writes. */
export function defaultInboxReaderFs(): InboxReaderFs {
  return {
    writeFileAtomic: async (path: string, contents: string): Promise<void> => {
      const tmp = `${path}.tmp`;
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    },
    readFile: (path: string): Promise<string> => readFile(path, 'utf8'),
    appendLine: (path: string, line: string): Promise<void> =>
      appendFile(path, `${line}\n`, 'utf8'),
    ensureDir: async (path: string): Promise<void> => {
      await mkdir(path, { recursive: true });
    },
    listDir: async (path: string): Promise<string[]> => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    removeFile: async (path: string): Promise<void> => {
      try {
        await unlink(path);
      } catch {
        // Best-effort prune; a missing file is not an error.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Reader state (bookkeeping)
// ---------------------------------------------------------------------------

interface ReaderState {
  last_run_at: string | null;
  content_hash: string | null;
  last_run_file: string | null;
  alerts: Record<string, string>;
}

function emptyState(): ReaderState {
  return { last_run_at: null, content_hash: null, last_run_file: null, alerts: {} };
}

function statePath(rootDir: string): string {
  return join(rootDir, 'state.json');
}

async function readState(deps: InboxReaderDeps): Promise<ReaderState> {
  try {
    const raw = await deps.fs.readFile(statePath(deps.rootDir));
    const parsed = JSON.parse(raw) as Partial<ReaderState>;
    return {
      last_run_at: typeof parsed.last_run_at === 'string' ? parsed.last_run_at : null,
      content_hash: typeof parsed.content_hash === 'string' ? parsed.content_hash : null,
      last_run_file: typeof parsed.last_run_file === 'string' ? parsed.last_run_file : null,
      alerts: parsed.alerts && typeof parsed.alerts === 'object' ? parsed.alerts : {},
    };
  } catch {
    return emptyState();
  }
}

// ---------------------------------------------------------------------------
// Digest helpers
// ---------------------------------------------------------------------------

function emptyCounts(): RecipientCounts {
  return {
    listed: 0,
    INFO_DUPLICATE: 0,
    NUDGE: 0,
    ACTIONABLE: 0,
    too_young: 0,
    acked_open: 0,
    skipped: 0,
  };
}

function excerptOf(body: string): string {
  return body.slice(0, 200).replace(/[\r\n]+/g, ' ');
}

function ageHours(nowMs: number, createdAt: string): number {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, (nowMs - createdMs) / 3_600_000);
}

function disposalReason(classification: InboxClassification): string {
  const label = RULE_LABELS[classification.rule_id] ?? classification.rule_id;
  return `inbox-reader ${label} ${classification.rule_id}: ${classification.reason}`;
}

function computeContentHash(
  classified: { id: string; class: InboxClass; rule_id: string }[],
  plan: DisposalPlanEntry[]
): string {
  const parts = classified.map(c => `${c.id}:${c.class}:${c.rule_id}`).sort();
  const planIds = plan.map(p => p.id).sort();
  return createHash('sha256').update(JSON.stringify({ parts, planIds })).digest('hex');
}

function tsForFileName(iso: string): string {
  // yyyymmddThhmmssZ from an ISO instant (no punctuation, no millis).
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

// ---------------------------------------------------------------------------
// latest.md rendering
// ---------------------------------------------------------------------------

function renderLatestMarkdown(digest: InboxDigest): string {
  const lines: string[] = [];
  lines.push('# Dispatch inbox reader digest');
  lines.push('');
  lines.push(`- run_id: ${digest.run_id}`);
  lines.push(`- started_at: ${digest.started_at}`);
  lines.push(`- finished_at: ${digest.finished_at}`);
  lines.push(`- mode: ${digest.mode}`);
  lines.push(`- operator_owner: ${digest.operator_owner}`);
  lines.push(`- recipients: ${digest.recipients.join(', ')}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push(
    '| recipient | listed | INFO_DUPLICATE | NUDGE | ACTIONABLE | too_young | acked_open | skipped |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const recipient of digest.recipients) {
    const c = digest.counts[recipient] ?? emptyCounts();
    lines.push(
      `| ${recipient} | ${c.listed} | ${c.INFO_DUPLICATE} | ${c.NUDGE} | ${c.ACTIONABLE} | ${c.too_young} | ${c.acked_open} | ${c.skipped} |`
    );
  }
  lines.push('');
  lines.push('## Actionable');
  lines.push('');
  if (digest.actionable.length === 0) {
    lines.push('_none_');
  } else {
    const grouped = new Map<string, ActionableEntry[]>();
    for (const entry of digest.actionable) {
      const key = entry.subject_key ?? '(no subject_key)';
      const bucket = grouped.get(key);
      if (bucket) bucket.push(entry);
      else grouped.set(key, [entry]);
    }
    for (const [subjectKey, entries] of grouped) {
      if (entries.length >= 2) lines.push(`### ${subjectKey}`);
      for (const entry of entries) {
        lines.push(
          `- \`${entry.id}\` [${entry.recipient}] ${entry.sender}/${entry.task_type} (${entry.rule_id}, ${entry.age_hours.toFixed(1)}h): ${entry.excerpt}`
        );
      }
    }
  }
  lines.push('');
  lines.push('## Nudges');
  lines.push('');
  if (digest.nudges.length === 0) {
    lines.push('_none_');
  } else {
    for (const nudge of digest.nudges) {
      lines.push(`- ${nudge.collapse_key} x${nudge.count} (newest ${nudge.newest_created_at})`);
    }
  }
  lines.push('');
  lines.push('## Alerts');
  lines.push('');
  if (digest.alerts.length === 0) {
    lines.push('_none_');
  } else {
    for (const alert of digest.alerts) {
      lines.push(
        `- ${alert.kind} [${alert.recipient ?? 'all'}] count=${alert.count}: ${alert.detail}`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

interface ClassifiedRow {
  row: InboxClassifierInput;
  classification: InboxClassification;
}

export async function runInboxReader(
  deps: InboxReaderDeps,
  config: InboxReaderConfig
): Promise<InboxReaderRunResult> {
  const startedAt = deps.now().toISOString();
  const runId = createHash('sha256')
    .update(`${startedAt}:${config.recipients.join(',')}`)
    .digest('hex')
    .slice(0, 16);

  const result: InboxReaderRunResult = {
    runId,
    digest: null,
    digestWriteFailed: false,
    listErrors: [],
    disposalErrors: [],
    skippedRace: 0,
    alertsWritten: [],
  };

  try {
    await deps.fs.ensureDir(deps.rootDir);

    const state = await readState(deps);
    const counts: Record<string, RecipientCounts> = {};
    const countsByRule: Record<string, number> = {};
    const classifiedAll: ClassifiedRow[] = [];
    const actionable: ActionableEntry[] = [];
    const disposalPlan: DisposalPlanEntry[] = [];
    const nudgeRows: { recipient: string; collapseKey: string; row: InboxClassifierInput }[] = [];
    // Track per-recipient full-page state for page_not_advancing.
    const recipientListInfo: { recipient: string; limitPassed: number; returned: number }[] = [];
    // ACTIONABLE rows per recipient for the stale alert.
    const staleByRecipient: Record<string, { ids: string[]; oldest: string | null }> = {};

    const nowMs = deps.now().getTime();
    let remaining = config.maxPerRun;

    for (const recipient of config.recipients) {
      if (remaining <= 0) break;
      const limitPassed = remaining;
      let rows: InboxClassifierInput[];
      try {
        rows = await deps.listMessages({ recipient, status: 'queued', limit: limitPassed });
      } catch (error) {
        const err = error as Error;
        result.listErrors.push(`${recipient}:${err.message}`);
        log.error({ err, recipient }, 'inbox_reader.list_failed');
        continue;
      }
      remaining -= rows.length;
      recipientListInfo.push({ recipient, limitPassed, returned: rows.length });

      const rc = counts[recipient] ?? emptyCounts();
      counts[recipient] = rc;
      rc.listed += rows.length;

      for (const row of rows) {
        // Defensive: listMessages already excludes these.
        if (
          row.status !== 'queued' ||
          row.route_disposition !== null ||
          row.addressed_at !== null
        ) {
          rc.skipped += 1;
          continue;
        }
        const classification = classifyInboxMessage(row);
        classifiedAll.push({ row, classification });
        countsByRule[classification.rule_id] = (countsByRule[classification.rule_id] ?? 0) + 1;
        rc[classification.class] += 1;

        if (classification.class === 'ACTIONABLE') {
          actionable.push({
            id: row.id,
            recipient,
            sender: row.sender,
            task_type: row.task_type,
            priority: row.priority ?? 'normal',
            subject_key: row.subject_key,
            created_at: row.created_at,
            age_hours: Number(ageHours(nowMs, row.created_at).toFixed(2)),
            rule_id: classification.rule_id,
            reason: classification.reason,
            excerpt: excerptOf(row.body),
          });
          if (
            row.acknowledged_at === null &&
            ageHours(nowMs, row.created_at) > config.actionableAlertHours
          ) {
            const bucket = staleByRecipient[recipient] ?? { ids: [], oldest: null };
            bucket.ids.push(row.id);
            if (bucket.oldest === null || Date.parse(row.created_at) < Date.parse(bucket.oldest)) {
              bucket.oldest = row.created_at;
            }
            staleByRecipient[recipient] = bucket;
          }
          continue;
        }

        // INFO_DUPLICATE or NUDGE.
        if (classification.class === 'NUDGE') {
          nudgeRows.push({
            recipient,
            collapseKey: classification.collapse_key ?? 'nudge',
            row,
          });
        }

        if (row.acknowledged_at !== null) {
          rc.acked_open += 1;
          continue;
        }
        if (nowMs - Date.parse(row.created_at) < config.minAgeMs) {
          rc.too_young += 1;
          continue;
        }
        // Eligible for disposal.
        disposalPlan.push({
          id: row.id,
          recipient,
          rule_id: classification.rule_id,
          reason: disposalReason(classification),
        });
      }
    }

    // Nudge grouping.
    const nudgeGroups = new Map<string, NudgeGroup>();
    for (const { recipient, collapseKey, row } of nudgeRows) {
      const key = `${recipient}::${collapseKey}`;
      const existing = nudgeGroups.get(key);
      if (existing) {
        existing.count += 1;
        existing.ids.push(row.id);
        if (Date.parse(row.created_at) > Date.parse(existing.newest_created_at)) {
          existing.newest_created_at = row.created_at;
        }
        if (Date.parse(row.created_at) < Date.parse(existing.oldest_created_at)) {
          existing.oldest_created_at = row.created_at;
        }
      } else {
        nudgeGroups.set(key, {
          recipient,
          collapse_key: collapseKey,
          count: 1,
          newest_created_at: row.created_at,
          oldest_created_at: row.created_at,
          ids: [row.id],
        });
      }
    }
    const nudges = [...nudgeGroups.values()];

    const contentHash = computeContentHash(
      classifiedAll.map(c => ({
        id: c.row.id,
        class: c.classification.class,
        rule_id: c.classification.rule_id,
      })),
      disposalPlan
    );

    // Early alerts (do not depend on dispose): actionable_stale, reader_gap,
    // and page_not_advancing when the mode is dry-run.
    const earlyAlerts: AlertRow[] = [];
    for (const [recipient, bucket] of Object.entries(staleByRecipient)) {
      earlyAlerts.push({
        at: startedAt,
        kind: 'actionable_stale',
        recipient,
        count: bucket.ids.length,
        oldest_created_at: bucket.oldest,
        ids: bucket.ids.slice(0, 50),
        detail: `${bucket.ids.length} unacked ACTIONABLE row(s) older than ${config.actionableAlertHours}h for ${recipient}`,
      });
    }
    if (state.last_run_at !== null) {
      const gapHours = (Date.parse(startedAt) - Date.parse(state.last_run_at)) / 3_600_000;
      if (gapHours > config.gapAlertHours) {
        earlyAlerts.push({
          at: startedAt,
          kind: 'reader_gap',
          recipient: null,
          count: 1,
          oldest_created_at: state.last_run_at,
          ids: [],
          detail: `reader last ran ${gapHours.toFixed(1)}h ago (> ${config.gapAlertHours}h)`,
        });
      }
    }
    if (config.mode === 'dry-run') {
      for (const info of recipientListInfo) {
        if (info.returned === info.limitPassed) {
          earlyAlerts.push(
            pageNotAdvancingAlert(startedAt, info.recipient, 'dry-run', counts[info.recipient])
          );
        }
      }
    }

    const finishedAtPre = deps.now().toISOString();
    const digest: InboxDigest = {
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAtPre,
      mode: config.mode,
      recipients: config.recipients,
      operator_owner: config.operatorOwner,
      counts,
      counts_by_rule: countsByRule,
      actionable,
      nudges,
      disposal_plan: disposalPlan,
      disposal_results: [],
      alerts: earlyAlerts,
      content_hash: contentHash,
      run_file: null,
      disposal_summary: { disposed: 0, skipped_race: 0, errors: 0 },
    };

    const runFileName = `${tsForFileName(startedAt)}-${runId}.json`;
    const runFilePath = join(deps.rootDir, 'runs', runFileName);
    const dispositionsWillHappen = config.mode === 'enforce' && disposalPlan.length > 0;
    const hashChanged = contentHash !== state.content_hash;
    const runFileNeededFirst = dispositionsWillHappen || hashChanged || earlyAlerts.length > 0;
    if (runFileNeededFirst) digest.run_file = runFileName;

    // Persist (write protocol) + read-back BEFORE any disposition.
    try {
      await writeDigest(deps, digest, { runFileName: runFileNeededFirst ? runFilePath : null });
      await verifyDigestReadBack(deps, digest, runFileNeededFirst ? runFilePath : null);
    } catch (error) {
      const err = error as Error;
      result.digestWriteFailed = true;
      result.digest = digest;
      log.error({ err, runId }, 'inbox_reader.digest_write_failed');
      return result;
    }

    // Disposition loop (enforce only).
    const disposalResults: DisposalResultEntry[] = [];
    const disposedOkByRecipient: Record<string, number> = {};
    if (config.mode === 'enforce') {
      let stopped = false;
      for (const entry of disposalPlan) {
        if (stopped) break;
        const outcome = await deps.disposeMessageByMachine({
          id: entry.id,
          actor: INBOX_READER_ACTOR,
          disposition: 'expired',
          requireNoReceipt: true,
        });
        if (outcome.ok) {
          disposalResults.push({ id: entry.id, ok: true, reason: null });
          disposedOkByRecipient[entry.recipient] =
            (disposedOkByRecipient[entry.recipient] ?? 0) + 1;
          digest.disposal_summary.disposed += 1;
          continue;
        }
        const reason = outcome.reason;
        disposalResults.push({ id: entry.id, ok: false, reason });
        if (
          reason === 'already_disposed' ||
          reason === 'not_found' ||
          reason === 'receipt_present'
        ) {
          result.skippedRace += 1;
          digest.disposal_summary.skipped_race += 1;
          continue;
        }
        if (reason === 'machine_actor_conflict') {
          result.disposalErrors.push(`${entry.id}:${reason}`);
          digest.disposal_summary.errors += 1;
          log.error(
            { messageId: entry.id, actor: INBOX_READER_ACTOR },
            'inbox_reader.machine_actor_conflict_stopping'
          );
          stopped = true;
          continue;
        }
        result.disposalErrors.push(`${entry.id}:${reason}`);
        digest.disposal_summary.errors += 1;
      }
    }

    // Late alert: page_not_advancing in enforce mode when a full page could not shrink.
    const lateAlerts: AlertRow[] = [];
    if (config.mode === 'enforce') {
      for (const info of recipientListInfo) {
        if (
          info.returned === info.limitPassed &&
          (disposedOkByRecipient[info.recipient] ?? 0) === 0
        ) {
          lateAlerts.push(
            pageNotAdvancingAlert(startedAt, info.recipient, 'enforce', counts[info.recipient])
          );
        }
      }
    }

    // Merge alerts, apply repeat suppression, and record which are written.
    const allAlerts = [...earlyAlerts, ...lateAlerts];
    const written: AlertRow[] = [];
    for (const alert of allAlerts) {
      const key = `${alert.kind}:${alert.recipient ?? ''}`;
      const lastAt = state.alerts[key];
      if (lastAt !== undefined) {
        const sinceHours = (Date.parse(startedAt) - Date.parse(lastAt)) / 3_600_000;
        if (sinceHours < config.alertRepeatHours) continue;
      }
      written.push(alert);
      state.alerts[key] = startedAt;
    }

    // Final digest write with disposal_results + written alerts.
    digest.finished_at = deps.now().toISOString();
    digest.disposal_results = disposalResults;
    digest.alerts = written;
    const runFileNeededFinal =
      (config.mode === 'enforce' && disposalPlan.length > 0) || written.length > 0 || hashChanged;
    digest.run_file = runFileNeededFinal ? runFileName : null;
    await writeDigest(deps, digest, { runFileName: runFileNeededFinal ? runFilePath : null });

    // Append written alerts to alerts.jsonl.
    for (const alert of written) {
      await deps.fs.appendLine(join(deps.rootDir, 'alerts.jsonl'), JSON.stringify(alert));
    }
    result.alertsWritten = written;

    // Persist state.
    await writeState(deps, {
      last_run_at: startedAt,
      content_hash: contentHash,
      last_run_file: runFileNeededFinal ? runFileName : state.last_run_file,
      alerts: state.alerts,
    });

    // Prune old run files.
    await pruneOldRunFiles(deps, config, nowMs);

    result.digest = digest;
    return result;
  } finally {
    try {
      await deps.heartbeatWorker({ worker_id: INBOX_READER_WORKER_ID });
    } catch (error) {
      log.error({ err: error as Error }, 'inbox_reader.heartbeat_failed');
    }
  }
}

function pageNotAdvancingAlert(
  at: string,
  recipient: string,
  mode: InboxReaderMode,
  counts: RecipientCounts | undefined
): AlertRow {
  const c = counts ?? emptyCounts();
  return {
    at,
    kind: 'page_not_advancing',
    recipient,
    count: c.listed,
    oldest_created_at: null,
    ids: [],
    detail: `full page for ${recipient} cannot advance in ${mode} mode (INFO_DUPLICATE=${c.INFO_DUPLICATE}, NUDGE=${c.NUDGE}, ACTIONABLE=${c.ACTIONABLE}, too_young=${c.too_young}, acked_open=${c.acked_open})`,
  };
}

/**
 * Write latest.json, latest.md, and optionally a run file. Each write is atomic
 * (tmp + fsync + rename via the injected fs).
 */
export async function writeDigest(
  deps: InboxReaderDeps,
  digest: InboxDigest,
  opts: { runFileName: string | null }
): Promise<void> {
  await deps.fs.ensureDir(deps.rootDir);
  const json = JSON.stringify(digest, null, 2);
  await deps.fs.writeFileAtomic(join(deps.rootDir, 'latest.json'), json);
  await deps.fs.writeFileAtomic(join(deps.rootDir, 'latest.md'), renderLatestMarkdown(digest));
  if (opts.runFileName) {
    await deps.fs.ensureDir(join(deps.rootDir, 'runs'));
    await deps.fs.writeFileAtomic(opts.runFileName, json);
  }
}

async function verifyDigestReadBack(
  deps: InboxReaderDeps,
  digest: InboxDigest,
  runFilePath: string | null
): Promise<void> {
  const raw = await deps.fs.readFile(join(deps.rootDir, 'latest.json'));
  const parsed = JSON.parse(raw) as InboxDigest;
  assertPlanPresent(parsed, digest.disposal_plan);
  if (runFilePath) {
    const runRaw = await deps.fs.readFile(runFilePath);
    const runParsed = JSON.parse(runRaw) as InboxDigest;
    assertPlanPresent(runParsed, digest.disposal_plan);
  }
}

function assertPlanPresent(parsed: InboxDigest, plan: DisposalPlanEntry[]): void {
  const ids = new Set((parsed.disposal_plan ?? []).map(entry => entry.id));
  for (const entry of plan) {
    if (!ids.has(entry.id)) {
      throw new Error(`read_back_missing_plan_id:${entry.id}`);
    }
  }
}

async function writeState(deps: InboxReaderDeps, state: ReaderState): Promise<void> {
  await deps.fs.writeFileAtomic(statePath(deps.rootDir), JSON.stringify(state, null, 2));
}

async function pruneOldRunFiles(
  deps: InboxReaderDeps,
  config: InboxReaderConfig,
  nowMs: number
): Promise<void> {
  const runsDir = join(deps.rootDir, 'runs');
  const files = await deps.fs.listDir(runsDir);
  const cutoffMs = nowMs - config.retentionDays * 86_400_000;
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    // Name prefix is yyyymmddThhmmssZ; parse to an instant.
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
    if (!match) continue;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    const fileMs = Date.parse(iso);
    if (Number.isFinite(fileMs) && fileMs < cutoffMs) {
      await deps.fs.removeFile(join(runsDir, name));
    }
  }
}

// ---------------------------------------------------------------------------
// Surface-file report (read-only CLI over an existing surface.jsonl)
// ---------------------------------------------------------------------------

export interface SurfaceReport {
  counts: { INFO_DUPLICATE: number; NUDGE: number; ACTIONABLE: number };
  parse_errors: number;
  classifications: { id: string; class: InboxClass; rule_id: string; reason: string }[];
}

function surfaceEntryToInput(entry: SurfaceEntry): InboxClassifierInput {
  return {
    id: entry.messageId,
    sender: entry.sender,
    task_type: entry.taskType,
    recipient: 'operator',
    body: entry.originalBody,
    subject_key: null,
    priority: undefined,
    created_at: entry.createdAt,
    status: 'queued',
    acknowledged_at: null,
    addressed_at: null,
    route_disposition: null,
  };
}

/** Classify legacy surface.jsonl lines read-only. A malformed line is a parse_error. */
export function buildReportFromSurfaceLines(lines: string[]): SurfaceReport {
  const report: SurfaceReport = {
    counts: { INFO_DUPLICATE: 0, NUDGE: 0, ACTIONABLE: 0 },
    parse_errors: 0,
    classifications: [],
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry: SurfaceEntry;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SurfaceEntry>;
      if (
        typeof parsed.messageId !== 'string' ||
        typeof parsed.sender !== 'string' ||
        typeof parsed.taskType !== 'string' ||
        typeof parsed.originalBody !== 'string'
      ) {
        report.parse_errors += 1;
        continue;
      }
      entry = parsed as SurfaceEntry;
    } catch {
      report.parse_errors += 1;
      continue;
    }
    const classification = classifyInboxMessage(surfaceEntryToInput(entry));
    report.counts[classification.class] += 1;
    report.classifications.push({
      id: entry.messageId,
      class: classification.class,
      rule_id: classification.rule_id,
      reason: classification.reason,
    });
  }
  return report;
}

// ---------------------------------------------------------------------------
// Scheduler singleton
// ---------------------------------------------------------------------------

let inboxReaderTimer: ReturnType<typeof setInterval> | undefined;

function buildRealDeps(): InboxReaderDeps {
  return {
    listMessages: async (filters): Promise<InboxClassifierInput[]> => {
      const rows = await listMessages({
        recipient: filters.recipient,
        status: filters.status,
        limit: filters.limit,
      });
      return rows.map((row: DispatchMessage) => ({
        id: row.id,
        sender: row.sender,
        task_type: row.task_type,
        recipient: row.recipient,
        body: row.body,
        subject_key: row.subject_key,
        priority: row.priority,
        created_at: row.created_at,
        status: row.status,
        acknowledged_at: row.acknowledged_at,
        addressed_at: row.addressed_at,
        route_disposition: row.route_disposition,
      }));
    },
    disposeMessageByMachine: async (
      data
    ): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const outcome = await disposeMessageByMachine({
        id: data.id,
        actor: data.actor,
        disposition: data.disposition,
        requireNoReceipt: data.requireNoReceipt,
      });
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
    heartbeatWorker: (data): Promise<unknown> => heartbeatWorker(data),
    now: (): Date => new Date(),
    rootDir: join(getArchonHome(), 'inbox-reader'),
    fs: defaultInboxReaderFs(),
  };
}

export function stopInboxReader(): void {
  if (inboxReaderTimer) clearInterval(inboxReaderTimer);
  inboxReaderTimer = undefined;
}

/**
 * Start the inbox reader. Module-scope singleton: subsequent calls while a timer
 * exists are no-ops. INBOX_READER_INTERVAL_MS=0 disables.
 */
export function startInboxReader(): void {
  if (inboxReaderTimer !== undefined) return;
  const config = resolveInboxReaderConfig(process.env);
  if (config.intervalMs === 0) {
    log.info({}, 'inbox_reader.disabled_by_interval_env');
    return;
  }

  const deps = buildRealDeps();
  void registerWorker({
    worker_id: INBOX_READER_WORKER_ID,
    host: process.env.HOSTNAME ?? 'in-process',
    capabilities: { role: 'inbox-reader', mode: config.mode, owner: config.operatorOwner },
    max_concurrency: 1,
  }).catch(error => {
    log.error({ err: error as Error }, 'inbox_reader.register_worker_failed');
  });

  let inFlight = false;
  const runTick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runInboxReader(deps, config);
    } catch (error) {
      log.error({ err: error as Error }, 'inbox_reader.tick_failed');
    } finally {
      inFlight = false;
    }
  };
  inboxReaderTimer = setInterval(() => void runTick(), config.intervalMs);
  inboxReaderTimer.unref?.();
  void runTick();
}
