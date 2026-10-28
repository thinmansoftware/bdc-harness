import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCanaryCli } from './cli';
import {
  formatDutyOfficerDigest,
  openOverseerLoopDatabase,
  runC1RunBranchIdentity,
  runC2OverseerMergeHealth,
  runC3EndToEndMerge,
  runC4SpecBaseBranchGate,
  runC5ReviewerHasSpec,
  runC6FixLoopHealth,
  runC7RepeatedRefusalTripwire,
  runOverseerLoopCanaries,
  OVERSEER_LOOP_CANARY_BASE,
  OVERSEER_LOOP_CANARY_REPO,
  type AlertTransport,
  type C3Budgets,
  type CanaryPullRequest,
  type DispatchPayload,
  type EscalatePayload,
  type OverseerLoopDeps,
  type OverseerLoopForge,
  type ReviewBody,
  type ScriptRunner,
} from './overseer-loop-canary';

const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const FIXTURE_DIR = join(import.meta.dir, '../fixtures/overseer-loop');
const REPO_ROOT = join(import.meta.dir, '../../..');
const IN_WINDOW = '2026-10-27 12:00:00';
const databases: Database[] = [];

const RUNS_SQL = `CREATE TABLE remote_agent_workflow_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  metadata TEXT
)`;
const ACTIONS_SQL = `CREATE TABLE overseer_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  class TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
const VERDICTS_SQL = `CREATE TABLE overseer_verdicts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  wo_id TEXT NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  verdict TEXT,
  reason TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL
)`;
const DISPATCH_SQL = `CREATE TABLE agent_dispatch_messages (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;
const STORE_SQL = `${RUNS_SQL}; ${ACTIONS_SQL}; ${VERDICTS_SQL}; ${DISPATCH_SQL};`;

function memoryDb(schema: string): Database {
  const db = new Database(':memory:');
  db.exec(schema);
  databases.push(db);
  return db;
}

async function loadFixture(schema: string, file: string): Promise<Database> {
  const db = memoryDb(schema);
  db.exec(await readFile(join(FIXTURE_DIR, file), 'utf8'));
  return db;
}

function shortClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let clock = NOW;
  return {
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      clock += ms;
    },
  };
}

const SHORT_BUDGETS: C3Budgets = { prOpenMs: 1000, approvalMs: 1000, mergeMs: 1000 };

class FakeForge implements OverseerLoopForge {
  readonly mutations: string[] = [];
  readonly lines: string[] = [];
  readonly closed: number[] = [];
  deleted = 0;
  private nextNumber = 1;
  private readonly prs = new Map<
    number,
    { number: number; headSha: string; state: 'open' | 'closed'; line: string }
  >();

  constructor(
    private readonly repo: string,
    private readonly base: string,
    private readonly approve: boolean,
    private readonly merge: boolean
  ) {}

  seedOpen(number = 7): void {
    this.prs.set(number, { number, headSha: 'seed', state: 'open', line: 'old\n' });
  }

  resolveTarget(): Promise<{ repo: string; base: string }> {
    return Promise.resolve({ repo: this.repo, base: this.base });
  }

  async findOpenPullRequest(): Promise<CanaryPullRequest | null> {
    this.mutations.push('findOpen');
    const open = [...this.prs.values()].find(pr => pr.state === 'open');
    return open ? { number: open.number, headSha: open.headSha } : null;
  }

  async publishCanaryFile(line: string): Promise<{ headSha: string; prNumber: number }> {
    this.mutations.push('publish');
    this.lines.push(line);
    const open = [...this.prs.values()].find(pr => pr.state === 'open');
    if (open) {
      open.line = line;
      open.headSha = `sha-${open.number}-next`;
      return { headSha: open.headSha, prNumber: open.number };
    }
    const number = this.nextNumber;
    this.nextNumber += 1;
    const headSha = `sha-${number}`;
    this.prs.set(number, { number, headSha, state: 'open', line });
    return { headSha, prNumber: number };
  }

