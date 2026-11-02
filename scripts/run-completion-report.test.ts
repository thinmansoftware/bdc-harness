import { afterAll, describe, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { attributeRuns, computeWoCompletion, LEGACY_OVERALL_UNTIL } from './run-completion-report';
import { SqliteAdapter } from '../packages/core/src/db/adapters/sqlite';
import { resetGitHubApiMeterForTests } from '../packages/core/src/github/metering';
import * as dbConnection from '../packages/core/src/db/connection';

const SCRIPT = join(import.meta.dir, 'run-completion-report.ts');
const AS_OF = '2026-11-01 14:30:00';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SCHEMA = `
create table remote_agent_workflow_runs (id text primary key, workflow_name text not null, status text not null default 'pending', started_at text default (datetime('now')), user_message text not null default '');
create table remote_agent_workflow_events (id text primary key, workflow_run_id text not null, event_type text not null, step_index integer, step_name text, data text, created_at text);
create table remote_agent_run_outcomes (run_id text primary key, execution_state text);
create table overseer_actions (id text primary key, run_id text, wo_id text, class text, action text, result text not null, created_at text not null);
create table tm_journal (id text primary key, created_at text not null, thread_ref text not null, action_type text not null, proposal_json text not null, outcome text not null);
create table agent_dispatch_messages (id text primary key, correlation_id text not null, idempotency_key text not null, task_type text not null, sender text not null, recipient text not null, body text not null, status text not null default 'queued', created_at text not null, acknowledged_at text);
`;
const SCHEMA_NO_OVERSEER = SCHEMA.split('\n')
  .filter(l => !l.includes('overseer_actions'))
  .join('\n');

function newDb(withOverseer = true): { path: string; db: Database } {
  const dir = mkdtempSync(join(tmpdir(), 'rcr-'));
  dirs.push(dir);
  const path = join(dir, 'archon.db');
  const db = new Database(path);
  db.exec(withOverseer ? SCHEMA : SCHEMA_NO_OVERSEER);
  return { path, db };
}

let seq = 0;
function run(db: Database, lane: string, status: string, startedAt: string): string {
  const id = `r${++seq}`;
  db.query(
    'insert into remote_agent_workflow_runs (id, workflow_name, status, started_at) values (?,?,?,?)'
  ).run(id, lane, status, startedAt);
  return id;
}
function nodeFailed(db: Database, runId: string, step: string | null): void {
  db.query(
    "insert into remote_agent_workflow_events (id, workflow_run_id, event_type, step_name) values (?,?,'node_failed',?)"
  ).run(`e${++seq}`, runId, step);
}
function act(db: Database, action: string, createdAt: string): void {
  db.query(
    "insert into overseer_actions (id, action, result, created_at) values (?,?, 'ok', ?)"
  ).run(`a${++seq}`, action, createdAt);
}

function exec(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(['bun', 'run', SCRIPT, ...args]);
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}
const base = (path: string, extra: string[] = []): string[] => [
  '--days',
  '7',
  '--as-of',
  AS_OF,
  '--db',
  path,
  ...extra,
];

// Hand queries F1-F5 from the WO spec, run independently of the script.
const P = { $a: AS_OF, $d: '-7 days' };
function fixtures(path: string): Record<string, any> {
  const db = new Database(path, { readonly: true });
  const w =
    "workflow_name like 'bdc-feature-development%' and started_at >= datetime($a,$d) and started_at < $a";
  const f1 = db
    .query(
      `select workflow_name, count(*) as total, sum(status='completed') as completed from remote_agent_workflow_runs where ${w} group by workflow_name order by workflow_name`
    )
    .all(P);
  const f2 = db
    .query(
      `select count(*) as total, sum(status='completed') as completed from remote_agent_workflow_runs where ${w}`
    )
    .get(P);
  const f3 = db
    .query(
      `select coalesce(e.step_name,'(null)') as step_name, count(distinct e.workflow_run_id) as runs from remote_agent_workflow_events e join remote_agent_workflow_runs r on r.id = e.workflow_run_id where r.workflow_name like 'bdc-feature-development%' and r.started_at >= datetime($a,$d) and r.started_at < $a and e.event_type = 'node_failed' group by coalesce(e.step_name,'(null)') order by runs desc, step_name`
    )
    .all(P);
  const f4 = db
    .query(
      `select count(*) as n from remote_agent_workflow_runs r where r.workflow_name like 'bdc-feature-development%' and r.started_at >= datetime($a,$d) and r.started_at < $a and r.status in ('failed','escalated') and not exists (select 1 from remote_agent_run_outcomes o where o.run_id = r.id)`
    )
    .get(P) as { n: number };
  const f5 = db
    .query(
      `select action, count(*) as count from overseer_actions where created_at >= strftime('%Y-%m-%dT%H:%M:%fZ',$a,$d) and created_at < strftime('%Y-%m-%dT%H:%M:%fZ',$a) group by action order by action`
    )
    .all(P);
  db.close();
  return { f1, f2, f3, f4: f4.n, f5 };
}

const LANES = [
  'bdc-feature-development',
  'bdc-feature-development-codex',
  'bdc-feature-development-cursor',
];
const STATUSES = ['completed', 'failed', 'escalated', 'cancelled', 'running'];

describe('run-completion-report', () => {
  test('Test 1: report equals fixture SQL', () => {
    const { path, db } = newDb();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(
        run(
          db,
          LANES[i % 3]!,
          STATUSES[(i * 2 + (i % 3)) % 5]!,
          `2026-10-${28 + (i % 3)} 0${i % 9}:15:00`
        )
      );
    }
    nodeFailed(db, ids[1]!, 'repair-gate-fail');
    nodeFailed(db, ids[1]!, 'repair-gate-fail');
    nodeFailed(db, ids[2]!, 'repair-gate-fail');
    nodeFailed(db, ids[3]!, 'manifest-evidence-check');
    nodeFailed(db, ids[4]!, null);
    for (let i = 0; i < 5; i++) {
      db.query(
        "insert into remote_agent_run_outcomes (run_id, execution_state) values (?, 'x')"
      ).run(ids[i]!);
    }
    act(db, 'verdict_write', '2026-10-30T10:00:00.000Z');
    act(db, 'verdict_write', '2026-10-31T10:00:00.000Z');
    act(db, 'comment_findings', '2026-10-31T11:00:00.000Z');
    act(db, 'escalate_with_evidence', '2026-10-29T11:00:00.000Z');
    db.close();

    const r = exec(base(path, ['--json']));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    const f = fixtures(path);
    expect(f.f2.total).toBe(30);
    expect(j.total).toBe(f.f2.total);
    expect(j.completed).toBe(f.f2.completed);
    expect(
      j.lanes.map((l: any) => ({
        workflow_name: l.workflow_name,
        total: l.total,
        completed: l.completed,
      }))
    ).toEqual(f.f1);
    expect(j.failing_steps).toEqual(f.f3);
    expect(j.failing_steps.find((s: any) => s.step_name === 'repair-gate-fail').runs).toBe(2);
    expect(j.failing_steps.some((s: any) => s.step_name === '(null)')).toBe(true);
    expect(j.failed_without_outcome).toBe(f.f4);
    expect(j.overseer_actions).toEqual(f.f5);
    expect(j.overseer_actions.length).toBe(3);
  });

  test('Test 2: insufficient sample', () => {
    const { path, db } = newDb();
    for (let i = 0; i < 12; i++) {
      run(db, LANES[0]!, i < 6 ? 'completed' : 'failed', '2026-10-30 10:00:00');
    }
    for (let i = 0; i < 25; i++) {
      run(db, LANES[1]!, i < 20 ? 'completed' : 'failed', '2026-10-30 11:00:00');
    }
    db.close();
    const j = JSON.parse(exec(base(path, ['--json'])).out);
    expect(j.lanes).toHaveLength(2);
    expect(j.lanes[0].rate).toBe('insufficient');
    expect(j.lanes[0].total).toBe(12);
    expect(j.lanes[1].rate).toBe('80.0%');
    expect(j.total).toBe(37);
    expect(j.rate).toBe('70.3%');
    const t = exec(base(path));
    expect(t.out).toContain('bdc-feature-development: 6/12 completed, rate insufficient');
    expect(t.out).toContain('bdc-feature-development-codex: 20/25 completed, rate 80.0%');
    // AS_OF is before LEGACY_OVERALL_UNTIL, so the overall line is shown relabelled.
    expect(t.out).toContain(
      `overall (legacy run completion, retiring ${LEGACY_OVERALL_UNTIL}): 26/37 completed, rate 70.3%`
    );
  });

  test('Test 3: window and timestamp-format boundaries', () => {
    const { path, db } = newDb();
    run(db, LANES[0]!, 'completed', AS_OF);
    run(db, LANES[0]!, 'completed', '2026-10-25 14:30:00');
    run(db, LANES[0]!, 'completed', '2026-10-25 14:29:59');
    run(db, LANES[0]!, 'completed', '2026-10-25 14:30:01');
    run(db, LANES[0]!, 'completed', '2026-11-01 14:29:59');
    run(db, 'archon-assist', 'completed', '2026-10-30 10:00:00');
    act(db, 'a', '2026-10-25T14:30:00.000Z');
    act(db, 'b', '2026-10-25T14:29:59.000Z');
    act(db, 'c', '2026-11-01T14:30:00.000Z');
    act(db, 'd', '2026-11-01T14:29:59.000Z');
    db.close();
    const j = JSON.parse(exec(base(path, ['--json'])).out);
    expect(j.total).toBe(3);
    expect(j.lanes).toHaveLength(1);
    expect(j.overseer_actions.map((a: any) => a.action)).toEqual(['a', 'd']);
    expect(j.overseer_actions).toEqual(fixtures(path).f5);
  });

  test('Test 4: read-only', () => {
    const { path, db } = newDb();
    for (let i = 0; i < 5; i++) run(db, LANES[0]!, 'completed', '2026-10-30 10:00:00');
    db.close();
    const sha = (): string => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = sha();
    for (let i = 0; i < 3; i++) expect(exec(base(path)).code).toBe(0);
    expect(sha()).toBe(before);
    expect(existsSync(path + '-wal')).toBe(false);
    expect(existsSync(path + '-journal')).toBe(false);
    const src = readFileSync(SCRIPT, 'utf8');
    for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER']) {
      expect(new RegExp(`\\b${kw}\\b`, 'i').test(src)).toBe(false);
    }
    expect(src).toContain('query_only');
  });

  test('Test 5: argument and database errors', () => {
    const { path, db } = newDb();
    db.close();
    const noTable = newDb(false);
    noTable.db.close();
    for (const args of [
      ['--days', '0', '--db', path],
      ['--days', 'abc', '--db', path],
      ['--days', '7', '--as-of', '2026-13-40', '--db', path],
    ]) {
      const r = exec(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('usage:');
      expect(r.out).toBe('');
    }
    const missing = join(tmpdir(), 'rcr-does-not-exist.db');
    const m = exec(base(missing));
    expect(m.code).toBe(3);
    expect(m.err).toContain(missing);
    expect(m.out).toBe('');
    const t = exec(base(noTable.path));
    expect(t.code).toBe(3);
    expect(t.err).toContain('overseer_actions');
    expect(t.out).toBe('');
  });

  test('Test 6: script is packaged into the image', () => {
    const df = readFileSync(join(import.meta.dir, '..', 'Dockerfile'), 'utf8');
    const line = df
      .split('\n')
      .find(l => l.startsWith('COPY scripts/') && l.endsWith('./scripts/'));
    expect(line).toBeDefined();
    expect(line).toContain('scripts/run-completion-report.ts');
    expect(df.split('AS production')[1]).toContain('scripts/run-completion-report.ts');
  });
});

