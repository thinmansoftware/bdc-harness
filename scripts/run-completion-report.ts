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
  };

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const out: string[] = [];
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
  process.stdout.write(out.join('\n') + '\n');
}

main();