  async findApproval(
    _prNumber: number,
    headSha: string
  ): Promise<{ approved: boolean; at: string | null }> {
    this.mutations.push(`approval:${headSha}`);
    return this.approve
      ? { approved: true, at: '2026-10-28T00:00:00.000Z' }
      : { approved: false, at: null };
  }

  async findMerge(_prNumber: number): Promise<{ merged: boolean; at: string | null }> {
    this.mutations.push('merge');
    return this.merge
      ? { merged: true, at: '2026-10-28T00:00:01.000Z' }
      : { merged: false, at: null };
  }

  async closePullRequest(prNumber: number): Promise<void> {
    this.mutations.push('close');
    this.closed.push(prNumber);
    const pr = this.prs.get(prNumber);
    if (pr) pr.state = 'closed';
  }

  async deleteBranch(): Promise<void> {
    this.mutations.push('delete');
    this.deleted += 1;
  }
}

function c3Deps(forge: OverseerLoopForge, clock = shortClock()): OverseerLoopDeps {
  return {
    forge,
    now: clock.now,
    sleep: clock.sleep,
    budgets: SHORT_BUDGETS,
    pollIntervalMs: 1000,
  };
}

const passingScripts: ScriptRunner = async request => {
  const base = request.fixturePath.split('/').pop();
  if (base === 'c4-correct-base.md') return { exitCode: 0, stdout: '', stderr: '' };
  const stderr = await readFile(request.fixturePath.replace(/\.md$/, '.expected.txt'), 'utf8');
  return { exitCode: 1, stdout: '', stderr };
};

function validReviews(): ReviewBody[] {
  return [{ id: 'review-ok', body: 'Reviewed against WO-HARNESS-EXAMPLE-01 @ abcdef0123' }];
}