// --- Outcomes (last 24h), WO-HARNESS-DAILY-OUTCOME-REPORT-01 ---
const WS = '2026-10-31T14:30:00.000Z';
const WE = '2026-11-01T14:30:00.000Z';
const IN_W = '2026-11-01T10:00:00.000Z';
const OUT_W = '2026-10-30T10:00:00.000Z';

function tm(db: Database, action: string, outcome: string, createdAt: string): void {
  db.query(
    "insert into tm_journal (id, created_at, thread_ref, action_type, proposal_json, outcome) values (?,?,'t',?,'{}',?)"
  ).run(`t${++seq}`, createdAt, action, outcome);
}
function msg(
  db: Database,
  o: {
    task_type?: string;
    recipient: string;
    body?: string;
    status?: string;
    created_at: string;
    acknowledged_at?: string | null;
  }
): void {
  db.query(
    `insert into agent_dispatch_messages (id, correlation_id, idempotency_key, task_type, sender, recipient, body, status, created_at, acknowledged_at)
     values (?,?,?,?,'s',?,?,?,?,?)`
  ).run(
    `m${++seq}`,
    `c${seq}`,
    `k${seq}`,
    o.task_type ?? 'agent_message',
    o.recipient,
    o.body ?? '{}',
    o.status ?? 'queued',
    o.created_at,
    o.acknowledged_at ?? null
  );
}
function receipt(db: Database, recipient: string, disposition: string, createdAt: string): void {
  msg(db, {
    task_type: 'run_report',
    recipient,
    status: 'queued',
    created_at: createdAt,
    body: JSON.stringify({ kind: 'pr_review_submit_receipt', disposition }),
  });
}

