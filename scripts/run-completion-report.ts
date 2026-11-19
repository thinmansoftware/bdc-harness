#!/usr/bin/env bun
/**
 * Read-only run completion report for the build lanes.
 * Usage: bun run scripts/run-completion-report.ts --days N [--as-of 'YYYY-MM-DD HH:MM:SS'] [--db PATH] [--json]
 * Exit codes: 0 ok, 2 bad arguments, 3 database unopenable or table missing.
 * See docs/operations/run-completion-report.md.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { runGitHubServiceCommand } from './github-service-exec';
import type {
  GitHubService,
  ServiceGitHubAuth,
} from '../packages/core/src/github/service-identity';
import type { IDatabase } from '../packages/core/src/db/adapters/types';
import { SqliteAdapter } from '../packages/core/src/db/adapters/sqlite';
import { rootLogger } from '../packages/paths/src/logger';

const USAGE =
  "usage: run-completion-report.ts --days N [--as-of 'YYYY-MM-DD HH:MM:SS'] [--zero-since 'YYYY-MM-DD HH:MM:SS'] [--db PATH] [--json] [--no-github]";
const MIN_SAMPLE = 20;
const LANE_LIKE = 'bdc-feature-development%';
/** Zero-tier measurement (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01). */
const ZERO_LANE = 'bdc-feature-development-zero-open';
/** First-N zero-tier runs measured for the keep-or-revert verdict. */
const ZERO_SAMPLE = 10;
/** Review-fail count at or above which the XO reverts the routing. */
const ZERO_REVERT_THRESHOLD = 3;
/** Mailboxes read by people, with no worker (drain_on_start principals). */
const MAILBOXES = ['operator', 'xo', 't3-desktop'] as const;
/** Same instant as OPERATOR_HISTORY_CUTOFF in packages/core/src/db/dispatch-routing.ts. */
const OPERATOR_HISTORY_CUTOFF = '2026-11-01T00:00:00.000Z';
const STALE_MAILBOX_HOURS = 24;

/**
 * Merged-or-owned WO completion (WO-HARNESS-COMPLETION-METRIC-MERGED-OR-OWNED-01).
 * The legacy run-completion overall line retires 14 days after this WO merged.
 * Set to the planned merge date (2026-11-06) plus 14 days, UTC midnight. While
 * as_of is before this instant the legacy overall line and json legacy_overall
 * key are shown; on or after it they are omitted.
 */
export const LEGACY_OVERALL_UNTIL = '2026-11-20';
/** Every build-lane fire's user_message starts with this (packages/smart-cauldron/src/fire.ts). */
const WO_ID_PREFIX_RE = /^WO_ID=(\S+) --project (\S+)/;
/** Service identity for the read-only GitHub join (same path as the daily posting, #1401). */
const GH_SERVICE: GitHubService = 'taskmaster';
const XO_REPO = 'thinmansoftware/bdc-xo';

function fail(code: number, msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function nowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function validAsOf(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    dt.getUTCHours() === h &&
    dt.getUTCMinutes() === mi &&
    dt.getUTCSeconds() === se
  );
}

function parseArgs(argv: string[]): {
  days: number;
  asOf: string;
  db: string;
  json: boolean;
  zeroSince: string | null;
  noGithub: boolean;
} {
  let days: number | undefined;
  let asOf = nowUtc();
  let db = '/.archon/archon.db';
  let json = false;
  let zeroSince: string | null = null;
  let noGithub = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--no-github') noGithub = true;
    else if (a === '--days' || a === '--as-of' || a === '--db' || a === '--zero-since') {
      const v = argv[++i];
      if (v === undefined) fail(2, `missing value for ${a}\n${USAGE}`);
      if (a === '--days') {
        if (!/^[1-9][0-9]*$/.test(v)) fail(2, `invalid --days: ${v}\n${USAGE}`);
        days = Number(v);
      } else if (a === '--as-of') {
        if (!validAsOf(v)) fail(2, `invalid --as-of: ${v}\n${USAGE}`);
        asOf = v;
      } else if (a === '--zero-since') {
        if (!validAsOf(v)) fail(2, `invalid --zero-since: ${v}\n${USAGE}`);
        zeroSince = v;
      } else db = v;
    } else fail(2, `unknown argument: ${a}\n${USAGE}`);
  }
  if (days === undefined) fail(2, `--days is required\n${USAGE}`);
  return { days, asOf, db, json, zeroSince, noGithub };
}

