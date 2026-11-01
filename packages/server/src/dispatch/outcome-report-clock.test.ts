import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createOutcomeReportClockState,
  createRealOutcomeReportRunner,
  outcomeReportMarker,
  tickOutcomeReportClock,
  type OutcomeReportClockDeps,
  type OutcomeReportJson,
} from './outcome-report-clock';

const REPORT: OutcomeReportJson = {
  outcome_flag_line: 'outcome_flags: 1 (dead_mechanism:overseer_repair)',
  outcomes: {
    window: { start: '2026-11-01T11:05:00.000Z', end: '2026-11-02T11:05:00.000Z' },
    mechanisms: [
      { name: 'taskmaster_escalate_p0', input: 3, outcome: 1 },
      { name: 'overseer_repair', input: 2, outcome: 0 },
    ],
    mailboxes: [
      {
        recipient: 'xo',
        depth: 4,
        depth_live: 4,
        oldest_live: '2026-11-02T01:00:00.000Z',
        oldest_live_age_hours: 10.1,
      },
      {
        recipient: 't3-desktop',
        depth: 0,
        depth_live: 0,
        oldest_live: null,
        oldest_live_age_hours: null,
      },
    ],
    flags: ['dead_mechanism:overseer_repair'],
  },
};

interface Fake {
  deps: OutcomeReportClockDeps;
  posts: { repo: string; issue: number; body: string }[];
  lists: { repo: string; issue: number; since: string }[];
  reports: string[];
  issueComments: string[];
  clock: { now: Date };
}

function fake(env: Record<string, string | undefined>, now: string): Fake {
  const f: Fake = {
    posts: [],
    lists: [],
    reports: [],
    issueComments: [],
    clock: { now: new Date(now) },
    deps: undefined as unknown as OutcomeReportClockDeps,
  };
  f.deps = {
    env,
    now: () => f.clock.now,
    runReport: async asOf => {
      f.reports.push(asOf);
      return REPORT;
    },
    listComments: async (repo, issue, since) => {
      f.lists.push({ repo, issue, since });
      return [...f.issueComments];
    },
    postComment: async (repo, issue, body) => {
      f.posts.push({ repo, issue, body });
      f.issueComments.push(body);
    },
  };
  return f;
}

const ENV = { HARNESS_OUTCOME_REPORT_ISSUE: '4200' };

describe('outcome-report-clock', () => {
  test('posts once: one comment with the flag line first, then the 24h table', async () => {
    const f = fake(ENV, '2026-11-02T11:05:00.000Z');
    const state = createOutcomeReportClockState();
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('posted');
    expect(f.posts).toHaveLength(1);
    const p = f.posts[0]!;
    expect(p.repo).toBe('thinmansoftware/bdc-xo');
    expect(p.issue).toBe(4200);
    const lines = p.body.split('\n');
    expect(lines[0]).toBe('outcome_flags: 1 (dead_mechanism:overseer_repair)');
    expect(p.body).toContain('| Mechanism | Input | Outcome |');
    expect(p.body).toContain('| taskmaster_escalate_p0 | 3 | 1 |');
    expect(p.body).toContain('| overseer_repair | 2 | 0 |');
    expect(p.body).toContain('| xo | 4 | 4 | 2026-11-02T01:00:00.000Z | 10.1 |');
    expect(p.body).toContain('| t3-desktop | 0 | 0 | none | none |');
    expect(lines[lines.length - 1]).toBe(outcomeReportMarker('2026-11-02'));
    expect(f.reports).toEqual(['2026-11-02 11:05:00']);
    expect(f.lists).toEqual([
      { repo: 'thinmansoftware/bdc-xo', issue: 4200, since: '2026-11-02T00:00:00Z' },
    ]);

    // later ticks the same day: no second post and no second report run
    f.clock.now = new Date('2026-11-02T11:20:00.000Z');
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('already_posted');
    f.clock.now = new Date('2026-11-02T23:59:00.000Z');
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('already_posted');
    expect(f.posts).toHaveLength(1);
    expect(f.reports).toHaveLength(1);

    // next day posts again
    f.clock.now = new Date('2026-11-03T11:00:00.000Z');
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('posted');
    expect(f.posts).toHaveLength(2);
    expect(f.posts[1]!.body).toContain(outcomeReportMarker('2026-11-03'));
  });

  test('skips when HARNESS_OUTCOME_REPORT_ISSUE is unset or invalid, never fails', async () => {
    for (const env of [
      {},
      { HARNESS_OUTCOME_REPORT_ISSUE: '' },
      { HARNESS_OUTCOME_REPORT_ISSUE: 'abc' },
    ]) {
      const f = fake(env, '2026-11-02T11:05:00.000Z');
      expect(await tickOutcomeReportClock(f.deps, createOutcomeReportClockState())).toBe(
        'skipped_no_issue'
      );
      expect(f.posts).toHaveLength(0);
      expect(f.lists).toHaveLength(0);
      expect(f.reports).toHaveLength(0);
    }
  });

  test('not due before 11:00 UTC', async () => {
    const f = fake(ENV, '2026-11-02T10:59:59.000Z');
    expect(await tickOutcomeReportClock(f.deps, createOutcomeReportClockState())).toBe('not_due');
    expect(f.posts).toHaveLength(0);
    expect(f.lists).toHaveLength(0);
  });

  test('no double post after a restart: the date marker on the issue wins', async () => {
    const f = fake(ENV, '2026-11-02T11:05:00.000Z');
    expect(await tickOutcomeReportClock(f.deps, createOutcomeReportClockState())).toBe('posted');
    // restart: fresh in-memory state, same issue comments
    const restarted = createOutcomeReportClockState();
    f.clock.now = new Date('2026-11-02T11:30:00.000Z');
    expect(await tickOutcomeReportClock(f.deps, restarted)).toBe('already_posted');
    expect(restarted.lastPostedDate).toBe('2026-11-02');
    expect(f.posts).toHaveLength(1);
    expect(f.reports).toHaveLength(1);
    // yesterday's marker does not block today
    const g = fake(ENV, '2026-11-03T11:05:00.000Z');
    g.issueComments.push(`old\n${outcomeReportMarker('2026-11-02')}`);
    expect(await tickOutcomeReportClock(g.deps, createOutcomeReportClockState())).toBe('posted');
    expect(g.posts).toHaveLength(1);
  });

  test('a GitHub or report failure is logged and never thrown, and retries next tick', async () => {
    const f = fake(ENV, '2026-11-02T11:05:00.000Z');
    let fail = true;
    const post = f.deps.postComment;
    f.deps.postComment = async (repo, issue, body) => {
      if (fail) throw new Error('outcome_report_github_502');
      await post(repo, issue, body);
    };
    const state = createOutcomeReportClockState();
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('failed');
    expect(state.lastPostedDate).toBeNull();
    expect(state.inFlight).toBe(false);
    fail = false;
    expect(await tickOutcomeReportClock(f.deps, state)).toBe('posted');
    expect(f.posts).toHaveLength(1);
  });

  test('repo override comes from HARNESS_OUTCOME_REPORT_REPO', async () => {
    const f = fake(
      { ...ENV, HARNESS_OUTCOME_REPORT_REPO: 'thinmansoftware/bdc-harness' },
      '2026-11-02T12:00:00.000Z'
    );
    expect(await tickOutcomeReportClock(f.deps, createOutcomeReportClockState())).toBe('posted');
    expect(f.posts[0]!.repo).toBe('thinmansoftware/bdc-harness');
  });
});