// Hand queries O1-O7 from the WO spec, run independently of the script.
const MECH_ORDER = [
  'taskmaster_escalate_p0',
  'overseer_review',
  'overseer_repair',
  'overseer_merge',
  'cauldron_runs',
  'mailbox_operator',
  'mailbox_xo',
  'mailbox_t3-desktop',
];
function outcomeFixtures(path: string): { mechanisms: any[]; mailboxes: any[] } {
  const db = new Database(path, { readonly: true });
  const w = { $ws: WS, $we: WE };
  const io = (sql: string, params: Record<string, string> = w): any => db.query(sql).get(params);
  const m: any[] = [];
  m.push({
    name: 'taskmaster_escalate_p0',
    ...io(
      "select count(*) as input, coalesce(sum(outcome='sent'),0) as outcome from tm_journal where action_type='escalate_p0' and created_at >= $ws and created_at < $we"
    ),
  });
  m.push({
    name: 'overseer_review',
    ...io(
      "select (select count(*) from agent_dispatch_messages where task_type='run_review' and recipient='overseer-reviewer' and created_at >= $ws and created_at < $we) as input, (select count(*) from agent_dispatch_messages where created_at >= $ws and created_at < $we and json_valid(body) and json_extract(body,'$.kind')='pr_review_submit_receipt' and json_extract(body,'$.disposition') in ('approved','changes_requested')) as outcome"
    ),
  });
  m.push({
    name: 'overseer_repair',
    ...io(
      "select coalesce(sum(action='escalate_with_evidence'),0) as input, coalesce(sum(action like '%repair%' or action like '%refire%'),0) as outcome from overseer_actions where created_at >= $ws and created_at < $we"
    ),
  });
  m.push({
    name: 'overseer_merge',
    ...io(
      "select coalesce(sum(action='flag_merge_ready'),0) as input, coalesce(sum(action='merged'),0) as outcome from overseer_actions where created_at >= $ws and created_at < $we"
    ),
  });
  m.push({
    name: 'cauldron_runs',
    ...io(
      "select count(*) as input, coalesce(sum(status='completed'),0) as outcome from remote_agent_workflow_runs where workflow_name like 'bdc-feature-development%' and started_at >= datetime($a,'-1 days') and started_at < $a",
      { $a: AS_OF }
    ),
  });
  const boxes: any[] = [];
  for (const r of ['operator', 'xo', 't3-desktop']) {
    m.push({
      name: `mailbox_${r}`,
      ...io(
        'select (select count(*) from agent_dispatch_messages where recipient=$r and created_at >= $ws and created_at < $we) as input, (select count(*) from agent_dispatch_messages where recipient=$r and acknowledged_at >= $ws and acknowledged_at < $we) as outcome',
        { ...w, $r: r }
      ),
    });
    boxes.push({
      recipient: r,
      ...io(
        "select count(*) as depth, coalesce(sum($r <> 'operator' or created_at >= '2026-11-01T00:00:00.000Z'),0) as depth_live, min(case when $r <> 'operator' or created_at >= '2026-11-01T00:00:00.000Z' then created_at end) as oldest_live from agent_dispatch_messages where recipient=$r and status='queued' and acknowledged_at is null and created_at < $we",
        { $r: r, $we: WE }
      ),
    });
  }
  db.close();
  return { mechanisms: m, mailboxes: boxes };
}

