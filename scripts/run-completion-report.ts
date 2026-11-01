#!/usr/bin/env bun
/**
 * Read-only run completion report for the build lanes.
 * Usage: bun run scripts/run-completion-report.ts --days N [--as-of 'YYYY-MM-DD HH:MM:SS'] [--db PATH] [--json]
 * Exit codes: 0 ok, 2 bad arguments, 3 database unopenable or table missing.
 * See docs/operations/run-completion-report.md.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';

const USAGE =
  "usage: run-completion-report.ts --days N [--as-of 'YYYY-MM-DD HH:MM:SS'] [--db PATH] [--json]";
const MIN_SAMPLE = 20;
const LANE_LIKE = 'bdc-feature-development%';
/** Mailboxes read by people, with no worker (drain_on_start principals). */
const MAILBOXES = ['operator', 'xo', 't3-desktop'] as const;
/** Same instant as OPERATOR_HISTORY_CUTOFF in packages/core/src/db/dispatch-routing.ts. */
const OPERATOR_HISTORY_CUTOFF = '2026-11-01T00:00:00.000Z';
const STALE_MAILBOX_HOURS = 24;

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

function parseArgs(argv: string[]): { days: number; asOf: string; db: string; json: boolean } {
  let days: number | undefined;
  let asOf = nowUtc();
  let db = '/.archon/archon.db';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--days' || a === '--as-of' || a === '--db') {
      const v = argv[++i];
      if (v === undefined) fail(2, `missing value for ${a}\n${USAGE}`);
      if (a === '--days') {
        if (!/^[1-9][0-9]*$/.test(v)) fail(2, `invalid --days: ${v}\n${USAGE}`);
        days = Number(v);
      } else if (a === '--as-of') {
        if (!validAsOf(v)) fail(2, `invalid --as-of: ${v}\n${USAGE}`);
        asOf = v;
      } else db = v;
    } else fail(2, `unknown argument: ${a}\n${USAGE}`);
  }
  if (days === undefined) fail(2, `--days is required\n${USAGE}`);
  return { days, asOf, db, json };
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

interface Outcomes {
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
  // O4 Overseer merges, all bases (the event store does not record the PR base).
  push(
    'overseer_merge',
    db
      .query(
        `select coalesce(sum(action='flag_merge_ready'),0) as input,
                coalesce(sum(action='merged'),0) as outcome
         from overseer_actions where created_at >= $ws and created_at < $we`
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

function main(): void {
  const { days, asOf, db: dbPath, json } = parseArgs(process.argv.slice(2));
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
  } catch (e) {
    return fail(3, `query failed on ${dbPath}: ${(e as Error).message}`);
  } finally {
    db.close();
  }

  const completed = overall.completed ?? 0;
  const report = {
    window: { as_of: asOf, days, start },
    total: overall.total,
    completed,
    rate: rate(completed, overall.total),
    lanes: lanes.map(l => ({ ...l, rate: rate(l.completed, l.total) })),
    failing_steps: steps,
    failed_without_outcome: noOutcome.failed_without_outcome,
    overseer_actions: actions,
    outcome_flag_line: flagLine(outcomes.flags),
    outcomes,
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const out: string[] = [];
  out.push(report.outcome_flag_line);
  out.push(`window: ${start} to ${asOf} (${days} days, UTC)`);
  out.push(`overall: ${report.completed}/${report.total} completed, rate ${report.rate}`);
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
  process.stdout.write(out.join('\n') + '\n');
}

main();