function rate(completed: number, total: number): string {
  if (total < MIN_SAMPLE) return 'insufficient';
  return `${((completed / total) * 100).toFixed(1)}%`;
}

interface Mechanism {
  name: string;
  input: number;
  outcome: number;
}

interface MailboxRow {
  recipient: string;
  depth: number;
  depth_live: number;
  oldest_live: string | null;
  oldest_live_age_hours: number | null;
}

/** Context only, never flagged: what the event store cannot show (WO-HARNESS-OUTCOME-REPORT-MEASURE-FIX-01). */
interface ActivityBlock {
  t3_activity: 'not_measured';
  t3_activity_reason: string;
  github_merged_prs_24h: Record<string, number> | 'not_measured';
}

interface Outcomes {
  activity?: ActivityBlock;
  window: { start: string; end: string };
  mechanisms: Mechanism[];
  mailboxes: MailboxRow[];
  flags: string[];
}

interface IO {
  input: number;
  outcome: number;
}

/**
 * Outcomes (last 24h): input versus outcome per harness mechanism, always over
 * the 24 hours ending at as_of, whatever --days is. Fixture SQL O1-O7 in
 * docs/operations/run-completion-report.md is the contract.
 */
function readOutcomes(db: Database, asOf: string): Outcomes {
  const w = db
    .query(
      `select strftime('%Y-%m-%dT%H:%M:%fZ', $asof, '-1 days') as ws,
              strftime('%Y-%m-%dT%H:%M:%fZ', $asof) as we`
    )
    .get({ $asof: asOf }) as { ws: string; we: string };
  const p = { $ws: w.ws, $we: w.we };
  const mechanisms: Mechanism[] = [];
  const push = (name: string, io: IO): void => {
    mechanisms.push({ name, input: io.input, outcome: io.outcome });
  };

  // O1 Taskmaster escalate_p0: proposals vs delivered.
  push(
    'taskmaster_escalate_p0',
    db
      .query(
        `select count(*) as input, coalesce(sum(outcome='sent'),0) as outcome
         from tm_journal
         where action_type='escalate_p0' and created_at >= $ws and created_at < $we`
      )
      .get(p) as IO
  );
  // O2 Overseer reviews: run_review requests vs submitted reviews. Receipts are
  // matched by body kind, any recipient: operator before the 2026-11-01 cut-off,
  // pr-review-log after it.
  push(
    'overseer_review',
    db
      .query(
        `select (select count(*) from agent_dispatch_messages
                 where task_type='run_review' and recipient='overseer-reviewer'
                   and created_at >= $ws and created_at < $we) as input,
                (select count(*) from agent_dispatch_messages
                 where created_at >= $ws and created_at < $we and json_valid(body)
                   and json_extract(body,'$.kind')='pr_review_submit_receipt'
                   and json_extract(body,'$.disposition') in ('approved','changes_requested')) as outcome`
      )
      .get(p) as IO
  );
  // O3 Overseer repairs: escalations vs repair or refire actions.
  push(
    'overseer_repair',
    db
      .query(
        `select coalesce(sum(action='escalate_with_evidence'),0) as input,
                coalesce(sum(action like '%repair%' or action like '%refire%'),0) as outcome
         from overseer_actions where created_at >= $ws and created_at < $we`
      )
      .get(p) as IO
  );
  // O4 Overseer merges, all bases (the event store does not record the PR base). The merge
  // bridge records its merge on overseer_verdicts (action_reason 'merge_executed'), and only the
  // run-linked merge manager writes overseer_actions 'merged', so BOTH are counted
  // (WO-HARNESS-OUTCOME-REPORT-MEASURE-FIX-01). Input is the merge-ready verdicts the bridge consumes.
  push(
    'overseer_merge',
    db
      .query(
        `select (select count(*) from overseer_verdicts
                 where proposed_action='flag_merge_ready'
                   and created_at >= $ws and created_at < $we) as input,
                ((select count(*) from overseer_verdicts
                  where action_reason='merge_executed'
                    and updated_at >= $ws and updated_at < $we)
                 + (select count(*) from overseer_actions
                    where action='merged' and created_at >= $ws and created_at < $we)) as outcome`
      )
      .get(p) as IO
  );
  // O5 Cauldron build-lane runs: started vs completed (the F2 filter, 24h).
  push(
    'cauldron_runs',
    db
      .query(
        `select count(*) as input, coalesce(sum(status='completed'),0) as outcome
         from remote_agent_workflow_runs
         where workflow_name like $like
           and started_at >= datetime($asof, '-1 days') and started_at < $asof`
      )
      .get({ $like: LANE_LIKE, $asof: asOf }) as IO
  );

  const mailboxes: MailboxRow[] = [];
  for (const r of MAILBOXES) {
    // O6 queued to r vs acknowledged, both inside the window.
    push(
      `mailbox_${r}`,
      db
        .query(
          `select (select count(*) from agent_dispatch_messages
                   where recipient=$r and created_at >= $ws and created_at < $we) as input,
                  (select count(*) from agent_dispatch_messages
                   where recipient=$r and acknowledged_at >= $ws and acknowledged_at < $we) as outcome`
        )
        .get({ ...p, $r: r }) as IO
    );
    // O7 depth; operator rows before the cut-off are fenced history.
    const d = db
      .query(
        `select count(*) as depth,
                coalesce(sum($r <> 'operator' or created_at >= $cut),0) as depth_live,
                min(case when $r <> 'operator' or created_at >= $cut then created_at end) as oldest_live
         from agent_dispatch_messages
         where recipient=$r and status='queued' and acknowledged_at is null and created_at < $we`
      )
      .get({ $r: r, $cut: OPERATOR_HISTORY_CUTOFF, $we: w.we }) as {
      depth: number;
      depth_live: number;
      oldest_live: string | null;
    };
    const age =
      d.oldest_live === null
        ? null
        : (
            db
              .query('select round((julianday($asof) - julianday($t)) * 24, 1) as h')
              .get({ $asof: asOf, $t: d.oldest_live }) as { h: number | null }
          ).h;
    mailboxes.push({
      recipient: r,
      depth: d.depth,
      depth_live: d.depth_live,
      oldest_live: d.oldest_live,
      oldest_live_age_hours: age,
    });
  }

  const flags: string[] = [];
  for (const m of mechanisms) {
    // A mailbox row's outcome is a person acknowledging a row, not activity: nobody acknowledges
    // operator, xo or t3-desktop mail as a workflow, so it never means "dead". stale_mailbox
    // (oldest unread older than 24 hours) is the signal for unread work.
    if (m.name.startsWith('mailbox_')) continue;
    if (m.input > 0 && m.outcome === 0) flags.push(`dead_mechanism:${m.name}`);
  }
  for (const m of mailboxes) {
    if (m.oldest_live_age_hours !== null && m.oldest_live_age_hours > STALE_MAILBOX_HOURS) {
      flags.push(`stale_mailbox:${m.recipient}`);
    }
  }
  return { window: { start: w.ws, end: w.we }, mechanisms, mailboxes, flags };
}