describe('run-completion-report outcomes (last 24h)', () => {
  function seed7(db: Database): void {
    tm(db, 'escalate_p0', 'failed', IN_W);
    tm(db, 'escalate_p0', 'failed', IN_W);
    tm(db, 'escalate_p0', 'failed', IN_W);
    tm(db, 'escalate_p0', 'sent', IN_W);
    tm(db, 'escalate_p0', 'sent', '2026-11-01T01:00:00.000Z');
    tm(db, 'escalate_p0', 'expired', IN_W);
    tm(db, 'escalate_p0', 'sent', OUT_W);
    tm(db, 'nudge', 'sent', IN_W);
    for (let i = 0; i < 4; i++) {
      msg(db, {
        task_type: 'run_review',
        recipient: 'overseer-reviewer',
        status: 'done',
        created_at: IN_W,
      });
    }
    msg(db, { task_type: 'run_review', recipient: 'grok', status: 'done', created_at: IN_W });
    receipt(db, 'operator', 'approved', '2026-10-31T20:00:00.000Z');
    receipt(db, 'pr-review-log', 'changes_requested', IN_W);
    receipt(db, 'pr-review-log', 'checks_pending', IN_W);
    receipt(db, 'pr-review-log', 'submission_failed', IN_W);
    receipt(db, 'pr-review-log', 'approved', OUT_W);
    act(db, 'escalate_with_evidence', IN_W);
    act(db, 'escalate_with_evidence', IN_W);
    act(db, 'flag_merge_ready', IN_W);
    act(db, 'flag_merge_ready', IN_W);
    act(db, 'flag_merge_ready', IN_W);
    act(db, 'merged', IN_W);
    act(db, 'verdict_write', IN_W);
    run(db, LANES[0]!, 'completed', '2026-11-01 09:00:00');
    run(db, LANES[1]!, 'failed', '2026-11-01 09:00:00');
    run(db, LANES[1]!, 'completed', '2026-10-30 09:00:00');
  }

  test('Test 7: outcomes equal fixture SQL', () => {
    const { path, db } = newDb();
    seed7(db);
    db.close();
    const r = exec(base(path, ['--json']));
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out).outcomes;
    const f = outcomeFixtures(path);
    expect(o.mechanisms.map((m: any) => m.name)).toEqual(MECH_ORDER);
    expect(o.mechanisms).toEqual(f.mechanisms);
    const byName = Object.fromEntries(o.mechanisms.map((m: any) => [m.name, m]));
    expect(byName.taskmaster_escalate_p0).toEqual({
      name: 'taskmaster_escalate_p0',
      input: 6,
      outcome: 2,
    });
    expect(byName.overseer_review).toEqual({ name: 'overseer_review', input: 4, outcome: 2 });
    expect(byName.overseer_repair).toEqual({ name: 'overseer_repair', input: 2, outcome: 0 });
    expect(byName.overseer_merge).toEqual({ name: 'overseer_merge', input: 3, outcome: 1 });
    expect(byName.cauldron_runs).toEqual({ name: 'cauldron_runs', input: 2, outcome: 1 });
    expect(
      o.mailboxes.map((m: any) => ({
        recipient: m.recipient,
        depth: m.depth,
        depth_live: m.depth_live,
        oldest_live: m.oldest_live,
      }))
    ).toEqual(f.mailboxes);
  });

  test('Test 8: dead-mechanism flag', () => {
    const dead = newDb();
    seed7(dead.db);
    dead.db.close();
    const j = JSON.parse(exec(base(dead.path, ['--json'])).out);
    expect(j.outcomes.flags).toContain('dead_mechanism:overseer_repair');
    expect(j.outcomes.flags).not.toContain('dead_mechanism:taskmaster_escalate_p0');
    expect(j.outcomes.flags).not.toContain('dead_mechanism:overseer_review');
    expect(j.outcomes.flags).not.toContain('dead_mechanism:overseer_merge');
    // mailbox_operator: one receipt queued in the window, none acknowledged
    expect(j.outcomes.flags).toContain('dead_mechanism:mailbox_operator');
    expect(j.outcome_flag_line).toBe(
      `outcome_flags: ${j.outcomes.flags.length} (${j.outcomes.flags.join(', ')})`
    );
    const firstLine = exec(base(dead.path)).out.split('\n')[0]!;
    expect(firstLine).toBe(j.outcome_flag_line);
    expect(firstLine).toContain('dead_mechanism:overseer_repair');

    // every mechanism with input > 0 has outcome > 0: no flag at all
    const alive = newDb();
    tm(alive.db, 'escalate_p0', 'sent', IN_W);
    msg(alive.db, {
      task_type: 'run_review',
      recipient: 'overseer-reviewer',
      status: 'done',
      created_at: IN_W,
    });
    receipt(alive.db, 'pr-review-log', 'approved', IN_W);
    // the receipt itself is a pr-review-log row; acknowledge an operator row in the window
    msg(alive.db, {
      recipient: 'operator',
      status: 'done',
      created_at: IN_W,
      acknowledged_at: IN_W,
    });
    act(alive.db, 'escalate_with_evidence', IN_W);
    act(alive.db, 'repair_dispatched', IN_W);
    act(alive.db, 'flag_merge_ready', IN_W);
    act(alive.db, 'merged', IN_W);
    run(alive.db, LANES[0]!, 'completed', '2026-11-01 09:00:00');
    alive.db.close();
    const a = JSON.parse(exec(base(alive.path, ['--json'])).out);
    expect(a.outcomes.mechanisms.every((m: any) => m.input === 0 || m.outcome > 0)).toBe(true);
    expect(a.outcomes.flags).toEqual([]);
    expect(a.outcome_flag_line).toBe('outcome_flags: none');
    expect(exec(base(alive.path)).out.split('\n')[0]).toBe('outcome_flags: none');

    // input 0 and outcome 0: no flag
    const idle = newDb();
    act(idle.db, 'verdict_write', IN_W);
    idle.db.close();
    const i = JSON.parse(exec(base(idle.path, ['--json'])).out);
    const repair = i.outcomes.mechanisms.find((m: any) => m.name === 'overseer_repair');
    expect(repair).toEqual({ name: 'overseer_repair', input: 0, outcome: 0 });
    expect(i.outcomes.flags).toEqual([]);
  });

  test('Test 9: mailbox depth and stale flag', () => {
    const { path, db } = newDb();
    msg(db, { recipient: 'operator', created_at: '2026-10-20T08:00:00.000Z' });
    msg(db, { recipient: 'operator', created_at: '2026-11-01T00:30:00.000Z' });
    msg(db, {
      recipient: 'operator',
      created_at: '2026-10-20T09:00:00.000Z',
      acknowledged_at: '2026-10-21T09:00:00.000Z',
    });
    msg(db, { recipient: 'xo', created_at: '2026-10-30T10:00:00.000Z' });
    db.close();
    const j = JSON.parse(exec(base(path, ['--json'])).out);
    const box = Object.fromEntries(j.outcomes.mailboxes.map((m: any) => [m.recipient, m]));
    expect(box.operator).toEqual({
      recipient: 'operator',
      depth: 2,
      depth_live: 1,
      oldest_live: '2026-11-01T00:30:00.000Z',
      oldest_live_age_hours: 14,
    });
    expect(box.xo).toEqual({
      recipient: 'xo',
      depth: 1,
      depth_live: 1,
      oldest_live: '2026-10-30T10:00:00.000Z',
      oldest_live_age_hours: 52.5,
    });
    expect(box['t3-desktop']).toEqual({
      recipient: 't3-desktop',
      depth: 0,
      depth_live: 0,
      oldest_live: null,
      oldest_live_age_hours: null,
    });
    expect(j.outcomes.flags).toContain('stale_mailbox:xo');
    expect(j.outcomes.flags).not.toContain('stale_mailbox:operator');
    expect(j.outcomes.flags).not.toContain('stale_mailbox:t3-desktop');
    const f = outcomeFixtures(path);
    const mo = (list: any[]): any => list.find((m: any) => m.name === 'mailbox_operator');
    expect(mo(j.outcomes.mechanisms)).toEqual(mo(f.mechanisms));
    expect(mo(j.outcomes.mechanisms)).toEqual({ name: 'mailbox_operator', input: 1, outcome: 0 });
  });

  test('Test 10: 24h window independent of --days', () => {
    const { path, db } = newDb();
    tm(db, 'escalate_p0', 'failed', WS);
    tm(db, 'escalate_p0', 'failed', '2026-10-31T14:29:59.000Z');
    tm(db, 'escalate_p0', 'failed', WE);
    db.close();
    const j = JSON.parse(exec(base(path, ['--json'])).out);
    expect(j.window.days).toBe(7);
    expect(j.outcomes.window).toEqual({ start: WS, end: WE });
    expect(j.outcomes.mechanisms[0]).toEqual({
      name: 'taskmaster_escalate_p0',
      input: 1,
      outcome: 0,
    });
    expect(j.outcomes.flags).toEqual(['dead_mechanism:taskmaster_escalate_p0']);
    const t = exec(base(path)).out;
    expect(t).toContain(`outcomes (last 24h): ${WS} to ${WE}`);
    expect(t).toContain('  taskmaster_escalate_p0: input 1, outcome 0');
    expect(t).toContain('  mailbox t3-desktop: depth 0, live 0, oldest_live none, age_h none');
  });
});

