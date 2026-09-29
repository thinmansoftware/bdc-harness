import { appendFile, mkdir, open, readFile, readdir, rename, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import {
  disposeMessageByMachine,
  heartbeatWorker,
  listMessages,
  registerWorker,
  type DispatchMailboxResult,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import { createLogger, getArchonHome } from '@archon/paths';
import {
  classifyInboxMessage,
  type InboxClass,
  type InboxClassification,
  type InboxMessage,
} from './inbox-reader-rules';

export const INBOX_READER_WORKER_ID = 'inbox-reader';
export const INBOX_READER_ACTOR = 'system:inbox-reader';

type Mode = 'dry-run' | 'enforce';
type Owner = 'consumer' | 'reader';

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
}

interface CountSet {
  listed: number;
  INFO_DUPLICATE: number;
  NUDGE: number;
  ACTIONABLE: number;
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

export interface Digest {
  run_id: string;
  started_at: string;
  finished_at: string;
  mode: Mode;
  recipients: string[];
  operator_owner: Owner;
  counts: Record<string, CountSet>;
  counts_by_rule: Record<string, number>;
  actionable: Record<string, unknown>[];
  nudges: Record<string, unknown>[];
  disposal_plan: { id: string; recipient: string; rule_id: string; reason: string }[];
  disposal_results: { id: string; ok: boolean; reason: string | null }[];
  alerts: AlertRow[];
  content_hash: string;
  last_run_at: string;
  run_file: string | null;
}

interface ReaderState {
  last_run_at?: string;
  content_hash?: string;
  run_file?: string | null;
  last_alert_at?: Record<string, string>;
}

export interface InboxReaderDeps {
  now?: () => Date;
  root?: string;
  listMessages?: (filters: {
    recipient: string;
    status: 'queued';
    limit: number;
  }) => Promise<InboxMessage[]>;
  disposeMessageByMachine?: (data: {
    id: string;
    actor: string;
    disposition: 'expired';
    requireNoReceipt: true;
  }) => Promise<DispatchMailboxResult | { ok: false; reason: string }>;
  registerWorker?: typeof registerWorker;
  heartbeatWorker?: typeof heartbeatWorker;
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
  const operatorOwner: Owner = env.INBOX_READER_OPERATOR_OWNER === 'reader' ? 'reader' : 'consumer';
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
    INFO_DUPLICATE: 0,
    NUDGE: 0,
    ACTIONABLE: 0,
    too_young: 0,
    acked_open: 0,
    skipped: 0,
  };
}

function markdown(digest: Digest): string {
  const lines = [
    '# Dispatch inbox reader',
    '',
    `Last run: ${digest.last_run_at}`,
    `Mode: ${digest.mode}`,
    '',
    '| Recipient | Listed | INFO_DUPLICATE | NUDGE | ACTIONABLE | Too young | Acked open | Skipped |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const recipient of digest.recipients) {
    const count = digest.counts[recipient];
    lines.push(
      `| ${recipient} | ${count.listed} | ${count.INFO_DUPLICATE} | ${count.NUDGE} | ${count.ACTIONABLE} | ${count.too_young} | ${count.acked_open} | ${count.skipped} |`
    );
  }
  lines.push('', '## ACTIONABLE', '');
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const item of digest.actionable) {
    const key = typeof item.subject_key === 'string' ? item.subject_key : 'Unkeyed';
    const values = groups.get(key) ?? [];
    values.push(item);
    groups.set(key, values);
  }
  for (const [key, values] of groups) {
    if (values.length > 1) lines.push(`### ${key}`, '');
    for (const item of values) {
      lines.push(`- ${item.id} (${item.recipient}, ${item.rule_id}): ${item.excerpt}`);
    }
  }
  lines.push('', '## Nudges', '');
  for (const nudge of digest.nudges) {
    lines.push(`- ${nudge.collapse_key} x${nudge.count} (newest ${nudge.newest_created_at})`);
  }
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
    .map(({ message, result }) => `${message.id}:${result.class}:${result.rule_id}`)
    .sort()
    .concat(plan.map(item => item.id).sort())
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

export async function runInboxReader(
  deps: InboxReaderDeps = {},
  config = resolveInboxReaderConfig(process.env)
): Promise<InboxReaderRunResult> {
  const now = deps.now ?? ((): Date => new Date());
  const started = now();
  const root = deps.root ?? join(getArchonHome(), 'inbox-reader');
  const read = deps.readText ?? ((path: string): Promise<string> => readFile(path, 'utf8'));
  const writer = deps.atomicWrite ?? atomicWrite;
  const append =
    deps.appendText ??
    ((path: string, text: string): Promise<void> => appendFile(path, text, 'utf8'));
  const list =
    deps.listMessages ??
    ((filters: {
      recipient: string;
      status: 'queued';
      limit: number;
    }): Promise<DispatchMessage[]> => listMessages(filters));
  const dispose = deps.disposeMessageByMachine ?? disposeMessageByMachine;
  const register = deps.registerWorker ?? registerWorker;
  const heartbeat = deps.heartbeatWorker ?? heartbeatWorker;
  const logger = deps.log ?? realLog;
  const errors: string[] = [];
  let skippedRace = 0;
  let digest: Digest | null = null;
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
    const classified: { message: InboxMessage; result: InboxClassification }[] = [];
    const pageInfo: { recipient: string; full: boolean }[] = [];
    let remaining = config.maxPerRun;
    for (const recipient of config.recipients) {
      counts[recipient] = emptyCounts();
      if (remaining === 0) break;
      const limit = remaining;
      let rows: InboxMessage[];
      try {
        rows = await list({ recipient, status: 'queued', limit });
      } catch (error) {
        errors.push(`list_failed:${recipient}:${(error as Error).message}`);
        throw error;
      }
      remaining -= rows.length;
      counts[recipient].listed = rows.length;
      pageInfo.push({ recipient, full: rows.length === limit });
      for (const message of rows) {
        if (
          message.status !== 'queued' ||
          message.route_disposition !== null ||
          message.addressed_at !== null
        ) {
          counts[recipient].skipped += 1;
          continue;
        }
        const result = classifyInboxMessage(message);
        classified.push({ message, result });
        counts[recipient][result.class] += 1;
        countsByRule[result.rule_id] = (countsByRule[result.rule_id] ?? 0) + 1;
      }
    }
    const actionable: Digest['actionable'] = [];
    const plan: Digest['disposal_plan'] = [];
    const nudgeMap = new Map<
      string,
      { recipient: string; collapse_key: string; ids: string[]; dates: string[] }
    >();
    for (const { message, result } of classified) {
      if (result.class === 'ACTIONABLE') {
        actionable.push({
          id: message.id,
          recipient: message.recipient,
          sender: message.sender,
          task_type: message.task_type,
          priority: message.priority ?? 'normal',
          subject_key: message.subject_key,
          created_at: message.created_at,
          age_hours: Math.max(0, (started.getTime() - Date.parse(message.created_at)) / 3_600_000),
          rule_id: result.rule_id,
          reason: result.reason,
          excerpt: message.body.replace(/\r?\n/g, ' ').slice(0, 200),
        });
        continue;
      }
      if (result.class === 'NUDGE') {
        const key = `${message.recipient}:${result.collapse_key}`;
        const group = nudgeMap.get(key) ?? {
          recipient: message.recipient,
          collapse_key: result.collapse_key ?? '',
          ids: [],
          dates: [],
        };
        group.ids.push(message.id);
        group.dates.push(message.created_at);
        nudgeMap.set(key, group);
      }
      if (message.acknowledged_at !== null) {
        counts[message.recipient].acked_open += 1;
      } else if (started.getTime() - Date.parse(message.created_at) < config.minAgeMs) {
        counts[message.recipient].too_young += 1;
      } else {
        const number = result.rule_id.startsWith('info_review')
          ? 'R1'
          : result.rule_id.startsWith('info_submit')
            ? 'R2'
            : result.rule_id.startsWith('info_ingest')
              ? 'R3'
              : result.rule_id.startsWith('nudge_taskmaster')
                ? 'R4'
                : 'R5';
        plan.push({
          id: message.id,
          recipient: message.recipient,
          rule_id: result.rule_id,
          reason: `inbox-reader ${number} ${result.rule_id}: ${result.reason}`,
        });
      }
    }
    const alerts: AlertRow[] = [];
    for (const recipient of config.recipients) {
      const stale = classified
        .filter(
          item =>
            item.message.recipient === recipient &&
            item.result.class === 'ACTIONABLE' &&
            item.message.acknowledged_at === null &&
            started.getTime() - Date.parse(item.message.created_at) >
              config.actionableAlertHours * 3_600_000
        )
        .map(item => item.message);
      if (
        stale.length > 0 &&
        !isSuppressed(
          state,
          'actionable_stale',
          recipient,
          started.getTime(),
          config.alertRepeatHours
        )
      ) {
        alerts.push(
          createAlert(
            started,
            'actionable_stale',
            recipient,
            stale,
            'unread actionable mail is stale'
          )
        );
      }
    }
    if (
      state.last_run_at &&
      started.getTime() - Date.parse(state.last_run_at) > config.gapAlertHours * 3_600_000 &&
      !isSuppressed(state, 'reader_gap', null, started.getTime(), config.alertRepeatHours)
    ) {
      alerts.push(
        createAlert(started, 'reader_gap', null, [], `previous run was ${state.last_run_at}`)
      );
    }
    const nudges = [...nudgeMap.values()].map(group => ({
      recipient: group.recipient,
      collapse_key: group.collapse_key,
      count: group.ids.length,
      newest_created_at: [...group.dates].sort().at(-1),
      oldest_created_at: [...group.dates].sort()[0],
      ids: group.ids,
    }));
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
      actionable,
      nudges,
      disposal_plan: plan,
      disposal_results: [],
      alerts: [...alerts],
      content_hash: hash,
      last_run_at: started.toISOString(),
      run_file: runRequired ? runFile : null,
    };
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
      errors.push(`digest_write_failed:${(error as Error).message}`);
      logger.error({ error }, 'digest_write_failed');
      return { digest, errors, skipped_race: skippedRace };
    }
    const successes: Record<string, number> = {};
    if (config.mode === 'enforce') {
      for (const item of plan) {
        const result = await dispose({
          id: item.id,
          actor: INBOX_READER_ACTOR,
          disposition: 'expired',
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
          if (result.reason === 'machine_actor_conflict') break;
        }
      }
    }
    for (const page of pageInfo) {
      if (!page.full) continue;
      const stuck = config.mode === 'dry-run' || (successes[page.recipient] ?? 0) === 0;
      if (
        stuck &&
        !isSuppressed(
          state,
          'page_not_advancing',
          page.recipient,
          started.getTime(),
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
            `mode=${config.mode}; INFO_DUPLICATE=${count.INFO_DUPLICATE}, NUDGE=${count.NUDGE}, ACTIONABLE=${count.ACTIONABLE}`
          )
        );
      }
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
      `${JSON.stringify({ last_run_at: started.toISOString(), content_hash: hash, run_file: digest.run_file, last_alert_at: lastAlertAt }, null, 2)}\n`
    );
    const cutoff = started.getTime() - config.retentionDays * 86_400_000;
    for (const file of await readdir(join(root, 'runs'))) {
      const parsed = Date.parse(file.slice(0, 15).replace(/(\d{8})T(\d{6})Z/, '$1T$2Z'));
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

export function buildReportFromSurfaceLines(lines: string[]): {
  counts: Record<InboxClass, number>;
  parse_errors: number;
  rows: { id: string; class: InboxClass; rule_id: string }[];
} {
  const counts: Record<InboxClass, number> = { INFO_DUPLICATE: 0, NUDGE: 0, ACTIONABLE: 0 };
  const rows: { id: string; class: InboxClass; rule_id: string }[] = [];
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
      const result = classifyInboxMessage({
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
      });
      counts[result.class] += 1;
      rows.push({ id: entry.messageId as string, class: result.class, rule_id: result.rule_id });
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

export function startInboxReader(deps: InboxReaderDeps = {}): void {
  if (timer !== undefined) return;
  const config = resolveInboxReaderConfig(process.env);
  if (config.intervalMs === 0) return;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runInboxReader(deps, config);
    } finally {
      inFlight = false;
    }
  };
  timer = setInterval(() => void tick(), config.intervalMs);
  timer.unref?.();
  void tick();
}