function candidateBody(woId: string, headSha: string): string {
  return JSON.stringify({
    kind: 'overseer_remediation_candidate',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    prNumber: 10,
    headSha,
    attempt: 1,
    maxAttempts: 2,
    findingClasses: ['test_failure'],
    verdictBody: 'tests failed',
    woId,
    owningLane: null,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('overseer loop canaries', () => {
  test('C1 counts missing branch identity and switches WARN to FAIL when landed', async () => {
    const db = await loadFixture(RUNS_SQL, 'c1-missing-branch.sql');
    db.exec(
      `INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES
        ('run-bad-time', 'not-a-timestamp', '{"base_branch":"dev","head_branch":"feature/bad"}')`
    );
    const warned = await runC1RunBranchIdentity({ db, now: () => NOW, env: {} });
    const ignored = await runC1RunBranchIdentity({
      db,
      now: () => NOW,
      env: { OVERSEER_CANARY_BRANCH_IDENTITY_LANDED: 'true' },
    });
    const failed = await runC1RunBranchIdentity({
      db,
      now: () => NOW,
      env: { OVERSEER_CANARY_BRANCH_IDENTITY_LANDED: '1' },
    });
    const explicit = await runC1RunBranchIdentity({
      db,
      now: () => NOW,
      branchIdentityLanded: true,
    });

    expect(warned.counts.missing).toBe(1);
    expect(warned.verdict).toBe('WARN');
    expect(ignored.verdict).toBe('WARN');
    expect(failed.verdict).toBe('FAIL');
    expect(explicit.verdict).toBe('FAIL');
    expect(warned.evidence).toContain('missing_run=run-missing-head');
    expect(warned.evidence.some(line => line.includes('run-old-missing-both'))).toBe(false);
    expect(warned.evidence).toContain('unparseable_timestamp=not-a-timestamp');
  });

  test('C2 fails repeated denials and unmerged ready flags, and passes two repeats', async () => {
    const denied = await runC2OverseerMergeHealth({
      db: await loadFixture(ACTIONS_SQL, 'c2-repeated-denial.sql'),
      now: () => NOW,
    });
    const ready = await runC2OverseerMergeHealth({
      db: await loadFixture(ACTIONS_SQL, 'c2-unmerged-ready.sql'),
      now: () => NOW,
    });
    const clean = await runC2OverseerMergeHealth({
      db: await loadFixture(ACTIONS_SQL, 'c2-clean.sql'),
      now: () => NOW,
    });
    const longResult = 'A'.repeat(600);
    const longDb = memoryDb(ACTIONS_SQL);
    for (let index = 1; index <= 3; index += 1) {
      longDb.run(
        `INSERT INTO overseer_actions (id, run_id, wo_id, class, action, result, created_at)
         VALUES (?, 'run-long', 'WO-C2', 'merge', 'merge_denied', ?, ?)`,
        [`long-${index}`, longResult, IN_WINDOW]
      );
    }
    const truncated = await runC2OverseerMergeHealth({ db: longDb, now: () => NOW });

    expect(denied.verdict).toBe('FAIL');
    expect(denied.evidence.join('\n')).toContain('base_branch_missing_in_run_metadata');
    expect(denied.evidence.join('\n')).toContain('count=3');
    expect(ready.verdict).toBe('FAIL');
    expect(ready.evidence).toContain('flag_merge_ready=1 run_derived_merged=0');
    expect(clean.verdict).toBe('PASS');
    expect(clean.counts.merge_denied_max).toBe(2);
    expect(truncated.verdict).toBe('FAIL');
    expect(truncated.evidence[0]?.length).toBe(500);
    expect(truncated.evidence[0]?.startsWith('repeated_result=AAA')).toBe(true);
  });

  test('C3 names a stalled approval, cleans up, and refuses a foreign target', async () => {
    const stall = new FakeForge(OVERSEER_LOOP_CANARY_REPO, OVERSEER_LOOP_CANARY_BASE, false, false);
    const first = await runC3EndToEndMerge(c3Deps(stall));
    const second = await runC3EndToEndMerge(c3Deps(stall));
    const mergeStall = new FakeForge(
      OVERSEER_LOOP_CANARY_REPO,
      OVERSEER_LOOP_CANARY_BASE,
      true,
      false
    );
    const mergeResult = await runC3EndToEndMerge(c3Deps(mergeStall));
    const success = new FakeForge(OVERSEER_LOOP_CANARY_REPO, OVERSEER_LOOP_CANARY_BASE, true, true);
    success.seedOpen();
    const successResult = await runC3EndToEndMerge(c3Deps(success));
    const wrongRepo = new FakeForge('other/repo', OVERSEER_LOOP_CANARY_BASE, true, true);
    const wrongBase = new FakeForge(OVERSEER_LOOP_CANARY_REPO, 'main', true, true);
    const refusedRepo = await runC3EndToEndMerge(c3Deps(wrongRepo));
    const refusedBase = await runC3EndToEndMerge(c3Deps(wrongBase));
    const unavailable = await runC3EndToEndMerge({ ghAvailable: () => false, now: () => NOW });

    expect(first.verdict).toBe('FAIL');
    expect(first.evidence).toContain('failed_step=overseer_approval');
    expect(first.evidence.some(line => line.startsWith('pr_open='))).toBe(true);
    expect(first.evidence.some(line => line.startsWith('overseer_approval='))).toBe(false);
    expect(first.counts.pr_number).toBe(1);
    expect(stall.lines[0]).toBe('2026-10-28T00:00:00.000Z\n');
    expect(stall.closed).toEqual([1, 2]);
    expect(stall.deleted).toBe(2);
    expect(second.counts.pr_number).toBe(2);
    expect(second.evidence).toContain('failed_step=overseer_approval');
    expect(mergeResult.evidence).toContain('failed_step=merge_manager');
    expect(mergeResult.evidence.some(line => line.startsWith('pr_open='))).toBe(true);
    expect(mergeResult.evidence.some(line => line.startsWith('overseer_approval='))).toBe(true);
    expect(mergeStall.closed).toEqual([1]);
    expect(successResult.verdict).toBe('PASS');
    expect(successResult.counts.pr_number).toBe(7);
    expect(success.mutations).not.toContain('close');
    expect(success.mutations).not.toContain('delete');
    expect(success.lines[0]?.trim()).toBe('2026-10-28T00:00:00.000Z');
    expect(refusedRepo.verdict).toBe('FAIL');
    expect(refusedRepo.evidence).toContain('target_refused');
    expect(wrongRepo.mutations).toEqual([]);
    expect(refusedBase.verdict).toBe('FAIL');
    expect(refusedBase.evidence).toContain('target_refused');
    expect(wrongBase.mutations).toEqual([]);
    expect(unavailable.verdict).toBe('FAIL');
    expect(unavailable.evidence).toContain('forge_unavailable');
  });

  test('C4 accepts the three base-branch fixtures only when refusal text matches', async () => {
    const calls: { script: string; argv: readonly string[] }[] = [];
    const recording: ScriptRunner = async request => {
      calls.push({ script: request.script, argv: request.argv });
      return passingScripts(request);
    };
    const passed = await runC4SpecBaseBranchGate({ scriptRunner: recording });
    const wrongExit = await runC4SpecBaseBranchGate({
      scriptRunner: async request =>
        request.fixturePath.endsWith('c4-wrong-base.md')
          ? { exitCode: 0, stdout: '', stderr: '' }
          : passingScripts(request),
    });
    const wrongText = await runC4SpecBaseBranchGate({
      scriptRunner: async request =>
        request.fixturePath.endsWith('c4-missing-base.md')
          ? { exitCode: 1, stdout: '', stderr: 'nope' }
          : passingScripts(request),
    });
    const unverified = await runC4SpecBaseBranchGate({});

    expect(passed.verdict).toBe('PASS');
    expect(passed.evidence).toContain(
      'missing_base=refused wrong_base=refused correct_base=accepted'
    );
    expect(calls).toHaveLength(6);
    expect(calls.every(call => call.argv.length === 1 && call.argv[0]?.endsWith('.md'))).toBe(true);
    expect(new Set(calls.map(call => call.script))).toEqual(
      new Set(['validate-wo-spec.sh', 'fire.ps1'])
    );
    expect(wrongExit.verdict).toBe('FAIL');
    expect(wrongExit.evidence.some(line => line.includes('c4-wrong-base.md'))).toBe(true);
    expect(wrongText.verdict).toBe('FAIL');
    expect(wrongText.evidence.some(line => line.includes('c4-missing-base.md'))).toBe(true);
    expect(unverified.verdict).toBe('FAIL');
    expect(unverified.evidence).toContain('c4_expected_text_unverified');
  });

  test('C5 warns then fails when a review body omits both spec markers', async () => {
    const bodies: ReviewBody[] = Array.from({ length: 20 }, (_unused, index) => {
      if (index === 7) return { id: 'review-7', body: 'Reviewed against WO-BAD @ zz' };
      if (index % 2 === 0) {
        return {
          id: `review-${index}`,
          body: `Reviewed against WO-HARNESS-EXAMPLE-${index} @ abcdef0123456789`,
        };
      }
      return { id: `review-${index}`, body: 'No WO spec found (absent on disk)' };
    });
    const loadReviewBodies = async (): Promise<readonly ReviewBody[]> => bodies;
    const warned = await runC5ReviewerHasSpec({ loadReviewBodies, env: {} });
    const notExact = await runC5ReviewerHasSpec({
      loadReviewBodies,
      env: { OVERSEER_CANARY_REVIEW_SPEC_LANDED: 'true' },
    });
    const failed = await runC5ReviewerHasSpec({
      loadReviewBodies,
      env: { OVERSEER_CANARY_REVIEW_SPEC_LANDED: '1' },
    });
    const empty = await runC5ReviewerHasSpec({
      loadReviewBodies: async () => [],
      env: { OVERSEER_CANARY_REVIEW_SPEC_LANDED: '1' },
    });

    expect(warned.verdict).toBe('WARN');
    expect(notExact.verdict).toBe('WARN');
    expect(failed.verdict).toBe('FAIL');
    expect(failed.evidence).toContain('review_id=review-7');
    expect(failed.counts.missing).toBe(1);
    expect(failed.counts.review_count).toBe(20);
    expect(empty.verdict).toBe('WARN');
    expect(empty.evidence).toContain('review_count=0');
  });

  test('C6 reports an automatic-to-hand ratio of 2:2 and stays WARN', async () => {
    const db = memoryDb(STORE_SQL);
    const insertVerdict = (
      id: string,
      woId: string,
      headSha: string,
      verdict: string,
      createdAt: string
    ): void => {
      db.run(
        `INSERT INTO overseer_verdicts
          (id, run_id, wo_id, head_sha, status, verdict, created_at)
         VALUES (?, ?, ?, ?, 'verdict', ?, ?)`,
        [id, `run-${id}`, woId, headSha, verdict, createdAt]
      );
    };
    insertVerdict('a', 'wo-a', 'sha-a', 'CHANGES_REQUESTED', IN_WINDOW);
    insertVerdict('b', 'wo-b', 'sha-b', 'CHANGES_REQUESTED', IN_WINDOW);
    insertVerdict('c', 'wo-c', 'sha-c', 'CHANGES_REQUESTED', IN_WINDOW);
    insertVerdict('d', 'wo-d', 'sha-d', 'CHANGES_REQUESTED', IN_WINDOW);
    insertVerdict('prose', 'wo-prose', 'sha-prose', 'CHANGES_REQUESTED', IN_WINDOW);
    insertVerdict('old', 'wo-old', 'sha-old', 'CHANGES_REQUESTED', '2026-10-26 00:00:00');
    insertVerdict('approved', 'wo-approved', 'sha-approved', 'APPROVED', IN_WINDOW);
    for (const [id, woId, headSha] of [
      ['msg-a', 'wo-a', 'sha-a'],
      ['msg-b', 'wo-b', 'sha-b'],
    ] as const) {
      db.run(
        `INSERT INTO agent_dispatch_messages (id, recipient, body, created_at) VALUES (?, 'taskmaster', ?, ?)`,
        [id, candidateBody(woId, headSha), IN_WINDOW]
      );
    }
    db.run(
      `INSERT INTO agent_dispatch_messages (id, recipient, body, created_at) VALUES (?, 'taskmaster', ?, ?)`,
      ['msg-prose', 'please run overseer_remediation_candidate for wo-prose', IN_WINDOW]
    );
    for (const woId of ['wo-a', 'wo-b', 'wo-c', 'wo-d', 'wo-old', 'wo-approved']) {
      db.run(`INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES (?, ?, ?)`, [
        `repair-${woId}`,
        IN_WINDOW,
        JSON.stringify({ wo_id: woId }),
      ]);
    }
    const warned = await runC6FixLoopHealth({ db, now: () => NOW, env: {} });
    const landed = await runC6FixLoopHealth({
      db,
      now: () => NOW,
      env: { OVERSEER_CANARY_HANDBACK_LANDED: '1' },
    });

    expect(warned.verdict).toBe('WARN');
    expect(landed.verdict).toBe('WARN');
    expect(warned.evidence.join('\n')).toContain('automatic=2 hand=2');
    expect(landed.evidence.join('\n')).toContain('automatic=2 hand=2');
    expect(warned.counts).toEqual({ automatic: 2, hand: 2 });
    expect(warned.verdict).not.toBe('FAIL');
    expect(landed.verdict).not.toBe('FAIL');
  });

  test('C7 emits one digest line for a result seen 10 times and ignores 9', async () => {
    const result = await runC7RepeatedRefusalTripwire({
      db: await loadFixture(ACTIONS_SQL, 'c7-tripwire.sql'),
      now: () => NOW,
    });
    const digests = result.evidence.filter(line => line.startsWith('digest:'));

    expect(result.verdict).toBe('WARN');
    expect(result.verdict).not.toBe('FAIL');
    expect(digests).toEqual(['digest: base_branch_missing_in_run_metadata count=10']);
    expect(result.evidence.some(line => line.includes('transient_retry'))).toBe(false);
    expect(result.evidence.some(line => line.includes('stale_window_result'))).toBe(false);
    expect(result.counts.tripped).toBe(1);
  });

  test('runner writes C1-C7 artifacts and the readonly database rejects writes', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'overseer-loop-'));
    const dbPath = join(outputRoot, 'events.db');
    const writable = new Database(dbPath);
    writable.exec(STORE_SQL);
    writable.run(
      `INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES (?, ?, ?)`,
      ['run-ok', IN_WINDOW, JSON.stringify({ base_branch: 'dev', head_branch: 'feature/ok' })]
    );
    writable.close();
    const opened = openOverseerLoopDatabase(dbPath);
    try {
      expect(Object.keys(opened.db)).toEqual(['query']);
      expect('run' in opened.db).toBe(false);
      expect('exec' in opened.db).toBe(false);
      expect('prepare' in opened.db).toBe(false);
      expect(() =>
        opened.db
          .query(
            `INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES ('z', '${IN_WINDOW}', '{}')`
          )
          .get()
      ).toThrow();
      const before = opened.db
        .query<{ n: number }>('SELECT COUNT(*) AS n FROM remote_agent_workflow_runs')
        .get();
      const report = await runOverseerLoopCanaries({
        db: opened.db,
        outputRoot,
        now: () => NOW,
        invocation: 'daily',
        env: {},
        forge: new FakeForge(OVERSEER_LOOP_CANARY_REPO, OVERSEER_LOOP_CANARY_BASE, true, true),
        scriptRunner: passingScripts,
        loadReviewBodies: async () => validReviews(),
        alertTransport: {
          postWebhook: async (): Promise<void> => undefined,
          postDispatch: async (): Promise<void> => undefined,
        },
        operatorToken: 'token',
        dispatchBaseUrl: 'http://127.0.0.1:9',
      });
      const after = opened.db
        .query<{ n: number }>('SELECT COUNT(*) AS n FROM remote_agent_workflow_runs')
        .get();
      expect(after?.n).toBe(before?.n);
      expect(() =>
        opened.db
          .query(
            `INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES ('y', '${IN_WINDOW}', '{}')`
          )
          .get()
      ).toThrow();
      expect(report.checks.map(item => item.name)).toEqual([
        'C1',
        'C2',
        'C3',
        'C4',
        'C5',
        'C6',
        'C7',
      ]);
      expect(report.checks.map(item => item.verdict)).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'PASS',
        'WARN',
        'PASS',
      ]);
      const jsonPath = report.artifactPaths.find(path => path.endsWith('summary.json'));
      const markdownPath = report.artifactPaths.find(path => path.endsWith('summary.md'));
      expect(jsonPath).toBeTruthy();
      expect(markdownPath).toBeTruthy();
      const parsed = JSON.parse(await readFile(jsonPath ?? '', 'utf8')) as {
        checks: { name: string }[];
      };
      const markdown = await readFile(markdownPath ?? '', 'utf8');
      expect(parsed.checks.map(item => item.name)).toEqual([
        'C1',
        'C2',
        'C3',
        'C4',
        'C5',
        'C6',
        'C7',
      ]);
      for (const name of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) {
        expect(markdown).toContain(`## ${name}`);
      }
    } finally {
      opened.close();
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test('FAIL alerts post one escalate_xo webhook and one operator dispatch message', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'overseer-loop-alert-'));
    const db = memoryDb(STORE_SQL);
    db.run(`INSERT INTO remote_agent_workflow_runs (id, started_at, metadata) VALUES (?, ?, ?)`, [
      'run-ok',
      IN_WINDOW,
      JSON.stringify({ base_branch: 'dev', head_branch: 'feature/ok' }),
    ]);
    for (let index = 1; index <= 3; index += 1) {
      db.run(
        `INSERT INTO overseer_actions (id, run_id, wo_id, class, action, result, created_at)
         VALUES (?, ?, 'WO-C2', 'merge', 'merge_denied', 'base_branch_missing_in_run_metadata', ?)`,
        [`denial-${index}`, `run-${index}`, IN_WINDOW]
      );
    }
    const webhookPosts: EscalatePayload[] = [];
    const dispatchPosts: DispatchPayload[] = [];
    const tokens: string[] = [];
    const webhookUrls: string[] = [];
    const transport: AlertTransport = {
      postWebhook: async (url, payload): Promise<void> => {
        webhookUrls.push(url);
        webhookPosts.push(payload);
      },
      postDispatch: async (_url, payload, token): Promise<void> => {
        tokens.push(token);
        dispatchPosts.push(payload);
      },
    };
    try {
      const report = await runOverseerLoopCanaries({
        db,
        outputRoot,
        now: () => NOW,
        invocation: 'daily',
        env: {},
        forge: new FakeForge(OVERSEER_LOOP_CANARY_REPO, OVERSEER_LOOP_CANARY_BASE, true, true),
        scriptRunner: passingScripts,
        loadReviewBodies: async () => validReviews(),
        alertTransport: transport,
        operatorToken: 'operator-token',
        dispatchBaseUrl: 'http://127.0.0.1:9',
        webhookUrl: 'https://example.test/webhook/builder-status',
      });
      const summaryPath = report.artifactPaths.find(path => path.endsWith('summary.json')) ?? '';
      expect(report.verdict).toBe('FAIL');
      expect(report.checks.filter(item => item.verdict === 'FAIL').map(item => item.name)).toEqual([
        'C2',
      ]);
      expect(webhookPosts).toHaveLength(1);
      expect(webhookUrls).toEqual(['https://example.test/webhook/builder-status']);
      expect(webhookPosts[0]?.action).toBe('escalate_xo');
      expect(webhookPosts[0]?.canary).toBe('C2');
      expect(webhookPosts[0]?.summary_path).toBe(summaryPath);
      expect(webhookPosts[0]?.evidence.join('\n')).toContain('base_branch_missing_in_run_metadata');
      expect(dispatchPosts).toHaveLength(1);
      expect(dispatchPosts[0]?.recipient).toBe('operator');
      expect(dispatchPosts[0]?.sender).toBe('overseer-loop-canary');
      expect(dispatchPosts[0]?.task_type).toBe('agent_message');
      expect(dispatchPosts[0]?.priority).toBe('blocker');
      expect(dispatchPosts[0]?.idempotency_key).toBe('overseer-loop:C2:2026-10-28');
      expect(tokens).toEqual(['operator-token']);
      const body = JSON.parse(dispatchPosts[0]?.body ?? '{}') as {
        canary?: string;
        summary_path?: string;
      };
      expect(body.canary).toBe('C2');
      expect(body.summary_path).toBe(summaryPath);
      expect(webhookPosts.some(post => post.canary !== 'C2')).toBe(false);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  test('CLI help, the daily schedule, and the duty-officer digest are wired', async () => {
    const helpOut: string[] = [];
    const helpRunner = mock(async () => {
      throw new Error('runner should not be called for help');
    });
    const helpExit = await runCanaryCli(
      ['overseer-loop', '--help'],
      {},
      {
        runner: mock(async () => {
          throw new Error('check runner');
        }),
        overseerLoopRunner: helpRunner,
        stdout: value => helpOut.push(value),
        stderr: value => helpOut.push(value),
      }
    );
    const missingRunner = mock(async () => {
      throw new Error('runner should not be called');
    });
    const missingExit = await runCanaryCli(
      ['overseer-loop', '--db-path', '', '--output-root', 'out'],
      {},
      {
        runner: mock(async () => {
          throw new Error('check runner');
        }),
        overseerLoopRunner: missingRunner,
        stdout: () => undefined,
        stderr: () => undefined,
      }
    );
    let invocation = '';
    let landed = false;
    const seenRunner = mock(async (options: OverseerLoopDeps) => {
      invocation = options.invocation ?? '';
      landed = options.branchIdentityLanded === true;
      return {
        invocation: options.invocation ?? 'daily',
        verdict: 'PASS' as const,
        checks: [],
        digest: 'overseer-loop FAIL=0 WARN=0 PASS=0 invocation=since-rebuild',
        alertNotes: [],
        artifactPaths: [],
      };
    });
    const writer = mock(async () => ['artifacts/overseer-loop/summary.json']);
    const cliDeps = {
      runner: mock(async () => {
        throw new Error('check runner');
      }),
      overseerLoopRunner: seenRunner,
      overseerLoopArtifactWriter: writer,
      stdout: () => undefined,
      stderr: () => undefined,
    };
    const sinceExit = await runCanaryCli(
      ['overseer-loop', '--since-rebuild', '--db-path', 'archon.db', '--output-root', 'artifacts'],
      { OVERSEER_CANARY_BRANCH_IDENTITY_LANDED: '1' },
      cliDeps
    );
    const sinceInvocation = invocation;
    const sinceLanded = landed;
    await runCanaryCli(
      ['overseer-loop', '--db-path', 'archon.db', '--output-root', 'artifacts'],
      { OVERSEER_CANARY_BRANCH_IDENTITY_LANDED: 'true' },
      cliDeps
    );
    const notLanded = landed;
    const fallbackErr: string[] = [];
    const fallbackExit = await runCanaryCli(
      ['nope'],
      {},
      {
        runner: mock(async () => {
          throw new Error('check runner');
        }),
        stdout: () => undefined,
        stderr: value => fallbackErr.push(value),
      }
    );
    const outputRoot = await mkdtemp(join(tmpdir(), 'overseer-loop-cli-'));
    let unreadableExit = 0;
    try {
      unreadableExit = await runCanaryCli(
        [
          'overseer-loop',
          '--db-path',
          join(outputRoot, 'missing-dir', 'archon.db'),
          '--output-root',
          outputRoot,
        ],
        {},
        {
          runner: mock(async () => {
            throw new Error('check runner');
          }),
          stdout: () => undefined,
          stderr: () => undefined,
        }
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
    const schedule = await readFile(
      join(REPO_ROOT, '.archon/scheduled/overseer-loop-canary-daily.yaml'),
      'utf8'
    );
    const doc = await readFile(join(REPO_ROOT, 'docs/canary/overseer-loop.md'), 'utf8');
    const digest = formatDutyOfficerDigest({
      invocation: 'since-rebuild',
      checks: [{ verdict: 'FAIL' }, { verdict: 'WARN' }, { verdict: 'PASS' }, { verdict: 'PASS' }],
    });
    const helpText = helpOut.join('\n');

    expect(helpExit).toBe(0);
    expect(helpRunner).not.toHaveBeenCalled();
    expect(helpText).toContain('overseer-loop');
    expect(helpText).toContain('--since-rebuild');
    expect(helpText).toContain('0 9 * * *');
    expect(missingExit).toBe(3);
    expect(missingRunner).not.toHaveBeenCalled();
    expect(sinceExit).toBe(0);
    expect(sinceInvocation).toBe('since-rebuild');
    expect(sinceLanded).toBe(true);
    expect(seenRunner).toHaveBeenCalled();
    expect(notLanded).toBe(false);
    expect(writer).toHaveBeenCalled();
    expect(fallbackExit).toBe(3);
    expect(fallbackErr.join('\n')).toContain('overseer-loop');
    expect(unreadableExit).toBe(3);
    expect(schedule).toContain('enabled: false');
    expect(schedule).toContain('schedule: "0 9 * * *"');
    expect(schedule).toContain('--since-rebuild');
    expect(schedule).toContain('mutation: read-only');
    expect(doc).toContain('--since-rebuild');
    expect(doc).toContain('0 9 * * *');
    expect(digest).toBe('overseer-loop FAIL=1 WARN=1 PASS=2 invocation=since-rebuild');
    expect(digest.includes('\n')).toBe(false);
  });
});