// --- Zero-tier first-10 measurement, WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01 ---
const ZERO_LANE = 'bdc-feature-development-zero-open';
const ZERO_SINCE = '2026-11-02 12:00:00';

describe('run-completion-report zero-tier first-10', () => {
  test('Test 7: counts, REVERT verdict, cancelled excluded, pre-cutoff excluded', () => {
    const { path, db } = newDb();
    // Two runs BEFORE the cutoff -- must be excluded from the 10.
    run(db, ZERO_LANE, 'completed', '2026-11-02 11:00:00');
    run(db, ZERO_LANE, 'failed', '2026-11-02 11:30:00');
    // Three failed at or after the cutoff (earliest, so they land in the first 10).
    const f1 = run(db, ZERO_LANE, 'failed', '2026-11-02 12:01:00');
    run(db, ZERO_LANE, 'escalated', '2026-11-02 12:02:00');
    run(db, ZERO_LANE, 'failed', '2026-11-02 12:03:00');
    // Seven completed after the cutoff -> first 10 = 3 failed + 7 completed.
    for (let i = 4; i <= 10; i++) {
      const mm = i < 10 ? `0${i}` : `${i}`;
      run(db, ZERO_LANE, 'completed', `2026-11-02 12:${mm}:00`);
    }
    // An 11th non-cancelled terminal run -- excluded from the first 10.
    run(db, ZERO_LANE, 'completed', '2026-11-02 12:30:00');
    // One cancelled after the cutoff -- excluded from the 10, counted separately.
    run(db, ZERO_LANE, 'cancelled', '2026-11-02 12:40:00');
    // A node_failed event on the first failed run.
    nodeFailed(db, f1, 'repair-gate-fail');
    nodeFailed(db, f1, 'manifest-evidence-check');
    db.close();

    const r = exec(base(path, ['--zero-since', ZERO_SINCE, '--json']));
    expect(r.code).toBe(0);
    const z = JSON.parse(r.out).zero_tier;
    expect(z.since).toBe(ZERO_SINCE);
    expect(z.runs).toHaveLength(10);
    expect(z.total).toBe(10);
    expect(z.failed).toBe(3);
    expect(z.verdict).toBe('REVERT');
    expect(z.cancelled).toBe(1);
    // Pre-cutoff runs excluded: no run started before the cutoff appears.
    expect(z.runs.every((x: any) => ['completed', 'failed', 'escalated'].includes(x.status))).toBe(
      true
    );
    // The first failed run carries its node_failed step names.
    const firstFailed = z.runs.find((x: any) => x.run === f1.slice(0, 8));
    expect(firstFailed.status).toBe('failed');
    expect([...firstFailed.failed_steps].sort()).toEqual([
      'manifest-evidence-check',
      'repair-gate-fail',
    ]);

    // Text output carries the same verdict and counts.
    const t = exec(base(path, ['--zero-since', ZERO_SINCE])).out;
    expect(t).toContain('zero_tier_failed: 3/10');
    expect(t).toContain('zero_tier_verdict: REVERT');
    expect(t).toContain('zero_tier_cancelled: 1');
    expect(t).toContain('zero_tier_first10:');
  });

  test('Test 8: PENDING under 10, KEEP at 10 with fewer than 3 failed', () => {
    // Fixture A: 4 runs after the cutoff, 1 failed -> PENDING 4/10.
    const a = newDb();
    run(a.db, ZERO_LANE, 'failed', '2026-11-02 12:01:00');
    run(a.db, ZERO_LANE, 'completed', '2026-11-02 12:02:00');
    run(a.db, ZERO_LANE, 'completed', '2026-11-02 12:03:00');
    run(a.db, ZERO_LANE, 'completed', '2026-11-02 12:04:00');
    a.db.close();
    const ja = JSON.parse(exec(base(a.path, ['--zero-since', ZERO_SINCE, '--json'])).out).zero_tier;
    expect(ja.total).toBe(4);
    expect(ja.failed).toBe(1);
    expect(ja.verdict).toBe('PENDING');
    const ta = exec(base(a.path, ['--zero-since', ZERO_SINCE])).out;
    expect(ta).toContain('zero_tier_verdict: PENDING 4/10');

    // Fixture B: 10 runs after the cutoff, 2 failed -> KEEP.
    const b = newDb();
    run(b.db, ZERO_LANE, 'failed', '2026-11-02 12:01:00');
    run(b.db, ZERO_LANE, 'failed', '2026-11-02 12:02:00');
    for (let i = 3; i <= 10; i++) {
      run(b.db, ZERO_LANE, 'completed', `2026-11-02 12:${i < 10 ? '0' + i : i}:00`);
    }
    b.db.close();
    const jb = JSON.parse(exec(base(b.path, ['--zero-since', ZERO_SINCE, '--json'])).out).zero_tier;
    expect(jb.total).toBe(10);
    expect(jb.failed).toBe(2);
    expect(jb.verdict).toBe('KEEP');
    const tb = exec(base(b.path, ['--zero-since', ZERO_SINCE])).out;
    expect(tb).toContain('zero_tier_verdict: KEEP');
  });

  test('Test 8b: --zero-since absent -> no zero_tier section', () => {
    const { path, db } = newDb();
    run(db, ZERO_LANE, 'completed', '2026-11-02 12:01:00');
    db.close();
    const j = JSON.parse(exec(base(path, ['--json'])).out);
    expect(j.zero_tier).toBeUndefined();
    const t = exec(base(path)).out;
    expect(t).not.toContain('zero_tier_verdict');
  });
});