function flagLine(flags: string[]): string {
  return flags.length === 0
    ? 'outcome_flags: none'
    : `outcome_flags: ${flags.length} (${flags.join(', ')})`;
}

interface LaneRow {
  workflow_name: string;
  total: number;
  completed: number;
}

interface ZeroRun {
  run: string;
  status: string;
  failed_steps: string[];
}

interface ZeroTier {
  since: string;
  runs: ZeroRun[];
  failed: number;
  total: number;
  verdict: 'REVERT' | 'KEEP' | 'PENDING';
  cancelled: number;
}

/**
 * Zero-tier first-N measurement (WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01).
 *
 * Lists, in started_at order, the first ZERO_SAMPLE (10) terminal runs
 * (completed, failed, escalated) of the zero-open lane started at or after
 * `zeroSince`. failed = status failed or escalated (a run that did not pass its
 * in-lane review gates). Verdict: REVERT when failed >= 3; KEEP when 10 runs
 * exist and failed < 3; else PENDING. Cancelled runs after the cutoff are
 * excluded from the 10 and counted separately. Read-only.
 */
function readZeroTier(db: Database, zeroSince: string): ZeroTier {
  const rows = db
    .query(
      `select id, status from remote_agent_workflow_runs
       where workflow_name = $lane and started_at >= $since
         and status in ('completed','failed','escalated')
       order by started_at, id
       limit $limit`
    )
    .all({ $lane: ZERO_LANE, $since: zeroSince, $limit: ZERO_SAMPLE }) as {
    id: string;
    status: string;
  }[];

  const stepsQuery = db.query(
    `select coalesce(step_name,'(null)') as step_name
     from remote_agent_workflow_events
     where workflow_run_id = $id and event_type = 'node_failed'
     order by step_index, step_name`
  );

  const runs: ZeroRun[] = rows.map(r => {
    const steps = stepsQuery.all({ $id: r.id }) as { step_name: string }[];
    return {
      run: r.id.slice(0, 8),
      status: r.status,
      failed_steps: steps.map(s => s.step_name),
    };
  });

  const failed = runs.filter(r => r.status === 'failed' || r.status === 'escalated').length;
  const total = runs.length;
  const cancelled = (
    db
      .query(
        `select count(*) as n from remote_agent_workflow_runs
         where workflow_name = $lane and started_at >= $since and status = 'cancelled'`
      )
      .get({ $lane: ZERO_LANE, $since: zeroSince }) as { n: number }
  ).n;

  let verdict: ZeroTier['verdict'];
  if (failed >= ZERO_REVERT_THRESHOLD) verdict = 'REVERT';
  else if (total === ZERO_SAMPLE) verdict = 'KEEP';
  else verdict = 'PENDING';

  return { since: zeroSince, runs, failed, total, verdict, cancelled };
}

