import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, 'run-completion-report.ts');
const AS_OF = '2026-11-01 14:30:00';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SCHEMA = `
create table remote_agent_workflow_runs (id text primary key, workflow_name text not null, status text not null default 'pending', started_at text default (datetime('now')));
create table remote_agent_workflow_events (id text primary key, workflow_run_id text not null, event_type text not null, step_index integer, step_name text, data text, created_at text);
create table remote_agent_run_outcomes (run_id text primary key, execution_state text);
create table overseer_actions (id text primary key, run_id text, wo_id text, class text, action text, result text not null, created_at text not null);
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
    expect(t.out).toContain('overall: 26/37 completed, rate 70.3%');
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