// --- Merged-or-owned WO completion, WO-HARNESS-COMPLETION-METRIC-MERGED-OR-OWNED-01 ---
type Argv = string[];
type Env = Record<string, string | undefined>;
type ExecResult = { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
const EMPTY = new Uint8Array();
const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const ok = (o: unknown): ExecResult => ({ exitCode: 0, stdout: enc(o), stderr: EMPTY });
const err = (code: number, message: string): ExecResult => ({
  exitCode: code,
  stdout: EMPTY,
  stderr: new TextEncoder().encode(message),
});
// Injected GitHub identity: a PAT so runGitHubServiceCommand mints no real token.
const PAT = {
  kind: 'pat' as const,
  service: 'taskmaster' as const,
  token: 'test-pat',
  poolId: 'user-pat' as const,
  distinct: false,
};
function runMsg(
  db: Database,
  lane: string,
  status: string,
  startedAt: string,
  userMessage: string
): string {
  const id = `r${++seq}`;
  db.query(
    'insert into remote_agent_workflow_runs (id, workflow_name, status, started_at, user_message) values (?,?,?,?,?)'
  ).run(id, lane, status, startedAt, userMessage);
  return id;
}
const wm = (wo: string, proj: string): string => `WO_ID=${wo} --project ${proj} do the thing`;

describe('run-completion-report merged-or-owned', () => {
  test('Test 1: merged-or-owned arithmetic', async () => {
    resetGitHubApiMeterForTests();
    const { path, db } = newDb();
    // 9 runs for 6 WOs: WO-A thrice (shopops), WO-B twice (bdc-harness), rest once.
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:00:00', wm('WO-A', 'shopops'));
    runMsg(db, LANES[0]!, 'failed', '2026-10-30 10:01:00', wm('WO-A', 'shopops'));
    runMsg(db, LANES[1]!, 'completed', '2026-10-30 10:02:00', wm('WO-A', 'shopops'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:03:00', wm('WO-B', 'bdc-harness'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:04:00', wm('WO-B', 'bdc-harness'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:05:00', wm('WO-C', 'shopops'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:06:00', wm('WO-D', 'shopops'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:07:00', wm('WO-E', 'bdc-harness'));
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:08:00', wm('WO-F', 'bdc-harness'));
    db.close();

    const ro = new Database(path, { readonly: true });
    const { units, unattributed } = attributeRuns(ro, AS_OF, '-7 days');
    ro.close();
    expect(unattributed).toBe(0);
    expect(units.size).toBe(6);
    expect([...units.get('WO-A')!]).toEqual(['shopops']); // thrice-fired WO is one unit

    const issues = [
      { title: 'WO-C', state: 'open', labels: [{ name: 'owner:codex' }], assignees: [] },
      { title: 'WO-D', state: 'open', labels: [], assignees: [{ login: 'alice' }] },
      { title: 'WO-E', state: 'open', labels: [{ name: 'class:CODE' }], assignees: [] },
      { title: 'WO-F', state: 'closed', labels: [], assignees: [] },
    ];
    const shopopsPulls = [
      { title: 'Implement WO-A', head: { ref: 'feature/wo-a' }, merged_at: '2026-10-20T00:00:00Z' },
    ];
    const harnessPulls = [
      {
        title: 'harness fix',
        body: 'resolves WO-B',
        head: { ref: 'fix' },
        merged_at: '2026-10-25T00:00:00Z',
      },
    ];

    const calls: Argv[] = [];
    const execute = (argv: Argv, _env: Env): ExecResult => {
      calls.push(argv);
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([issues]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: issues.length });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return ok([shopopsPulls]);
      if (argv.includes('q=repo:thinmansoftware/shopops is:pr is:merged'))
        return ok({ total_count: 1 });
      if (argv.includes('repos/thinmansoftware/bdc-harness/pulls?state=closed&per_page=100'))
        return ok([harnessPulls]);
      if (argv.includes('q=repo:thinmansoftware/bdc-harness is:pr is:merged'))
        return ok({ total_count: 1 });
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };

    const meterDb = new SqliteAdapter(':memory:');
    const r = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute,
      identity: PAT,
      db: meterDb,
    });
    await meterDb.close();
    resetGitHubApiMeterForTests();

    expect(r.available).toBe(true);
    if (!r.available) throw new Error('unavailable');
    expect(r.den).toBe(6);
    expect(r.merged).toBe(2);
    expect(r.owned).toBe(2);
    expect(r.neither).toBe(2);
    expect(r.neither_wos).toEqual(['WO-E', 'WO-F']);
    expect(r.num).toBe(4);
    // 1 issue list + 1 issue search + 2 * (pull list + pull search) = 6; no per-WO call.
    expect(calls.length).toBe(6);
  });

  test('Test 2: GitHub unavailable prints a reason and keeps exit 0', async () => {
    resetGitHubApiMeterForTests();
    // (a) execute exits nonzero with a rate-limit message -> unavailable with reason.
    const units = new Map([['WO-X', new Set(['shopops'])]]);
    const rl = (_argv: Argv, _env: Env): ExecResult =>
      err(1, 'API rate limit exceeded for installation');
    const meterDb = new SqliteAdapter(':memory:');
    const r = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute: rl,
      identity: PAT,
      db: meterDb,
    });
    await meterDb.close();
    resetGitHubApiMeterForTests();
    expect(r.available).toBe(false);
    if (r.available) throw new Error('expected unavailable');
    expect(r.reason).toContain('rate limit');

    // (b) --no-github forces the unavailable path; F1-F5 still print; exit 0.
    const { path, db } = newDb();
    for (let i = 0; i < 5; i++)
      runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:00:00', wm('WO-Y', 'shopops'));
    act(db, 'merged', '2026-10-30T10:00:00.000Z');
    db.close();
    const res = exec(base(path, ['--no-github']));
    expect(res.code).toBe(0);
    expect(res.out).toContain('wo_merged_or_owned: unavailable (no-github)');
    expect(res.out).toContain('overall (legacy run completion, retiring');
    expect(res.out).toContain('overseer_actions:');
    const jr = JSON.parse(exec(base(path, ['--no-github', '--json'])).out);
    expect(jr.wo_completion.available).toBe(false);
    expect(jr.wo_completion.reason).toBe('no-github');
  });

  test('Test 3: legacy overall line respects LEGACY_OVERALL_UNTIL window', () => {
    const { path, db } = newDb();
    // Runs inside both candidate windows so F2 numbers are identical either side.
    for (let i = 0; i < 5; i++) run(db, LANES[0]!, 'completed', '2026-11-15 10:00:00');
    db.close();
    const until = LEGACY_OVERALL_UNTIL; // 'YYYY-MM-DD'
    const afterTs = `${until} 00:00:00`;
    const beforeTs = new Date(Date.parse(`${until}T00:00:00Z`) - 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    const before = exec(['--days', '7', '--as-of', beforeTs, '--db', path]);
    expect(before.code).toBe(0);
    expect(before.out).toContain(`overall (legacy run completion, retiring ${until}):`);
    const jb = JSON.parse(exec(['--days', '7', '--as-of', beforeTs, '--db', path, '--json']).out);
    expect(jb.legacy_overall).toBeDefined();
    expect(jb.legacy_overall.total).toBe(5);
    expect(jb.legacy_overall.completed).toBe(5);

    const after = exec(['--days', '7', '--as-of', afterTs, '--db', path]);
    expect(after.code).toBe(0);
    expect(after.out).not.toContain('overall (legacy run completion');
    const ja = JSON.parse(exec(['--days', '7', '--as-of', afterTs, '--db', path, '--json']).out);
    expect(ja.legacy_overall).toBeUndefined();
  });

  test('Test 4: unattributed runs excluded from the denominator', () => {
    const { path, db } = newDb();
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:00:00', 'no prefix here');
    runMsg(db, LANES[0]!, 'failed', '2026-10-30 10:01:00', 'also not a wo message');
    runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:02:00', '');
    db.close();
    const r = exec(base(path, ['--json']));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.unattributed_runs).toBe(3);
    expect(j.wo_completion.available).toBe(true);
    expect(j.wo_completion.den).toBe(0);
    expect(exec(base(path)).out).toContain('unattributed_runs: 3');
  });

  test('Test 5: read-only kept with the new section', () => {
    const { path, db } = newDb();
    for (let i = 0; i < 5; i++)
      runMsg(db, LANES[0]!, 'completed', '2026-10-30 10:00:00', wm('WO-Z', 'shopops'));
    db.close();
    const sha = (): string => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = sha();
    // --no-github avoids any network while still exercising the new code path.
    for (let i = 0; i < 3; i++) expect(exec(base(path, ['--no-github'])).code).toBe(0);
    expect(sha()).toBe(before);
    expect(existsSync(path + '-journal')).toBe(false);
    const src = readFileSync(join(import.meta.dir, 'run-completion-report.ts'), 'utf8');
    for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER']) {
      expect(new RegExp(`\\b${kw}\\b`, 'i').test(src)).toBe(false);
    }
  });

  test('Test 6: a merge older than the window still counts', async () => {
    resetGitHubApiMeterForTests();
    const units = new Map([['WO-G', new Set(['shopops'])]]);
    const oldPull = [
      { title: 'old work for WO-G', head: { ref: 'wo-g' }, merged_at: '2026-08-01T00:00:00Z' },
    ];
    const execute = (argv: Argv, _env: Env): ExecResult => {
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: 0 });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return ok([oldPull]);
      if (argv.includes('q=repo:thinmansoftware/shopops is:pr is:merged'))
        return ok({ total_count: 1 });
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };
    const meterDb = new SqliteAdapter(':memory:');
    const r = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute,
      identity: PAT,
      db: meterDb,
    });
    await meterDb.close();
    resetGitHubApiMeterForTests();
    expect(r.available).toBe(true);
    if (!r.available) throw new Error('unavailable');
    expect(r.merged).toBe(1);
    expect(r.owned).toBe(0);
    expect(r.neither).toBe(0);
  });

  test('Test 7: truncated or failed retrieval reports unavailable incomplete', async () => {
    resetGitHubApiMeterForTests();
    const units = new Map([['WO-H', new Set(['shopops'])]]);
    // (a) retrieved merged 250 but search total_count 251 -> incomplete.
    const pulls250 = Array.from({ length: 250 }, (_, i) => ({
      title: `pr ${i}`,
      merged_at: '2026-10-20T00:00:00Z',
    }));
    const execA = (argv: Argv, _env: Env): ExecResult => {
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: 0 });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return ok([pulls250]);
      if (argv.includes('q=repo:thinmansoftware/shopops is:pr is:merged'))
        return ok({ total_count: 251 });
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };
    const db1 = new SqliteAdapter(':memory:');
    const ra = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute: execA,
      identity: PAT,
      db: db1,
    });
    await db1.close();
    resetGitHubApiMeterForTests();
    expect(ra.available).toBe(false);
    if (ra.available) throw new Error('expected unavailable');
    expect(ra.reason).toContain('incomplete:pulls:shopops');

    // (b) a page of the pulls retrieval fails (nonzero, non-auth) -> incomplete.
    const execB = (argv: Argv, _env: Env): ExecResult => {
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: 0 });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return err(1, 'gh: pagination failed on page 3 (HTTP 502)');
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };
    const db2 = new SqliteAdapter(':memory:');
    const rb = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute: execB,
      identity: PAT,
      db: db2,
    });
    await db2.close();
    resetGitHubApiMeterForTests();
    expect(rb.available).toBe(false);
    if (rb.available) throw new Error('expected unavailable');
    expect(rb.reason).toContain('incomplete:pulls:shopops');
  });

  test('Test 8: request arguments are exact (one project)', async () => {
    resetGitHubApiMeterForTests();
    const units = new Map([['WO-I', new Set(['shopops'])]]);
    const calls: Argv[] = [];
    const execute = (argv: Argv, _env: Env): ExecResult => {
      calls.push(argv);
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: 0 });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/shopops is:pr is:merged'))
        return ok({ total_count: 0 });
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };
    const meterDb = new SqliteAdapter(':memory:');
    const r = await computeWoCompletion(units, AS_OF, {
      noGithub: false,
      execute,
      identity: PAT,
      db: meterDb,
    });
    await meterDb.close();
    resetGitHubApiMeterForTests();
    expect(r.available).toBe(true);

    const flat = calls.flat();
    expect(flat).toContain('-f');
    expect(flat).toContain('q=repo:thinmansoftware/bdc-xo label:wo is:issue');
    expect(flat).toContain('q=repo:thinmansoftware/shopops is:pr is:merged');
    expect(flat.some(e => e.includes('+'))).toBe(false);
    const issueCall = calls.find(c => c.some(e => e.includes('/issues?')))!;
    expect(issueCall).toContain('--paginate');
    expect(issueCall.some(e => e.includes('per_page=100'))).toBe(true);
    const pullCall = calls.find(c => c.some(e => e.includes('/pulls?')))!;
    expect(pullCall).toContain('--paginate');
    expect(pullCall.some(e => e.includes('per_page=100'))).toBe(true);
  });

  test('Test 9: the default github path never opens the shared/production db', async () => {
    // Read-only contract: with no db injected (exactly how main() calls it), the
    // GitHub join must route its metering flush to a throwaway in-memory sink, not
    // to getDatabase() -- which in the container is the production archon.db this
    // report promises never to write. If computeWoCompletion let runGitHubService-
    // Command default its db to getDatabase(), the spy below would fire (and, in
    // production, github_api_usage/github_api_pool_state rows would be written).
    resetGitHubApiMeterForTests();
    const spy = spyOn(dbConnection, 'getDatabase').mockImplementation(() => {
      throw new Error('getDatabase must not be called during the read-only report');
    });
    const units = new Map([['WO-J', new Set(['shopops'])]]);
    const execute = (argv: Argv, _env: Env): ExecResult => {
      if (argv.includes('repos/thinmansoftware/bdc-xo/issues?labels=wo&state=all&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/bdc-xo label:wo is:issue'))
        return ok({ total_count: 0 });
      if (argv.includes('repos/thinmansoftware/shopops/pulls?state=closed&per_page=100'))
        return ok([[]]);
      if (argv.includes('q=repo:thinmansoftware/shopops is:pr is:merged'))
        return ok({ total_count: 0 });
      throw new Error(`unexpected gh call: ${argv.join(' ')}`);
    };
    try {
      // No `db`: computeWoCompletion must build its own in-memory meter sink.
      const r = await computeWoCompletion(units, AS_OF, {
        noGithub: false,
        execute,
        identity: PAT,
      });
      expect(r.available).toBe(true);
      if (!r.available) throw new Error('unavailable');
      expect(r.den).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      resetGitHubApiMeterForTests();
    }
  });
});