export interface WoUnits {
  units: Map<string, Set<string>>;
  unattributed: number;
}

/**
 * Attribute in-window build runs to WO IDs. Each run's user_message must start
 * with `WO_ID=<id> --project <project>` (fire.ts requiredPrefix). Runs that do
 * not match are counted as unattributed and excluded from the unit set. A WO
 * fired many times, or across projects, is one unit holding a set of projects.
 */
export function attributeRuns(db: Database, asOf: string, dayArg: string): WoUnits {
  const rows = db
    .query(
      `select user_message as um from remote_agent_workflow_runs
       where workflow_name like $like and started_at >= datetime($asof, $d) and started_at < $asof`
    )
    .all({ $like: LANE_LIKE, $asof: asOf, $d: dayArg }) as { um: string | null }[];
  const units = new Map<string, Set<string>>();
  let unattributed = 0;
  for (const r of rows) {
    const m = r.um ? WO_ID_PREFIX_RE.exec(r.um) : null;
    if (!m) {
      unattributed++;
      continue;
    }
    const woId = m[1];
    const project = m[2];
    let projects = units.get(woId);
    if (!projects) {
      projects = new Set<string>();
      units.set(woId, projects);
    }
    projects.add(project);
  }
  return { units, unattributed };
}

type GhExecute = (
  command: string[],
  env: Record<string, string | undefined>
) => { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };

export interface GitHubInjection {
  execute?: GhExecute;
  identity?: ServiceGitHubAuth;
  db?: IDatabase;
}

export type WoCompletion =
  | {
      available: true;
      den: number;
      num: number;
      merged: number;
      owned: number;
      neither: number;
      rate: string;
      neither_wos: string[];
    }
  | { available: false; reason: string };

interface GhIssue {
  title?: string;
  state?: string;
  assignees?: ({ login?: string } | null)[];
  labels?: ({ name?: string } | string)[];
  pull_request?: unknown;
}
interface GhPull {
  title?: string;
  body?: string | null;
  merged_at?: string | null;
  head?: { ref?: string } | null;
}

/** Auth or quota failure: the whole GitHub section is unavailable with this reason. */
class GhAccessError extends Error {}
/** A collection could not be fully retrieved (count mismatch or a failed page). */
class GhIncompleteError extends Error {
  constructor(public collection: string) {
    super(`incomplete:${collection}`);
  }
}

const ACCESS_RE =
  /rate limit|abuse detection|bad credentials|HTTP 401|HTTP 403|not accessible|authentication failed/i;

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find(l => l.trim().length > 0);
  return (line ?? s).trim();
}

/** gh `--paginate --slurp` yields an array of per-page responses; flatten one level. */
function flattenPages(parsed: unknown): unknown[] {
  if (!Array.isArray(parsed)) return parsed == null ? [] : [parsed];
  const out: unknown[] = [];
  for (const page of parsed) {
    if (Array.isArray(page)) out.push(...page);
    else if (page != null) out.push(page);
  }
  return out;
}

async function ghCommand(args: string[], inj: GitHubInjection): Promise<string> {
  const res = await runGitHubServiceCommand({
    service: GH_SERVICE,
    command: 'gh',
    args,
    ...(inj.execute ? { execute: inj.execute } : {}),
    ...(inj.identity ? { identity: inj.identity } : {}),
    ...(inj.db ? { db: inj.db } : {}),
  });
  if (res.exitCode !== 0) {
    const err = firstLine(new TextDecoder().decode(res.stderr));
    const reason = err || `gh exited ${res.exitCode}`;
    if (ACCESS_RE.test(reason)) throw new GhAccessError(reason);
    throw new Error(reason);
  }
  return new TextDecoder().decode(res.stdout);
}

