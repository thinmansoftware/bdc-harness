import { appendFile, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import {
  createAuthenticatedMessage,
  disposeMessageByMachine,
  heartbeatWorker,
  listMessagesBySeqCursor,
  registerWorker,
  type DispatchMailboxResult,
  type DispatchMessage,
  type DispatchSenderContext,
} from '@archon/core/db/dispatch';
import { createLogger, getArchonHome } from '@archon/paths';
import {
  classifyInboxMessage,
  needsGithubState,
  type GhSubjectState,
  type InboxAction,
  type InboxClassification,
  type InboxMessage,
} from './inbox-reader-rules';
import {
  createRealOpsInboxGitHub,
  upsertDigestSection as realUpsertDigestSection,
  type OpsInboxGitHub,
} from './ops-inbox';
import { serviceGitHubFetchWithPermissionFallback } from '@archon/core/github/request';

export const INBOX_READER_WORKER_ID = 'inbox-reader';
export const INBOX_READER_ACTOR = 'system:inbox-reader';
/** Reader sends (the owner-ack-overdue hand-off) use the shared system sender. */
const READER_SENDER: DispatchSenderContext = { kind: 'system', sender: 'dispatch' };
/** At most this many distinct GitHub subject-state lookups per run (A2/Scope IN). */
const GITHUB_LOOKUP_BUDGET = 50;
/** At most this many surface.jsonl lines are classified per run (A2). */
const SURFACE_MAX_LINES = 2000;
/** Owner-ack deadlines (A5). */
const OWNER_ACK_NOTE_HOURS = 24;
const OWNER_ACK_ESCALATE_HOURS = 72;

type Mode = 'dry-run' | 'enforce';
type Owner = 'consumer' | 'reader';
type Disposition = 'expired' | 'auto_surfaced' | 'superseded';

export interface InboxReaderConfig {
  intervalMs: number;
  mode: Mode;
  maxPerRun: number;
  minAgeMs: number;
  operatorOwner: Owner;
  recipients: ('xo' | 'operator')[];
  actionableAlertHours: number;
  gapAlertHours: number;
  alertRepeatHours: number;
  retentionDays: number;
  canaryAgeHours: number;
  canaryMax: number;
}

interface CountSet {
  listed: number;
  DROP: number;
  DIGEST: number;
  COLLAPSE: number;
  BRING: number;
  too_young: number;
  acked_open: number;
  skipped: number;
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

interface DigestItem {
  id: string;
  recipient: string;
  sender: string;
  task_type: string;
  priority: string;
  subject_key: string | null;
  created_at: string;
  age_hours: number;
  rule_id: string;
  class: string;
  action: InboxAction;
  reason: string;
  excerpt: string;
}

interface OverdueLine {
  id: string;
  recipient: string;
  subject_key: string | null;
  default_action: string;
}

export interface Digest {
  run_id: string;
  started_at: string;
  finished_at: string;
  mode: Mode;
  recipients: string[];
  operator_owner: Owner;
  counts: Record<string, CountSet>;
  counts_by_rule: Record<string, number>;
  bring: DigestItem[];
  actionable: DigestItem[];
  digest_items: DigestItem[];
  dropped: number;
  collapsed: number;
  overdue: OverdueLine[];
  canary: Record<string, { unread_older_than_6h: number }>;
  disposal_plan: {
    id: string;
    recipient: string;
    rule_id: string;
    reason: string;
    disposition: Disposition;
  }[];
  disposal_results: { id: string; ok: boolean; reason: string | null }[];
  alerts: AlertRow[];
  content_hash: string;
  last_run_at: string;
  run_file: string | null;
  github_subjects_resolved: number;
  surface_cursor: number;
}

interface ReaderState {
  last_run_at?: string;
  content_hash?: string;
  run_file?: string | null;
  last_alert_at?: Record<string, string>;
  cursors?: Record<string, number>;
  rotation?: number;
  surface_cursor?: number;
  gh_state_cache?: Record<string, GhSubjectState>;
  owner_ack_overdue?: Record<string, { noted_at?: string; escalated_at?: string }>;
}

export interface InboxListFilters {
  recipient: string;
  status: 'queued';
  limit: number;
  afterSeq?: number;
}

export type ListedInboxMessage = InboxMessage & { cursor_seq?: number };

export interface InboxReaderDeps {
  now?: () => Date;
  root?: string;
  listMessages?: (filters: InboxListFilters) => Promise<ListedInboxMessage[]>;
  disposeMessageByMachine?: (data: {
    id: string;
    actor: string;
    disposition: Disposition;
    requireNoReceipt: true;
  }) => Promise<DispatchMailboxResult | { ok: false; reason: string }>;
  registerWorker?: typeof registerWorker;
  heartbeatWorker?: typeof heartbeatWorker;
  /** Resolve GitHub issue/PR state for up to GITHUB_LOOKUP_BUDGET subjects. */
  resolveGithubState?: (subjects: string[]) => Promise<Record<string, GhSubjectState>>;
  /** Ops-inbox GitHub client used to upsert the daily digest sections. */
  opsInboxGitHub?: OpsInboxGitHub;
  upsertDigestSection?: (
    gh: OpsInboxGitHub,
    dateUtc: string,
    sectionKey: string,
    markdown: string
  ) => Promise<unknown>;
  /** Create a Dispatch row (owner-ack-overdue hand-off to the Duty Officer). */
  createAuthenticatedMessage?: (
    context: DispatchSenderContext,
    data: {
      correlation_id: string;
      idempotency_key: string;
      task_type: DispatchMessage['task_type'];
      recipient: string;
      body: string;
      priority?: DispatchMessage['priority'];
    }
  ) => Promise<DispatchMessage | null>;
  /** Queued-row counts for principals with no consumer (A6 canary). */
  noConsumerQueued?: () => Promise<{ principal: string; count: number }[]>;
  atomicWrite?: (path: string, contents: string) => Promise<void>;
  readText?: (path: string) => Promise<string>;
  appendText?: (path: string, contents: string) => Promise<void>;
  log?: {
    info: (data: unknown, message?: string) => void;
    warn: (data: unknown, message?: string) => void;
    error: (data: unknown, message?: string) => void;
  };
}

export interface InboxReaderRunResult {
  digest: Digest | null;
  errors: string[];
  skipped_race: number;
}

const realLog = createLogger('dispatch/inbox-reader');

function integer(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveInboxReaderConfig(
  env: Record<string, string | undefined>,
  logger: Pick<Console, 'warn'> = console
): InboxReaderConfig {
  const intervalRaw = integer(env.INBOX_READER_INTERVAL_MS, 300_000);
  const intervalMs = intervalRaw >= 0 ? intervalRaw : 300_000;
  const mode: Mode = env.INBOX_READER_MODE === 'enforce' ? 'enforce' : 'dry-run';
  if (env.INBOX_READER_MODE && env.INBOX_READER_MODE !== 'dry-run' && mode === 'dry-run') {
    logger.warn(`invalid INBOX_READER_MODE=${env.INBOX_READER_MODE}; using dry-run`);
  }
  // Amendment A2: the reader OWNS the operator mailbox by default. The old
  // default (operator-inbox-consumer owns it) is kept only as a rollback switch
  // via INBOX_READER_OPERATOR_OWNER=consumer.
  const operatorOwner: Owner =
    env.INBOX_READER_OPERATOR_OWNER === 'consumer' ? 'consumer' : 'reader';
  return {
    intervalMs,
    mode,
    maxPerRun: Math.min(500, Math.max(1, integer(env.INBOX_READER_MAX_PER_RUN, 500))),
    minAgeMs: Math.max(600_000, integer(env.INBOX_READER_MIN_AGE_MS, 600_000)),
    operatorOwner,
    recipients: operatorOwner === 'reader' ? ['xo', 'operator'] : ['xo'],
    actionableAlertHours: positive(env.INBOX_READER_ACTIONABLE_ALERT_HOURS, 24),
    gapAlertHours: positive(env.INBOX_READER_GAP_ALERT_HOURS, 2),
    alertRepeatHours: positive(env.INBOX_READER_ALERT_REPEAT_HOURS, 6),
    retentionDays: Math.max(1, integer(env.INBOX_READER_RETENTION_DAYS, 14)),
    canaryAgeHours: positive(env.INBOX_READER_CANARY_AGE_HOURS, 6),
    canaryMax: Math.max(0, integer(env.INBOX_READER_CANARY_MAX, 25)),
  };
}

export function shouldStartOperatorInboxConsumer(env: Record<string, string | undefined>): boolean {
  return resolveInboxReaderConfig(env).operatorOwner !== 'reader';
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function emptyCounts(): CountSet {
  return {
    listed: 0,
    DROP: 0,
    DIGEST: 0,
    COLLAPSE: 0,
    BRING: 0,
    too_young: 0,
    acked_open: 0,
    skipped: 0,
  };
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function markdown(digest: Digest): string {
  const lines = [
    '# Dispatch inbox reader',
    '',
    `Last run: ${digest.last_run_at}`,
    `Mode: ${digest.mode}`,
    '',
    '| Recipient | Listed | DROP | DIGEST | COLLAPSE | BRING | Too young | Acked open | Skipped |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const recipient of digest.recipients) {
    const count = digest.counts[recipient];
    if (!count) continue;
    lines.push(
      `| ${recipient} | ${count.listed} | ${count.DROP} | ${count.DIGEST} | ${count.COLLAPSE} | ${count.BRING} | ${count.too_young} | ${count.acked_open} | ${count.skipped} |`
    );
  }
  lines.push('', '## BRING (a person must read)', '');
  for (const item of digest.bring) {
    lines.push(`- ${item.id} (${item.recipient}, ${item.rule_id}, ${item.class}): ${item.excerpt}`);
  }
  lines.push('', '## DIGEST', '');
  for (const item of digest.digest_items) {
    lines.push(`- ${item.id} (${item.recipient}, ${item.rule_id}): ${item.excerpt}`);
  }
  lines.push(
    '',
    '## Dispositioned',
    '',
    `- dropped (expired): ${digest.dropped}`,
    `- collapsed (superseded): ${digest.collapsed}`
  );
  return `${lines.join('\n')}\n`;
}

function alertKey(kind: string, recipient: string | null): string {
  return `${kind}:${recipient ?? '*'}`;
}

function isSuppressed(
  state: ReaderState,
  kind: string,
  recipient: string | null,
  nowMs: number,
  repeatHours: number
): boolean {
  const previous = state.last_alert_at?.[alertKey(kind, recipient)];
  return Boolean(previous && nowMs - Date.parse(previous) < repeatHours * 3_600_000);
}

function createAlert(
  now: Date,
  kind: string,
  recipient: string | null,
  messages: InboxMessage[],
  detail: string
): AlertRow {
  const sorted = [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    at: now.toISOString(),
    kind,
    recipient,
    count: messages.length,
    oldest_created_at: sorted[0]?.created_at ?? null,
    ids: sorted.slice(0, 50).map(message => message.id),
    detail,
  };
}

function makeHash(
  classified: { message: InboxMessage; result: InboxClassification }[],
  plan: Digest['disposal_plan']
): string {
  const material = classified
    .map(({ message, result }) => `${message.id}:${result.action}:${result.rule_id}`)
    .sort()
    .concat(plan.map(item => `${item.id}:${item.disposition}`).sort())
    .join('\n');
  return createHash('sha256').update(material).digest('hex');
}

async function readState(
  read: (path: string) => Promise<string>,
  path: string
): Promise<ReaderState> {
  try {
    return JSON.parse(await read(path)) as ReaderState;
  } catch {
    return {};
  }
}

export async function writeDigest(
  digest: Digest,
  root: string,
  writer: (path: string, contents: string) => Promise<void> = atomicWrite,
  runRequired = true
): Promise<void> {
  await mkdir(join(root, 'runs'), { recursive: true });
  if (runRequired && digest.run_file) {
    await writer(join(root, digest.run_file), `${JSON.stringify(digest, null, 2)}\n`);
  }
  await writer(join(root, 'latest.json'), `${JSON.stringify(digest, null, 2)}\n`);
  await writer(join(root, 'latest.md'), markdown(digest));
}

/**
 * Lists every configured recipient within one shared per-run budget.
 *
 * Fair share first: the budget is split across recipients so an earlier
 * mailbox holding a full page of retained BRING mail can never starve a later
 * one. Budget a recipient leaves unused is then offered to the others,
 * continuing each keyset walk. The walk position is a per-recipient
 * `cursor_seq` persisted in state.json between runs. An injected lister that
 * returns no `cursor_seq` gets head-only paging.
 */
async function listAllRecipients(
  list: (filters: InboxListFilters) => Promise<ListedInboxMessage[]>,
  config: InboxReaderConfig,
  cursors: Record<string, number>,
  rotation: number,
  errors: string[]
): Promise<{
  pages: Map<string, { rows: ListedInboxMessage[]; full: boolean }>;
  cursors: Record<string, number>;
}> {
  const recipients = config.recipients;
  const pages = new Map<string, { rows: ListedInboxMessage[]; full: boolean }>();
  const walks = new Map<
    string,
    { position: number | undefined; fromHead: boolean; done: boolean }
  >();
  const nextCursors = new Map<string, number>();
  let remaining = config.maxPerRun;

  const fetchPage = async (recipient: string, limit: number): Promise<void> => {
    const start = cursors[recipient];
    const walk = walks.get(recipient) ?? {
      position: start,
      fromHead: start === undefined,
      done: false,
    };
    walks.set(recipient, walk);
    const page = pages.get(recipient) ?? { rows: [], full: false };
    pages.set(recipient, page);
    if (walk.done) return;
    if (limit <= 0) {
      if (walk.position !== undefined) nextCursors.set(recipient, walk.position);
      return;
    }
    let rows: ListedInboxMessage[];
    try {
      rows = await list({
        recipient,
        status: 'queued',
        limit,
        ...(walk.position === undefined ? {} : { afterSeq: walk.position }),
      });
    } catch (error) {
      errors.push(`list_failed:${recipient}:${(error as Error).message}`);
      throw error;
    }
    const seen = new Set(page.rows.map(row => row.id));
    const fresh = rows.filter(row => !seen.has(row.id));
    page.rows.push(...fresh);
    remaining -= fresh.length;
    page.full = rows.length === limit;
    const last = rows.at(-1)?.cursor_seq;
    const pageable = typeof last === 'number' && Number.isFinite(last);
    if (page.full && pageable) {
      walk.position = last;
      nextCursors.set(recipient, last);
      if (fresh.length === 0) walk.done = true;
    } else if (page.full) {
      walk.done = true;
      nextCursors.delete(recipient);
    } else {
      nextCursors.delete(recipient);
      if (walk.fromHead) {
        walk.done = true;
      } else {
        walk.position = undefined;
        walk.fromHead = true;
      }
    }
  };

  const shift = ((rotation % recipients.length) + recipients.length) % recipients.length;
  const ordered = [...recipients.slice(shift), ...recipients.slice(0, shift)];
  const base = Math.floor(config.maxPerRun / ordered.length);
  const extra = config.maxPerRun % ordered.length;
  for (const [index, recipient] of ordered.entries()) {
    await fetchPage(recipient, Math.min(base + (index < extra ? 1 : 0), remaining));
  }
  for (const recipient of ordered) {
    while (remaining > 0 && !(walks.get(recipient)?.done ?? true)) {
      await fetchPage(recipient, remaining);
    }
  }
  return { pages, cursors: Object.fromEntries(nextCursors) };
}

function excerptOf(message: InboxMessage): string {
  return message.body.replace(/\r?\n/g, ' ').slice(0, 200);
}

function toDigestItem(
  message: InboxMessage,
  result: InboxClassification,
  startedMs: number
): DigestItem {
  return {
    id: message.id,
    recipient: message.recipient,
    sender: message.sender,
    task_type: message.task_type,
    priority: message.priority ?? 'normal',
    subject_key: message.subject_key,
    created_at: message.created_at,
    age_hours: Math.max(0, (startedMs - Date.parse(message.created_at)) / 3_600_000),
    rule_id: result.rule_id,
    class: result.class,
    action: result.action,
    reason: result.reason,
    excerpt: excerptOf(message),
  };
}

export async function runInboxReader(
  deps: InboxReaderDeps = {},
  config = resolveInboxReaderConfig(process.env)
): Promise<InboxReaderRunResult> {
  const now = deps.now ?? ((): Date => new Date());
  const started = now();
  const startedMs = started.getTime();
  const root = deps.root ?? join(getArchonHome(), 'inbox-reader');
  const read = deps.readText ?? ((path: string): Promise<string> => Bun.file(path).text());
  const writer = deps.atomicWrite ?? atomicWrite;
  const append =
    deps.appendText ??
    ((path: string, text: string): Promise<void> => appendFile(path, text, 'utf8'));
  const list =
    deps.listMessages ??
    ((filters: InboxListFilters): Promise<ListedInboxMessage[]> =>
      listMessagesBySeqCursor({ ...filters, openOnly: true }));
  const dispose = deps.disposeMessageByMachine ?? disposeMessageByMachine;
  const register = deps.registerWorker ?? registerWorker;
  const heartbeat = deps.heartbeatWorker ?? heartbeatWorker;
  const createMessage = deps.createAuthenticatedMessage ?? createAuthenticatedMessage;
  const opsGithub = deps.opsInboxGitHub;
  const upsertSection = deps.upsertDigestSection;
  const resolveGithubState = deps.resolveGithubState;
  const logger = deps.log ?? realLog;
  const errors: string[] = [];
  let skippedRace = 0;
  let digest: Digest | null = null;

  const upsert = async (sectionKey: string, md: string): Promise<boolean> => {
    if (!opsGithub || !upsertSection) return false;
    try {
      await upsertSection(opsGithub, utcDate(started), sectionKey, md);
      return true;
    } catch (error) {
      errors.push(`digest_write_failed:${sectionKey}:${(error as Error).message}`);
      logger.error({ error, sectionKey }, 'ops_inbox_section_write_failed');
      return false;
    }
  };

  try {
    try {
      await register({
        worker_id: INBOX_READER_WORKER_ID,
        host: process.env.HOSTNAME ?? 'in-process',
        capabilities: { task_types: ['agent_message', 'run_report'], principal: 'inbox-reader' },
        max_concurrency: 1,
      });
    } catch (error) {
      const message = `register_failed:${(error as Error).message}`;
      errors.push(message);
      logger.error({ error }, message);
    }
    await mkdir(join(root, 'runs'), { recursive: true });
    const state = await readState(read, join(root, 'state.json'));
    const counts: Record<string, CountSet> = {};
    const countsByRule: Record<string, number> = {};
    const pageInfo: { recipient: string; full: boolean }[] = [];
    const listed = await listAllRecipients(
      list,
      config,
      state.cursors ?? {},
      state.rotation ?? 0,
      errors
    );
    const nextCursors = listed.cursors;

    // Collect the processable rows per recipient (queued, undisposed, unaddressed).
    const live: InboxMessage[] = [];
    for (const recipient of config.recipients) {
      counts[recipient] = emptyCounts();
      const page = listed.pages.get(recipient);
      if (!page) continue;
      counts[recipient].listed = page.rows.length;
      pageInfo.push({ recipient, full: page.full });
      for (const message of page.rows) {
        if (
          message.status !== 'queued' ||
          message.route_disposition !== null ||
          message.addressed_at !== null
        ) {
          counts[recipient].skipped += 1;
          continue;
        }
        live.push(message);
      }
    }

    // Resolve GitHub subject states, bounded to GITHUB_LOOKUP_BUDGET new subjects
    // per run and cached across runs in state.json.
    const ghCache: Record<string, GhSubjectState> = { ...(state.gh_state_cache ?? {}) };
    let githubSubjectsResolved = 0;
    const pending: string[] = [];
    const pendingSeen = new Set<string>();
    for (const message of live) {
      if (!message.subject_key) continue;
      if (!needsGithubState(message)) continue;
      if (message.subject_key in ghCache) continue;
      if (pendingSeen.has(message.subject_key)) continue;
      pendingSeen.add(message.subject_key);
      pending.push(message.subject_key);
    }
    const toResolve = pending.slice(0, GITHUB_LOOKUP_BUDGET);
    if (toResolve.length > 0 && resolveGithubState) {
      try {
        const resolved = await resolveGithubState(toResolve);
        for (const [key, value] of Object.entries(resolved)) {
          ghCache[key] = value;
          githubSubjectsResolved += 1;
        }
      } catch (error) {
        errors.push(`github_state_lookup_failed:${(error as Error).message}`);
        logger.error({ error }, 'github_state_lookup_failed');
      }
    }
    const ghState = (key: string): GhSubjectState | undefined => ghCache[key];

    // Classify every live row.
    const classified: { message: InboxMessage; result: InboxClassification }[] = [];
    for (const message of live) {
      const result = classifyInboxMessage(message, { now: started, ghState });
      classified.push({ message, result });
      counts[message.recipient][result.action] += 1;
      countsByRule[result.rule_id] = (countsByRule[result.rule_id] ?? 0) + 1;
    }

    // Group by action. COLLAPSE groups by (recipient, collapse_key): the newest
    // row stays open for the digest; the older rows are superseded.
    const bring: DigestItem[] = [];
    const digestItems: DigestItem[] = [];
    const plan: Digest['disposal_plan'] = [];
    const collapseGroups = new Map<
      string,
      { message: InboxMessage; result: InboxClassification }[]
    >();

    const planDisposable = (
      message: InboxMessage,
      result: InboxClassification,
      disposition: Disposition
    ): void => {
      if (message.acknowledged_at !== null) {
        counts[message.recipient].acked_open += 1;
        return;
      }
      if (startedMs - Date.parse(message.created_at) < config.minAgeMs) {
        counts[message.recipient].too_young += 1;
        return;
      }
      plan.push({
        id: message.id,
        recipient: message.recipient,
        rule_id: result.rule_id,
        reason: `inbox-reader ${result.rule_id}: ${result.reason}`,
        disposition,
      });
    };

    for (const entry of classified) {
      const { message, result } = entry;
      if (result.action === 'BRING') {
        bring.push(toDigestItem(message, result, startedMs));
        continue;
      }
      if (result.action === 'DROP') {
        digestItems.push(toDigestItem(message, result, startedMs));
        planDisposable(message, result, 'expired');
        continue;
      }
      if (result.action === 'DIGEST') {
        digestItems.push(toDigestItem(message, result, startedMs));
        planDisposable(message, result, 'auto_surfaced');
        continue;
      }
      // COLLAPSE
      const key = `${message.recipient}:${result.collapse_key ?? result.rule_id}`;
      const group = collapseGroups.get(key) ?? [];
      group.push(entry);
      collapseGroups.set(key, group);
    }

    // For each COLLAPSE group, keep the newest open (digest) and supersede the rest.
    for (const group of collapseGroups.values()) {
      const sorted = [...group].sort((a, b) =>
        b.message.created_at.localeCompare(a.message.created_at)
      );
      const [newest, ...older] = sorted;
      if (newest) digestItems.push(toDigestItem(newest.message, newest.result, startedMs));
      for (const entry of older) {
        planDisposable(entry.message, entry.result, 'superseded');
      }
    }

    const expiredPlan = plan.filter(item => item.disposition === 'expired');
    const surfacedPlan = plan.filter(item => item.disposition !== 'expired');

    // ---- Alerts: stale BRING mail, reader gap ----
    const alerts: AlertRow[] = [];
    for (const recipient of config.recipients) {
      const stale = classified
        .filter(
          item =>
            item.message.recipient === recipient &&
            item.result.action === 'BRING' &&
            item.message.acknowledged_at === null &&
            startedMs - Date.parse(item.message.created_at) >
              config.actionableAlertHours * 3_600_000
        )
        .map(item => item.message);
      if (
        stale.length > 0 &&
        !isSuppressed(state, 'actionable_stale', recipient, startedMs, config.alertRepeatHours)
      ) {
        alerts.push(
          createAlert(started, 'actionable_stale', recipient, stale, 'unread BRING mail is stale')
        );
      }
    }
    if (
      state.last_run_at &&
      startedMs - Date.parse(state.last_run_at) > config.gapAlertHours * 3_600_000 &&
      !isSuppressed(state, 'reader_gap', null, startedMs, config.alertRepeatHours)
    ) {
      alerts.push(
        createAlert(started, 'reader_gap', null, [], `previous run was ${state.last_run_at}`)
      );
    }

    // ---- A6: unread canary (per recipient, plus no-consumer principals) ----
    const canary: Record<string, { unread_older_than_6h: number }> = {};
    const canaryCutoffMs = config.canaryAgeHours * 3_600_000;
    for (const recipient of config.recipients) {
      const count = classified.filter(
        item =>
          item.message.recipient === recipient &&
          item.message.acknowledged_at === null &&
          item.message.addressed_at === null &&
          startedMs - Date.parse(item.message.created_at) > canaryCutoffMs
      ).length;
      canary[recipient] = { unread_older_than_6h: count };
      if (
        count > config.canaryMax &&
        !isSuppressed(state, 'queued_age_canary', recipient, startedMs, config.alertRepeatHours)
      ) {
        alerts.push(
          createAlert(
            started,
            'queued_age_canary',
            recipient,
            [],
            `${count} unread rows older than ${config.canaryAgeHours}h (max ${config.canaryMax})`
          )
        );
      }
    }
    if (deps.noConsumerQueued) {
      try {
        const orphaned = await deps.noConsumerQueued();
        for (const { principal, count } of orphaned) {
          if (count <= 0) continue;
          canary[principal] = { unread_older_than_6h: count };
          if (
            !isSuppressed(state, 'queued_age_canary', principal, startedMs, config.alertRepeatHours)
          ) {
            alerts.push(
              createAlert(
                started,
                'queued_age_canary',
                principal,
                [],
                `${count} queued rows for a principal with no consumer`
              )
            );
          }
        }
      } catch (error) {
        errors.push(`no_consumer_queued_failed:${(error as Error).message}`);
      }
    }

    const hash = makeHash(classified, plan);
    const runId = randomUUID();
    const stamp = started
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const runFile = `runs/${stamp}-${runId}.json`;
    let runRequired =
      (config.mode === 'enforce' && plan.length > 0) ||
      alerts.length > 0 ||
      state.content_hash !== hash;

    digest = {
      run_id: runId,
      started_at: started.toISOString(),
      finished_at: now().toISOString(),
      mode: config.mode,
      recipients: config.recipients,
      operator_owner: config.operatorOwner,
      counts,
      counts_by_rule: countsByRule,
      bring,
      actionable: bring,
      digest_items: digestItems,
      dropped: expiredPlan.length,
      collapsed: surfacedPlan.filter(item => item.disposition === 'superseded').length,
      overdue: [],
      canary,
      disposal_plan: plan,
      disposal_results: [],
      alerts: [...alerts],
      content_hash: hash,
      last_run_at: started.toISOString(),
      run_file: runRequired ? runFile : null,
      github_subjects_resolved: githubSubjectsResolved,
      surface_cursor: state.surface_cursor ?? 0,
    };

    // ---- Local digest files (the read-back gate for 'expired' DROP) ----
    let localDigestOk = true;
    try {
      await writeDigest(digest, root, writer, runRequired);
      const latest = JSON.parse(await read(join(root, 'latest.json'))) as Digest;
      const artifacts = [latest];
      if (runRequired) artifacts.push(JSON.parse(await read(join(root, runFile))) as Digest);
      for (const artifact of artifacts) {
        const ids = new Set(artifact.disposal_plan.map(item => item.id));
        if (plan.some(item => !ids.has(item.id)))
          throw new Error('disposal_plan_readback_mismatch');
      }
    } catch (error) {
      localDigestOk = false;
      errors.push(`digest_write_failed:${(error as Error).message}`);
      logger.error({ error }, 'digest_write_failed');
    }

    // ---- Ops-inbox GitHub digest: the surface gate for 'auto_surfaced'/'superseded' ----
    let liveSectionOk = false;
    if (config.mode === 'enforce' && (bring.length > 0 || digestItems.length > 0)) {
      const sectionMd = buildLiveSectionMarkdown(digest);
      liveSectionOk = await upsert('mailbox-triage', sectionMd);
    }

    // ---- A2: operator-mailbox backlog from surface.jsonl (reader owner only) ----
    let nextSurfaceCursor = state.surface_cursor ?? 0;
    if (config.operatorOwner === 'reader') {
      const surfacePath = defaultOperatorInboxSurfacePath(root);
      const surfaceResult = await processSurfaceBacklog(
        read,
        surfacePath,
        nextSurfaceCursor,
        started
      );
      if (surfaceResult.lines.length > 0) {
        const ok = await upsert('operator_backlog', surfaceResult.markdown);
        if (ok) nextSurfaceCursor = surfaceResult.nextCursor;
      }
    }
    digest.surface_cursor = nextSurfaceCursor;

    // ---- Dispositions (enforce only) ----
    const successes: Record<string, number> = {};
    if (config.mode === 'enforce') {
      const authorized = plan.filter(item => {
        if (item.disposition === 'expired') return localDigestOk;
        return liveSectionOk;
      });
      if (surfacedPlan.length > 0 && !liveSectionOk) {
        const alert = createAlert(
          started,
          'digest_surface_failed',
          null,
          [],
          'ops-inbox digest write failed; DIGEST/COLLAPSE rows kept open'
        );
        alerts.push(alert);
        digest.alerts = [...alerts];
      }
      for (const item of authorized) {
        const result = await dispose({
          id: item.id,
          actor: INBOX_READER_ACTOR,
          disposition: item.disposition,
          requireNoReceipt: true,
        });
        digest.disposal_results.push({
          id: item.id,
          ok: result.ok,
          reason: result.ok ? null : result.reason,
        });
        if (result.ok) {
          successes[item.recipient] = (successes[item.recipient] ?? 0) + 1;
        } else if (['already_disposed', 'not_found', 'receipt_present'].includes(result.reason)) {
          skippedRace += 1;
        } else {
          errors.push(`dispose_failed:${item.id}:${result.reason}`);
          if (result.reason === 'machine_actor_conflict') {
            logger.error({ id: item.id, reason: result.reason }, 'machine_actor_conflict');
            break;
          }
        }
      }
    }

    // ---- A5: owner-ack overdue (24h note, 72h duty-officer hand-off) ----
    const ownerAck = { ...(state.owner_ack_overdue ?? {}) };
    const overdue: OverdueLine[] = [];
    // IDs whose noted_at was stamped THIS run. The stamp is committed to
    // owner_ack_overdue (and thus state.json) only after the overdue-section
    // upsert below succeeds; if that write fails these are rolled back so the
    // 24h note is retried, not permanently suppressed (review finding).
    const newlyNotedIds: string[] = [];
    for (const { message, result } of classified) {
      if (result.action !== 'BRING') continue;
      if (message.acknowledged_at !== null) continue;
      const ageMs = startedMs - Date.parse(message.created_at);
      const tracked = ownerAck[message.id] ?? {};
      if (ageMs > OWNER_ACK_NOTE_HOURS * 3_600_000 && !tracked.noted_at) {
        overdue.push({
          id: message.id,
          recipient: message.recipient,
          subject_key: message.subject_key,
          default_action: result.reason,
        });
        tracked.noted_at = started.toISOString();
        newlyNotedIds.push(message.id);
      }
      if (ageMs > OWNER_ACK_ESCALATE_HOURS * 3_600_000 && !tracked.escalated_at) {
        try {
          await createMessage(READER_SENDER, {
            correlation_id: `owner-ack-overdue:${message.id}`,
            idempotency_key: `owner-ack-overdue:${message.id}`,
            task_type: 'agent_message',
            recipient: 'duty-officer',
            body: JSON.stringify({
              kind: 'owner_ack_overdue',
              message_id: message.id,
              overdue_recipient: message.recipient,
              subject_key: message.subject_key,
            }),
          });
          tracked.escalated_at = started.toISOString();
        } catch (error) {
          errors.push(`owner_ack_overdue_failed:${message.id}:${(error as Error).message}`);
        }
      }
      ownerAck[message.id] = tracked;
    }
    digest.overdue = overdue;
    if (overdue.length > 0) {
      const overduePosted = await upsert(
        'overdue',
        overdue
          .map(
            line =>
              `- ${line.id} (${line.recipient}${line.subject_key ? `, ${line.subject_key}` : ''}): ${line.default_action}`
          )
          .join('\n')
      );
      if (!overduePosted) {
        // The overdue section was NOT posted (GitHub failure or no ops-inbox
        // client). Roll back the noted_at stamps recorded this run so the 24h
        // note is retried on the next run instead of being marked complete and
        // suppressed forever by a write that never landed.
        for (const id of newlyNotedIds) {
          const tracked = ownerAck[id];
          if (tracked) delete tracked.noted_at;
        }
      }
    }

    // ---- Page-not-advancing alerts ----
    for (const page of pageInfo) {
      if (!page.full) continue;
      const stuck = config.mode === 'dry-run' || (successes[page.recipient] ?? 0) === 0;
      if (
        stuck &&
        !isSuppressed(
          state,
          'page_not_advancing',
          page.recipient,
          startedMs,
          config.alertRepeatHours
        )
      ) {
        const count = counts[page.recipient];
        alerts.push(
          createAlert(
            started,
            'page_not_advancing',
            page.recipient,
            [],
            `mode=${config.mode}; cursor=${nextCursors[page.recipient] ?? 'head'}; DROP=${count.DROP}, DIGEST=${count.DIGEST}, COLLAPSE=${count.COLLAPSE}, BRING=${count.BRING}`
          )
        );
      }
    }

    // ---- Canary section (A6) ----
    const canaryAlerts = alerts.filter(alert => alert.kind === 'queued_age_canary');
    if (canaryAlerts.length > 0) {
      await upsert(
        'canary',
        canaryAlerts.map(alert => `- ${alert.recipient}: ${alert.detail}`).join('\n')
      );
    }

    digest.alerts = alerts;
    if (alerts.length > 0 && !runRequired) {
      runRequired = true;
      digest.run_file = runFile;
    }
    for (const alert of alerts)
      await append(join(root, 'alerts.jsonl'), `${JSON.stringify(alert)}\n`);
    try {
      await writeDigest(digest, root, writer, runRequired);
    } catch (error) {
      errors.push(`digest_final_write_failed:${(error as Error).message}`);
      logger.error({ error }, 'digest_final_write_failed');
    }

    const lastAlertAt = { ...(state.last_alert_at ?? {}) };
    for (const alert of alerts) lastAlertAt[alertKey(alert.kind, alert.recipient)] = alert.at;
    await writer(
      join(root, 'state.json'),
      `${JSON.stringify(
        {
          last_run_at: started.toISOString(),
          content_hash: hash,
          run_file: digest.run_file,
          last_alert_at: lastAlertAt,
          cursors: nextCursors,
          rotation: (state.rotation ?? 0) + 1,
          surface_cursor: nextSurfaceCursor,
          gh_state_cache: ghCache,
          owner_ack_overdue: ownerAck,
        },
        null,
        2
      )}\n`
    );

    const cutoff = startedMs - config.retentionDays * 86_400_000;
    for (const file of await readdir(join(root, 'runs'))) {
      const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(file);
      const parsed = match
        ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
        : Number.NaN;
      if (Number.isFinite(parsed) && parsed < cutoff) await unlink(join(root, 'runs', file));
    }
  } catch (error) {
    if (!errors.some(item => item.includes((error as Error).message))) {
      errors.push(`run_failed:${(error as Error).message}`);
    }
    logger.error({ error }, 'inbox_reader_run_failed');
  } finally {
    try {
      await heartbeat({ worker_id: INBOX_READER_WORKER_ID });
    } catch (error) {
      errors.push(`heartbeat_failed:${(error as Error).message}`);
    }
  }
  return { digest, errors, skipped_race: skippedRace };
}

function buildLiveSectionMarkdown(digest: Digest): string {
  const lines: string[] = [];
  lines.push(
    `BRING ${digest.bring.length} | DIGEST ${digest.digest_items.length} | dropped ${digest.dropped} | collapsed ${digest.collapsed}`
  );
  if (digest.bring.length > 0) {
    lines.push('', '### BRING');
    for (const item of digest.bring.slice(0, 50)) {
      lines.push(
        `- ${item.id} (${item.recipient}, ${item.rule_id}, ${item.class}): ${item.excerpt}`
      );
    }
  }
  return lines.join('\n');
}

export function defaultOperatorInboxSurfacePath(readerRoot: string): string {
  if (process.env.OPERATOR_INBOX_SURFACE_PATH) return process.env.OPERATOR_INBOX_SURFACE_PATH;
  return join(readerRoot, '..', 'operator-inbox', 'surface.jsonl');
}

/**
 * A7 (WO-HARNESS-DO-MAILBOX-TRIAGE-DIGEST-01): the `messageId`s of operator
 * surface.jsonl entries that sit PAST the reader's persisted surface cursor --
 * i.e. surfaced rows the reader has not yet folded into the digest backlog, so
 * they are still genuinely unread. `/api/dispatch/status` uses these to compute
 * `surface_unread` honestly: a surfaced row already BEHIND the cursor is in the
 * digest (read) and must NOT be counted, which a plain "auto_surfaced AND
 * unacked" DB query cannot distinguish.
 *
 * Reads `surface_cursor` (a byte offset into surface.jsonl) from the reader's
 * `state.json`, then returns every complete surface line's `messageId` from
 * that offset to end-of-file. Best-effort and read-only: a missing/invalid
 * state file means cursor 0 (whole file is past the cursor); a missing surface
 * file means no backlog. Malformed lines are skipped.
 */
export async function surfaceMessageIdsPastCursor(deps?: {
  root?: string;
  read?: (path: string) => Promise<string>;
}): Promise<string[]> {
  const root = deps?.root ?? join(getArchonHome(), 'inbox-reader');
  const read = deps?.read ?? ((path: string): Promise<string> => readFile(path, 'utf8'));
  let cursor = 0;
  try {
    const state = JSON.parse(await read(join(root, 'state.json'))) as ReaderState;
    if (typeof state.surface_cursor === 'number' && Number.isFinite(state.surface_cursor)) {
      cursor = Math.max(0, state.surface_cursor);
    }
  } catch {
    cursor = 0;
  }
  let fullText: string;
  try {
    fullText = await read(defaultOperatorInboxSurfacePath(root));
  } catch {
    return [];
  }
  const buf = Buffer.from(fullText, 'utf8');
  if (cursor >= buf.length) return [];
  // split('\n') leaves a trailing partial/empty element; drop it so only
  // newline-terminated lines are counted (matches processSurfaceBacklog).
  const complete = buf.subarray(cursor).toString('utf8').split('\n').slice(0, -1);
  const ids: string[] = [];
  for (const line of complete) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { messageId?: unknown };
      if (typeof entry.messageId === 'string') ids.push(entry.messageId);
    } catch {
      /* skip a malformed surface line */
    }
  }
  return ids;
}

/**
 * Read up to SURFACE_MAX_LINES complete lines of surface.jsonl from a byte
 * offset, classify them, and return a digest markdown plus the next cursor (the
 * byte offset AFTER the last complete line consumed). The caller advances the
 * persisted cursor only after the digest write succeeds, so a failed write
 * re-reads the same lines next run (A2, Test 22).
 */
async function processSurfaceBacklog(
  read: (path: string) => Promise<string>,
  path: string,
  fromByte: number,
  now: Date
): Promise<{ lines: string[]; markdown: string; nextCursor: number }> {
  let fullText: string;
  try {
    fullText = await read(path);
  } catch {
    return { lines: [], markdown: '', nextCursor: fromByte };
  }
  const buf = Buffer.from(fullText, 'utf8');
  if (fromByte >= buf.length) return { lines: [], markdown: '', nextCursor: fromByte };
  const slice = buf.subarray(fromByte).toString('utf8');
  const segments = slice.split('\n');
  // split('\n') leaves a final element that is either '' (text ended with a
  // newline) or an incomplete line (no trailing newline). Either way the last
  // element is not a complete, newline-terminated line, so drop it.
  const complete = segments.slice(0, -1);
  const take = complete.slice(0, SURFACE_MAX_LINES);
  if (take.length === 0) return { lines: [], markdown: '', nextCursor: fromByte };
  // Bytes consumed = all taken lines plus their trailing newline characters.
  let consumedBytes = 0;
  for (const line of take) consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
  const report = buildReportFromSurfaceLines(take, now);
  const md = [
    `operator backlog: ${take.length} lines classified`,
    `- DROP ${report.counts.DROP} | DIGEST ${report.counts.DIGEST} | COLLAPSE ${report.counts.COLLAPSE} | BRING ${report.counts.BRING}`,
  ].join('\n');
  return { lines: take, markdown: md, nextCursor: fromByte + consumedBytes };
}

export function buildReportFromSurfaceLines(
  lines: string[],
  now: Date = new Date()
): {
  counts: Record<InboxAction, number>;
  parse_errors: number;
  rows: { id: string; action: InboxAction; rule_id: string }[];
} {
  const counts: Record<InboxAction, number> = { DROP: 0, DIGEST: 0, COLLAPSE: 0, BRING: 0 };
  const rows: { id: string; action: InboxAction; rule_id: string }[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        !['messageId', 'sender', 'taskType', 'originalBody', 'createdAt'].every(
          field => typeof entry[field] === 'string'
        )
      )
        throw new Error('invalid_surface_entry');
      const result = classifyInboxMessage(
        {
          id: entry.messageId as string,
          sender: entry.sender as string,
          task_type: entry.taskType as DispatchMessage['task_type'],
          recipient: 'operator',
          body: entry.originalBody as string,
          subject_key: null,
          created_at: entry.createdAt as string,
          status: 'queued',
          acknowledged_at: null,
          addressed_at: null,
          route_disposition: null,
        },
        { now }
      );
      counts[result.action] += 1;
      rows.push({ id: entry.messageId as string, action: result.action, rule_id: result.rule_id });
    } catch {
      parseErrors += 1;
    }
  }
  return { counts, parse_errors: parseErrors, rows };
}

let timer: ReturnType<typeof setInterval> | undefined;

export function stopInboxReader(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/**
 * Resolve the OPEN/CLOSED/MERGED state of `gh:owner/repo#number` subjects via
 * the duty_officer service identity. Caller bounds how many subjects are passed
 * in per run; this helper issues at most one or two GitHub calls per subject.
 */
function createRealGithubSubjectStateResolver(): (
  subjects: string[]
) => Promise<Record<string, GhSubjectState>> {
  const parse = (subject: string): { owner: string; repo: string; number: number } | null => {
    const match = /^gh:([^/]+)\/([^#]+)#(\d+)$/.exec(subject);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  };
  const call = async (path: string): Promise<{ status: number; data: unknown }> => {
    const response = await serviceGitHubFetchWithPermissionFallback({
      service: 'duty_officer',
      url: `https://api.github.com${path}`,
      init: {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'bdc-harness-inbox-reader',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      },
    });
    if (response.status === 404) return { status: 404, data: null };
    if (!response.ok) throw new Error(`github_http_${response.status}`);
    return { status: response.status, data: await response.json() };
  };
  return async (subjects: string[]): Promise<Record<string, GhSubjectState>> => {
    const out: Record<string, GhSubjectState> = {};
    for (const subject of subjects) {
      const ref = parse(subject);
      if (!ref) {
        out[subject] = 'UNKNOWN';
        continue;
      }
      const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
      try {
        const issue = await call(`${base}/issues/${ref.number}`);
        const issueData = issue.data as { state?: string; pull_request?: unknown } | null;
        if (!issueData) {
          out[subject] = 'UNKNOWN';
          continue;
        }
        if (issueData.state === 'open') {
          out[subject] = 'OPEN';
          continue;
        }
        if (issueData.pull_request) {
          const pr = await call(`${base}/pulls/${ref.number}`);
          const prData = pr.data as { merged?: boolean } | null;
          out[subject] = prData?.merged ? 'MERGED' : 'CLOSED';
          continue;
        }
        out[subject] = 'CLOSED';
      } catch {
        out[subject] = 'UNKNOWN';
      }
    }
    return out;
  };
}

function productionDeps(): InboxReaderDeps {
  const opsInboxGitHub = createRealOpsInboxGitHub();
  return {
    opsInboxGitHub,
    upsertDigestSection: realUpsertDigestSection,
    resolveGithubState: createRealGithubSubjectStateResolver(),
    createAuthenticatedMessage: (context, data) => createAuthenticatedMessage(context, data),
  };
}

export function startInboxReader(deps: InboxReaderDeps = {}): void {
  if (timer !== undefined) return;
  const config = resolveInboxReaderConfig(process.env);
  if (config.intervalMs === 0) return;
  const merged: InboxReaderDeps = { ...productionDeps(), ...deps };
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runInboxReader(merged, config);
    } finally {
      inFlight = false;
    }
  };
  timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref?.();
  void tick();
}