describe('outcome-report-clock real runner', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('runs the real report script against a seeded store and parses its outcomes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-'));
    dirs.push(dir);
    const path = join(dir, 'archon.db');
    const db = new Database(path);
    db.exec(`
create table remote_agent_workflow_runs (id text primary key, workflow_name text not null, status text not null default 'pending', started_at text);
create table remote_agent_workflow_events (id text primary key, workflow_run_id text not null, event_type text not null, step_index integer, step_name text, data text, created_at text);
create table remote_agent_run_outcomes (run_id text primary key, execution_state text);
create table overseer_actions (id text primary key, run_id text, wo_id text, class text, action text, result text not null, created_at text not null);
create table tm_journal (id text primary key, created_at text not null, thread_ref text not null, action_type text not null, proposal_json text not null, outcome text not null);
create table agent_dispatch_messages (id text primary key, correlation_id text not null, idempotency_key text not null, task_type text not null, sender text not null, recipient text not null, body text not null, status text not null default 'queued', created_at text not null, acknowledged_at text);
`);
    db.exec(`
insert into tm_journal values ('t1','2026-11-02T05:00:00.000Z','x','escalate_p0','{}','failed');
insert into tm_journal values ('t2','2026-11-02T06:00:00.000Z','x','escalate_p0','{}','sent');
`);
    db.exec(
      "insert into overseer_actions values ('a1','r','w','c','escalate_with_evidence','ok','2026-11-02T07:00:00.000Z')"
    );
    db.close();
    const script = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'run-completion-report.ts'
    );
    const run = createRealOutcomeReportRunner({}, script, path);
    const report = await run('2026-11-02 11:00:00');
    expect(report.outcomes.window).toEqual({
      start: '2026-11-01T11:00:00.000Z',
      end: '2026-11-02T11:00:00.000Z',
    });
    const byName = Object.fromEntries(report.outcomes.mechanisms.map(m => [m.name, m]));
    expect(byName.taskmaster_escalate_p0).toEqual({
      name: 'taskmaster_escalate_p0',
      input: 2,
      outcome: 1,
    });
    expect(byName.overseer_repair).toEqual({ name: 'overseer_repair', input: 1, outcome: 0 });
    expect(report.outcomes.flags).toEqual(['dead_mechanism:overseer_repair']);
    expect(report.outcome_flag_line).toBe('outcome_flags: 1 (dead_mechanism:overseer_repair)');
  });

  test('refuses a postgres deployment instead of reading the wrong store', async () => {
    const run = createRealOutcomeReportRunner({ DATABASE_URL: 'postgres://x' }, 'unused', 'unused');
    await expect(run('2026-11-02 11:00:00')).rejects.toThrow('outcome_report_sqlite_only');
  });
});