/** Complete paginated list for one collection; any failure short of success is incomplete. */
async function collectList(
  collection: string,
  args: string[],
  inj: GitHubInjection
): Promise<unknown[]> {
  try {
    const text = (await ghCommand(args, inj)).trim();
    return flattenPages(text ? JSON.parse(text) : []);
  } catch (e) {
    if (e instanceof GhAccessError) throw e;
    throw new GhIncompleteError(collection);
  }
}

/** total_count of a search population; used only to prove the list is complete. */
async function searchCount(collection: string, q: string, inj: GitHubInjection): Promise<number> {
  try {
    const text = await ghCommand(['api', 'search/issues', '-X', 'GET', '-f', `q=${q}`], inj);
    const parsed = JSON.parse(text.trim()) as { total_count?: number };
    if (typeof parsed.total_count !== 'number') throw new GhIncompleteError(collection);
    return parsed.total_count;
  } catch (e) {
    if (e instanceof GhAccessError || e instanceof GhIncompleteError) throw e;
    throw new GhIncompleteError(collection);
  }
}

function prMatches(p: GhPull, needle: string): boolean {
  const hay = `${p.title ?? ''}\n${p.body ?? ''}\n${p.head?.ref ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

function hasOwner(issue: GhIssue): boolean {
  const assignees = (issue.assignees ?? []).filter(a => a != null);
  if (assignees.length > 0) return true;
  for (const l of issue.labels ?? []) {
    const name = typeof l === 'string' ? l : (l?.name ?? '');
    if (name.startsWith('owner:')) return true;
  }
  return false;
}

/** Repositories the merge path covers (the DEFAULT_MERGE_REPO_POLICY keys in packages/overseer). */
const ACTIVITY_REPOS = [
  'bdc-harness',
  'bdc-xo',
  'lspro-react',
  'shopops',
  'shopops-storefront',
] as const;

/**
 * Activity context for the last 24 hours. T3 threads write nothing to the event store, so T3 activity
 * is reported as not_measured with the reason, never as zero. GitHub-merged PR counts per repository
 * are context so a quiet event store is not read as no work; they come through the report's existing
 * read-only GitHub join and are not_measured under --no-github or when any repository cannot be read.
 */
export async function computeActivity(
  window: { start: string; end: string },
  opts: { noGithub: boolean } & GitHubInjection
): Promise<ActivityBlock> {
  const block: ActivityBlock = {
    t3_activity: 'not_measured',
    t3_activity_reason: 'T3 threads do not write to the event store',
    github_merged_prs_24h: 'not_measured',
  };
  if (opts.noGithub) return block;
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const counts: Record<string, number> = {};
  // Same read-only contract as computeWoCompletion: GitHub calls are metered, and left to default the
  // meter would write github_api_usage rows to the production archon.db. Route metering to a throwaway
  // in-memory sink (unless the caller injected one) and silence its info logs, which the root logger
  // writes to stdout and would break --json.
  const ownsMeterDb = opts.db === undefined;
  const prevLogLevel = rootLogger.level;
  if (ownsMeterDb) rootLogger.level = 'silent';
  const meterDb = opts.db ?? new SqliteAdapter(':memory:');
  const inj: GitHubInjection = {
    ...(opts.execute ? { execute: opts.execute } : {}),
    ...(opts.identity ? { identity: opts.identity } : {}),
    db: meterDb,
  };
  try {
    for (const repo of ACTIVITY_REPOS) {
      const text = (
        await ghCommand(
          [
            'pr',
            'list',
            '--repo',
            `thinmansoftware/${repo}`,
            '--state',
            'merged',
            '--search',
            `merged:>=${window.start.slice(0, 10)}`,
            '--limit',
            '300',
            '--json',
            'number,mergedAt',
          ],
          inj
        )
      ).trim();
      const list = JSON.parse(text || '[]') as { mergedAt?: string | null }[];
      counts[`thinmansoftware/${repo}`] = list.filter(pr => {
        const at = pr.mergedAt ? Date.parse(pr.mergedAt) : Number.NaN;
        return Number.isFinite(at) && at >= startMs && at < endMs;
      }).length;
    }
  } catch {
    return block;
  } finally {
    rootLogger.level = prevLogLevel;
    if (ownsMeterDb) await meterDb.close();
  }
  return { ...block, github_merged_prs_24h: counts };
}

/**
 * Merged-or-owned WO completion, joined to GitHub via runGitHubServiceCommand.
 * Numerator = merged (a merged PR in one of the WO's projects names the WO ID in
 * its title, body or head branch, case-insensitive, merged at or before asOf,
 * any date) plus owned (not merged, and the bdc-xo issue titled exactly the WO
 * ID is OPEN with at least one assignee or an `owner:` label). Denominator = all
 * units. Retrieval is complete (every page, no date lower bound, no item cap) and
 * checked against the GitHub search total_count; any gap, failed page or auth or
 * quota error yields unavailable, never a partial number. Read-only.
 */
export async function computeWoCompletion(
  units: Map<string, Set<string>>,
  asOf: string,
  opts: { noGithub: boolean } & GitHubInjection
): Promise<WoCompletion> {
  const den = units.size;
  if (opts.noGithub) return { available: false, reason: 'no-github' };
  if (den === 0)
    return {
      available: true,
      den: 0,
      num: 0,
      merged: 0,
      owned: 0,
      neither: 0,
      rate: rate(0, 0),
      neither_wos: [],
    };
  // Read-only contract (docs/operations/run-completion-report.md: "nothing is
  // written"). runGitHubServiceCommand meters every call and flushes those rows
  // to its db; left to default it would be getDatabase(), writing
  // github_api_usage/github_api_pool_state to the production archon.db during a
  // report that promises to write nothing. Route metering to a throwaway
  // in-memory sink unless the caller injected its own db (the tests do). The
  // call still goes through the metered taskmaster identity; only the durable
  // write is discarded. Closed in finally so the handle never leaks.
  const ownsMeterDb = opts.db === undefined;
  // The throwaway sink's schema init logs at info, and the root Pino logger
  // writes to stdout, so those records would precede the --json report and break
  // JSON.parse in machine consumers. Silence logging for the whole default-path
  // join (the adapter's lazy child logger is created silent during construction);
  // the previous level is restored in finally.
  const prevLogLevel = rootLogger.level;
  if (ownsMeterDb) rootLogger.level = 'silent';
  const meterDb = opts.db ?? new SqliteAdapter(':memory:');
  const inj: GitHubInjection = {
    ...(opts.execute ? { execute: opts.execute } : {}),
    ...(opts.identity ? { identity: opts.identity } : {}),
    db: meterDb,
  };
  const asOfMs = Date.parse(asOf.replace(' ', 'T') + 'Z');
  try {
    // (a) all bdc-xo WO issues, every state, complete pagination.
    const issueItems = (await collectList(
      'issues',
      ['api', '--paginate', '--slurp', `repos/${XO_REPO}/issues?labels=wo&state=all&per_page=100`],
      inj
    )) as GhIssue[];
    // The issues endpoint also returns PRs; keep only real issues to match is:issue.
    const issues = issueItems.filter(i => i != null && i.pull_request == null);
    const issueTotal = await searchCount('issues', `repo:${XO_REPO} label:wo is:issue`, inj);
    if (issues.length !== issueTotal) return { available: false, reason: 'incomplete:issues' };
    const issueByTitle = new Map<string, GhIssue>();
    for (const i of issues) if (typeof i.title === 'string') issueByTitle.set(i.title, i);

    // (b) merged PRs per distinct project, complete pagination.
    const projects = [...new Set(Array.from(units.values()).flatMap(s => Array.from(s)))].sort();
    const mergedByProject = new Map<string, GhPull[]>();
    for (const project of projects) {
      const repo = `thinmansoftware/${project}`;
      const col = `pulls:${project}`;
      const pullItems = (await collectList(
        col,
        ['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=closed&per_page=100`],
        inj
      )) as GhPull[];
      const merged = pullItems.filter(
        (p): p is GhPull & { merged_at: string } => p?.merged_at != null
      );
      const mergedTotal = await searchCount(col, `repo:${repo} is:pr is:merged`, inj);
      if (merged.length !== mergedTotal) return { available: false, reason: `incomplete:${col}` };
      mergedByProject.set(
        project,
        merged.filter(p => Date.parse(p.merged_at) <= asOfMs)
      );
    }

    // classify: merged > owned > neither.
    let merged = 0;
    let owned = 0;
    const neitherWos: string[] = [];
    const entries = Array.from(units.entries()).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    );
    for (const [woId, projSet] of entries) {
      const needle = woId.toLowerCase();
      let isMerged = false;
      for (const project of projSet) {
        const pulls = mergedByProject.get(project) ?? [];
        if (pulls.some(p => prMatches(p, needle))) {
          isMerged = true;
          break;
        }
      }
      if (isMerged) {
        merged++;
        continue;
      }
      const issue = issueByTitle.get(woId);
      if (issue && (issue.state ?? '').toLowerCase() === 'open' && hasOwner(issue)) {
        owned++;
        continue;
      }
      neitherWos.push(woId);
    }
    const num = merged + owned;
    return {
      available: true,
      den,
      num,
      merged,
      owned,
      neither: neitherWos.length,
      rate: rate(num, den),
      neither_wos: neitherWos,
    };
  } catch (e) {
    if (e instanceof GhIncompleteError) return { available: false, reason: e.message };
    if (e instanceof GhAccessError) return { available: false, reason: firstLine(e.message) };
    return { available: false, reason: firstLine(e instanceof Error ? e.message : String(e)) };
  } finally {
    if (ownsMeterDb) {
      await meterDb.close();
      rootLogger.level = prevLogLevel;
    }
  }
}

async function main(): Promise<void> {
  const { days, asOf, db: dbPath, json, zeroSince, noGithub } = parseArgs(process.argv.slice(2));
  if (!existsSync(dbPath)) fail(3, `database not found: ${dbPath}`);
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec('PRAGMA query_only = ON');
  } catch (e) {
    return fail(3, `cannot open database ${dbPath}: ${(e as Error).message}`);
  }

  const dayArg = `-${days} days`;
  let lanes: LaneRow[];
  let overall: { total: number; completed: number | null };
  let steps: { step_name: string; runs: number }[];
  let noOutcome: { failed_without_outcome: number };
  let actions: { action: string; count: number }[];
  let start: string;
  let outcomes: Outcomes;
  let zeroTier: ZeroTier | null = null;
  let attribution: WoUnits = { units: new Map(), unattributed: 0 };
  try {
    start = (
      db.query('select datetime($asof, $d) as s').get({ $asof: asOf, $d: dayArg }) as {
        s: string;
      }
    ).s;
    const p = { $like: LANE_LIKE, $asof: asOf, $d: dayArg };
    lanes = db
      .query(
        `select workflow_name, count(*) as total, coalesce(sum(status='completed'),0) as completed
         from remote_agent_workflow_runs
         where workflow_name like $like and started_at >= datetime($asof, $d) and started_at < $asof
         group by workflow_name order by workflow_name`
      )
      .all(p) as LaneRow[];
    overall = db
      .query(
        `select count(*) as total, coalesce(sum(status='completed'),0) as completed
         from remote_agent_workflow_runs
         where workflow_name like $like and started_at >= datetime($asof, $d) and started_at < $asof`
      )
      .get(p) as { total: number; completed: number };
    steps = db
      .query(
        `select coalesce(e.step_name,'(null)') as step_name, count(distinct e.workflow_run_id) as runs
         from remote_agent_workflow_events e
         join remote_agent_workflow_runs r on r.id = e.workflow_run_id
         where r.workflow_name like $like and r.started_at >= datetime($asof, $d) and r.started_at < $asof
           and e.event_type = 'node_failed'
         group by coalesce(e.step_name,'(null)') order by runs desc, step_name`
      )
      .all(p) as { step_name: string; runs: number }[];
    noOutcome = db
      .query(
        `select count(*) as failed_without_outcome
         from remote_agent_workflow_runs r
         where r.workflow_name like $like and r.started_at >= datetime($asof, $d) and r.started_at < $asof
           and r.status in ('failed','escalated')
           and not exists (select 1 from remote_agent_run_outcomes o where o.run_id = r.id)`
      )
      .get(p) as { failed_without_outcome: number };
    actions = db
      .query(
        `select action, count(*) as count from overseer_actions
         where created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', $asof, $d)
           and created_at < strftime('%Y-%m-%dT%H:%M:%fZ', $asof)
         group by action order by action`
      )
      .all({ $asof: asOf, $d: dayArg }) as { action: string; count: number }[];
    outcomes = readOutcomes(db, asOf);
    if (zeroSince !== null) zeroTier = readZeroTier(db, zeroSince);
    attribution = attributeRuns(db, asOf, dayArg);
  } catch (e) {
    return fail(3, `query failed on ${dbPath}: ${(e as Error).message}`);
  } finally {
    db.close();
  }

  const woCompletion = await computeWoCompletion(attribution.units, asOf, { noGithub });
  outcomes.activity = await computeActivity(outcomes.window, { noGithub });
  const asOfMs = Date.parse(asOf.replace(' ', 'T') + 'Z');
  const legacyUntilMs = Date.parse(LEGACY_OVERALL_UNTIL + 'T00:00:00Z');
  const showLegacy = asOfMs < legacyUntilMs;

  const completed = overall.completed ?? 0;
  const legacyRate = rate(completed, overall.total);
  const report = {
    window: { as_of: asOf, days, start },
    total: overall.total,
    completed,
    rate: legacyRate,
    ...(showLegacy
      ? { legacy_overall: { total: overall.total, completed, rate: legacyRate } }
      : {}),
    lanes: lanes.map(l => ({ ...l, rate: rate(l.completed, l.total) })),
    failing_steps: steps,
    failed_without_outcome: noOutcome.failed_without_outcome,
    overseer_actions: actions,
    unattributed_runs: attribution.unattributed,
    wo_completion: woCompletion,
    outcome_flag_line: flagLine(outcomes.flags),
    outcomes,
    ...(zeroTier ? { zero_tier: zeroTier } : {}),
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const out: string[] = [];
  out.push(report.outcome_flag_line);
  out.push(`window: ${start} to ${asOf} (${days} days, UTC)`);
  if (showLegacy)
    out.push(
      `overall (legacy run completion, retiring ${LEGACY_OVERALL_UNTIL}): ` +
        `${report.completed}/${report.total} completed, rate ${report.rate}`
    );
  if (woCompletion.available) {
    out.push(
      `wo_merged_or_owned: ${woCompletion.num}/${woCompletion.den} rate ${woCompletion.rate}`
    );
    out.push(
      `wo_breakdown: merged ${woCompletion.merged}, owned ${woCompletion.owned}, ` +
        `neither ${woCompletion.neither}`
    );
    out.push('wo_neither:');
    for (const w of woCompletion.neither_wos) out.push(`  ${w}`);
  } else {
    out.push(`wo_merged_or_owned: unavailable (${woCompletion.reason})`);
  }
  out.push(`unattributed_runs: ${report.unattributed_runs}`);
  out.push('lanes:');
  for (const l of report.lanes)
    out.push(`  ${l.workflow_name}: ${l.completed}/${l.total} completed, rate ${l.rate}`);
  out.push('failing_steps:');
  for (const s of report.failing_steps) out.push(`  ${s.step_name}: ${s.runs}`);
  out.push(`failed_without_outcome: ${report.failed_without_outcome}`);
  out.push('overseer_actions:');
  for (const a of report.overseer_actions) out.push(`  ${a.action}: ${a.count}`);
  out.push(`outcomes (last 24h): ${outcomes.window.start} to ${outcomes.window.end}`);
  for (const m of outcomes.mechanisms)
    out.push(`  ${m.name}: input ${m.input}, outcome ${m.outcome}`);
  for (const m of outcomes.mailboxes)
    out.push(
      `  mailbox ${m.recipient}: depth ${m.depth}, live ${m.depth_live}, ` +
        `oldest_live ${m.oldest_live ?? 'none'}, age_h ${m.oldest_live_age_hours ?? 'none'}`
    );
  out.push(
    '  note: mailbox outcomes are people acknowledging rows, not activity; a mailbox never raises ' +
      'dead_mechanism (stale_mailbox covers unread age)'
  );
  if (outcomes.activity) {
    out.push('activity (context only, never flagged):');
    out.push(
      `  t3_activity: ${outcomes.activity.t3_activity} (${outcomes.activity.t3_activity_reason})`
    );
    const gh = outcomes.activity.github_merged_prs_24h;
    out.push(
      '  github_merged_prs_24h: ' +
        (gh === 'not_measured'
          ? 'not_measured'
          : Object.entries(gh)
              .map(([repo, n]) => `${repo}=${n}`)
              .join(', '))
    );
  }
  if (zeroTier) {
    out.push(`zero_tier (since ${zeroTier.since}):`);
    out.push('zero_tier_first10:');
    for (const r of zeroTier.runs) {
      const stepsText = r.failed_steps.length === 0 ? '' : ` [steps: ${r.failed_steps.join(', ')}]`;
      out.push(`  ${r.run} ${r.status}${stepsText}`);
    }
    out.push(`zero_tier_failed: ${zeroTier.failed}/${zeroTier.total}`);
    out.push(
      `zero_tier_verdict: ${zeroTier.verdict}` +
        (zeroTier.verdict === 'PENDING' ? ` ${zeroTier.total}/${ZERO_SAMPLE}` : '')
    );
    out.push(`zero_tier_cancelled: ${zeroTier.cancelled}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (import.meta.main) {
  main().catch(e => fail(3, `unexpected: ${(e as Error).message}`));
}
