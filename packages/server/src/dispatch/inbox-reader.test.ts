import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readWorkerHeartbeatAlarmConfig } from './worker-heartbeat-alarm';
import { classifyInboxMessage, type GhSubjectState, type InboxMessage } from './inbox-reader-rules';
import {
  resolveInboxReaderConfig,
  runInboxReader,
  shouldStartOperatorInboxConsumer,
  type InboxReaderConfig,
  type InboxReaderDeps,
} from './inbox-reader';
import type { OpsInboxGitHub } from './ops-inbox';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  while (roots.length) await rm(roots.pop() as string, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function msg(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: overrides.id ?? `id-${Math.round((Date.parse('2026-01-01') % 1_000_000) + roots.length)}`,
    sender: 'overseer',
    task_type: 'run_report',
    recipient: 'operator',
    body: '{}',
    subject_key: null,
    created_at: '2026-09-01T00:00:00.000Z',
    status: 'queued',
    acknowledged_at: null,
    addressed_at: null,
    route_disposition: null,
    priority: 'normal',
    ...overrides,
  } as InboxMessage;
}

const OLD = '2026-09-01T00:00:00.000Z'; // 28 days before NOW
const RECENT = '2026-09-28T00:00:00.000Z'; // 1 day before NOW

function ghStateMap(
  map: Record<string, GhSubjectState>
): (key: string) => GhSubjectState | undefined {
  return (key: string) => map[key];
}

/** A fake ops-inbox GitHub + upsert. The upsert can be made to fail per section. */
function fakeOps(failSection: string | null = null) {
  const calls: { section: string; md: string }[] = [];
  const gh = {} as OpsInboxGitHub;
  const upsertDigestSection = async (
    _gh: OpsInboxGitHub,
    _date: string,
    section: string,
    md: string
  ): Promise<unknown> => {
    if (section === failSection) throw new Error(`injected ${section} failure`);
    calls.push({ section, md });
    return { issueNumber: 1, commentId: 1, created: false };
  };
  return { calls, gh, upsertDigestSection };
}

async function harness(
  rows: InboxMessage[],
  options: {
    mode?: 'dry-run' | 'enforce';
    env?: Record<string, string | undefined>;
    ops?: ReturnType<typeof fakeOps>;
    ghState?: Record<string, GhSubjectState>;
    createMessage?: InboxReaderDeps['createAuthenticatedMessage'];
    noConsumerQueued?: InboxReaderDeps['noConsumerQueued'];
    root?: string;
    now?: Date;
    resolveGithubState?: InboxReaderDeps['resolveGithubState'];
  } = {}
) {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), 'inbox-reader-')));
  if (!options.root) roots.push(root);
  const disposed: Array<Record<string, unknown>> = [];
  const config: InboxReaderConfig = {
    ...resolveInboxReaderConfig({
      INBOX_READER_MODE: options.mode ?? 'enforce',
      ...options.env,
    }),
    recipients: [...new Set(rows.map(row => row.recipient))] as ('xo' | 'operator')[],
  };
  if (config.recipients.length === 0) config.recipients = ['operator'];
  const resolveGithubState =
    options.resolveGithubState ??
    (options.ghState
      ? async (subjects: string[]): Promise<Record<string, GhSubjectState>> =>
          Object.fromEntries(subjects.map(s => [s, options.ghState?.[s] ?? 'UNKNOWN']))
      : undefined);
  const deps: InboxReaderDeps = {
    root,
    now: () => options.now ?? NOW,
    listMessages: async ({ recipient, limit }) =>
      rows.filter(row => row.recipient === recipient).slice(0, limit),
    disposeMessageByMachine: async data => {
      disposed.push(data);
      return { ok: true, message: rows.find(row => row.id === data.id) as never };
    },
    registerWorker: async () => undefined,
    heartbeatWorker: async () => undefined,
    opsInboxGitHub: options.ops?.gh,
    upsertDigestSection: options.ops?.upsertDigestSection,
    resolveGithubState,
    createAuthenticatedMessage: options.createMessage,
    noConsumerQueued: options.noConsumerQueued,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const result = await runInboxReader(deps, config);
  return { root, disposed, result };
}

describe('inbox reader rules', () => {
  const ctx = (ghState?: Record<string, GhSubjectState>) => ({
    now: NOW,
    ...(ghState ? { ghState: ghStateMap(ghState) } : {}),
  });

  test('Test 6 xo_triage_rules_table', () => {
    const cases: {
      message: InboxMessage;
      gh?: Record<string, GhSubjectState>;
      rule: string;
      action: string;
    }[] = [
      {
        message: msg({
          recipient: 'xo',
          sender: 'taskmaster',
          body: 'Nudge: ack please',
          created_at: OLD,
        }),
        rule: 'X1',
        action: 'DROP',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'taskmaster',
          body: 'expectation EXHAUSTED: owed by operator',
          created_at: OLD,
        }),
        rule: 'X2',
        action: 'DROP',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'escalation',
          subject_key: 'do:thread-7',
        }),
        rule: 'X3a',
        action: 'COLLAPSE',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'escalation',
          subject_key: 'digest:2026-09-29',
        }),
        rule: 'X3b',
        action: 'DIGEST',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'decision needed: approve the deploy',
          subject_key: 'gh:thinmansoftware/bdc-xo#100',
        }),
        gh: { 'gh:thinmansoftware/bdc-xo#100': 'OPEN' },
        rule: 'X3c',
        action: 'BRING',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'dispatch',
          task_type: 'agent_message',
          body: '{"kind":"xo_escalation_handoff","note":"re-verify"}',
          subject_key: 'gh:thinmansoftware/bdc-xo#200',
        }),
        gh: { 'gh:thinmansoftware/bdc-xo#200': 'MERGED' },
        rule: 'X4a',
        action: 'DROP',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'dispatch',
          task_type: 'agent_message',
          body: '{"kind":"xo_escalation_handoff","note":"re-verify"}',
          subject_key: 'gh:thinmansoftware/bdc-xo#201',
        }),
        gh: { 'gh:thinmansoftware/bdc-xo#201': 'OPEN' },
        rule: 'X4b',
        action: 'DIGEST',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'codex',
          task_type: 'agent_message',
          body: 'PONG',
          created_at: OLD,
        }),
        rule: 'X5a',
        action: 'DROP',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'codex',
          task_type: 'agent_message',
          body: 'status report all green',
          created_at: OLD,
        }),
        rule: 'X5b',
        action: 'DIGEST',
      },
      {
        message: msg({
          recipient: 'xo',
          sender: 'codex',
          task_type: 'agent_message',
          body: 'recent note for the xo',
          created_at: RECENT,
        }),
        rule: 'X5c',
        action: 'BRING',
      },
    ];
    for (const c of cases) {
      const verdict = classifyInboxMessage(c.message, ctx(c.gh));
      expect([c.rule, verdict.rule_id, verdict.action]).toEqual([c.rule, c.rule, c.action]);
    }
  });

  test('Test 7 operator_triage_rules_table', () => {
    const cases: {
      message: InboxMessage;
      gh?: Record<string, GhSubjectState>;
      rule: string;
      action: string;
    }[] = [
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"pr_review_ingest_receipt","disposition":"queued"}',
        }),
        rule: 'O1',
        action: 'DROP',
      },
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"pr_review_submit_receipt","disposition":"changes_requested"}',
          subject_key: 'gh:thinmansoftware/bdc-harness#300',
        }),
        gh: { 'gh:thinmansoftware/bdc-harness#300': 'MERGED' },
        rule: 'O2',
        action: 'DROP',
      },
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"pr_review_submit_receipt","disposition":"submission_failed"}',
        }),
        rule: 'O3a',
        action: 'BRING',
      },
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"pr_review_submit_receipt","disposition":"changes_requested"}',
          subject_key: 'gh:thinmansoftware/bdc-harness#301',
        }),
        gh: { 'gh:thinmansoftware/bdc-harness#301': 'OPEN' },
        rule: 'O3b',
        action: 'DIGEST',
      },
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"overseer_run_report","summary":"pass"}',
          created_at: OLD,
        }),
        rule: 'O4a',
        action: 'DROP',
      },
      {
        message: msg({
          sender: 'overseer',
          body: '{"kind":"overseer_run_report","summary":"pass"}',
          created_at: RECENT,
        }),
        rule: 'O4b',
        action: 'DIGEST',
      },
      {
        message: msg({
          sender: 'taskmaster',
          task_type: 'agent_message',
          body: 'Unclaimed P0: work has no owner',
          subject_key: 'gh:thinmansoftware/bdc-xo#400',
        }),
        gh: { 'gh:thinmansoftware/bdc-xo#400': 'CLOSED' },
        rule: 'O5a',
        action: 'DROP',
      },
      {
        message: msg({
          sender: 'taskmaster',
          task_type: 'agent_message',
          body: 'Unclaimed P0: work has no owner',
          subject_key: 'gh:thinmansoftware/bdc-xo#401',
        }),
        gh: { 'gh:thinmansoftware/bdc-xo#401': 'OPEN' },
        rule: 'O5b',
        action: 'COLLAPSE',
      },
      {
        message: msg({
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'dead-man alarm: worker A silent',
        }),
        rule: 'O6',
        action: 'COLLAPSE',
      },
      {
        message: msg({
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'Fuelglass seat-gate closed for pool X',
        }),
        rule: 'O7',
        action: 'COLLAPSE',
      },
      {
        message: msg({
          sender: 'taskmaster',
          task_type: 'agent_message',
          body: 'Taskmaster daily count digest: 48',
        }),
        rule: 'O8',
        action: 'COLLAPSE',
      },
      {
        message: msg({ sender: 'dispatch', task_type: 'agent_message', body: 'probe' }),
        rule: 'O9a',
        action: 'DROP',
      },
      {
        message: msg({
          sender: 'dispatch',
          task_type: 'agent_message',
          body: 'DO pass 2026-09-29 all green',
        }),
        rule: 'O9b',
        action: 'COLLAPSE',
      },
      {
        message: msg({
          sender: 'voice',
          task_type: 'agent_message',
          body: 'please review the call',
        }),
        rule: 'O10',
        action: 'BRING',
      },
    ];
    for (const c of cases) {
      const verdict = classifyInboxMessage(c.message, ctx(c.gh));
      expect([c.rule, verdict.rule_id, verdict.action]).toEqual([c.rule, c.rule, c.action]);
    }
  });

  test('Test 8 blocker_priority_and_unknown_sender_are_never_disposed', async () => {
    const fixtures: InboxMessage[] = [
      msg({
        id: 'b1',
        recipient: 'xo',
        sender: 'taskmaster',
        body: 'Nudge: ack',
        created_at: OLD,
        priority: 'blocker',
      }),
      msg({
        id: 'b2',
        recipient: 'xo',
        sender: 'taskmaster',
        body: 'expectation EXHAUSTED: owed',
        created_at: OLD,
        priority: 'blocker',
      }),
      msg({
        id: 'b3',
        recipient: 'operator',
        sender: 'random-bot',
        body: '{"kind":"pr_review_ingest_receipt","disposition":"queued"}',
        created_at: OLD,
      }),
      msg({
        id: 'b4',
        recipient: 'xo',
        sender: 'codex',
        task_type: 'agent_message',
        body: 'decision needed: approve PONG receipt',
        created_at: OLD,
      }),
      msg({
        id: 'b5',
        recipient: 'operator',
        sender: 'overseer',
        task_type: 'run_report',
        body: 'run failed; retries exhausted for WO-EXAMPLE-01',
        created_at: OLD,
      }),
    ];
    // Every fixture classifies BRING.
    for (const fixture of fixtures) {
      expect(classifyInboxMessage(fixture, { now: NOW }).action).toBe('BRING');
    }
    const ops = fakeOps();
    const { disposed, result } = await harness(fixtures, { mode: 'enforce', ops });
    expect(disposed).toHaveLength(0);
    expect(new Set(result.digest?.bring.map(item => item.id))).toEqual(
      new Set(['b1', 'b2', 'b3', 'b4', 'b5'])
    );
  });
});

describe('inbox reader', () => {
  test('Test 9 disposition_uses_machine_path_and_never_cancels', async () => {
    const drop = msg({
      id: 'drop-1',
      sender: 'overseer',
      body: '{"kind":"pr_review_ingest_receipt","disposition":"queued"}',
      created_at: OLD,
    });
    const { disposed } = await harness([drop], { mode: 'enforce', ops: fakeOps() });
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toEqual({
      id: 'drop-1',
      actor: 'system:inbox-reader',
      disposition: 'expired',
      requireNoReceipt: true,
    });
  });

  test('Test 12 digest_failure_does_not_disposition_rows', async () => {
    const digestRows = [
      msg({
        id: 'd1',
        sender: 'overseer',
        body: '{"kind":"overseer_run_report","summary":"pass"}',
        created_at: RECENT,
      }),
      msg({
        id: 'd2',
        sender: 'overseer',
        body: '{"kind":"overseer_run_report","summary":"ok"}',
        created_at: RECENT,
      }),
    ];
    const ops = fakeOps('mailbox-triage');
    const { disposed, result, root } = await harness(digestRows, { mode: 'enforce', ops });
    // Both rows are DIGEST (auto_surfaced); the GitHub write failed so neither disposed.
    expect(disposed).toHaveLength(0);
    const alertsText = await Bun.file(join(root, 'alerts.jsonl')).text();
    expect(alertsText.length).toBeGreaterThan(0);
    expect(result.digest?.disposal_plan.every(item => item.disposition === 'auto_surfaced')).toBe(
      true
    );
  });

  test('Test 13 dry_run_default_disposes_nothing', async () => {
    const rows = [
      msg({
        id: 'r1',
        sender: 'overseer',
        body: '{"kind":"pr_review_ingest_receipt","disposition":"queued"}',
        created_at: OLD,
      }),
      msg({
        id: 'r2',
        sender: 'overseer',
        body: '{"kind":"overseer_run_report","summary":"ok"}',
        created_at: RECENT,
      }),
    ];
    const { disposed, result, root } = await harness(rows, { mode: 'dry-run', ops: fakeOps() });
    expect(disposed).toHaveLength(0);
    expect(result.digest?.disposal_plan.length).toBeGreaterThan(0);
    expect(JSON.parse(await Bun.file(join(root, 'latest.json')).text()).mode).toBe('dry-run');
    expect(resolveInboxReaderConfig({ INBOX_READER_MODE: 'Enforce' }).mode).toBe('dry-run');
  });

  test('Test 14 github_state_lookups_are_bounded_and_cached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const rows = Array.from({ length: 120 }, (_, index) =>
      msg({
        id: `gh-${index}`,
        sender: 'overseer',
        body: '{"kind":"pr_review_submit_receipt","disposition":"changes_requested"}',
        subject_key: `gh:thinmansoftware/bdc-harness#${index + 1}`,
        created_at: OLD,
      })
    );
    const batches: number[] = [];
    const resolveGithubState = async (
      subjects: string[]
    ): Promise<Record<string, GhSubjectState>> => {
      batches.push(subjects.length);
      return Object.fromEntries(subjects.map(s => [s, 'MERGED' as GhSubjectState]));
    };
    await harness(rows, { mode: 'dry-run', ops: fakeOps(), resolveGithubState, root });
    expect(batches[0]).toBeLessThanOrEqual(50);
    const firstRunLookups = batches.reduce((a, b) => a + b, 0);
    expect(firstRunLookups).toBeLessThanOrEqual(50);
    await harness(rows, { mode: 'dry-run', ops: fakeOps(), resolveGithubState, root });
    const secondRunLookups = batches.reduce((a, b) => a + b, 0) - firstRunLookups;
    expect(secondRunLookups).toBeLessThanOrEqual(50);
    expect(secondRunLookups).toBeGreaterThan(0);
  });

  test('Test 21 reader_owns_operator_by_default', () => {
    expect(resolveInboxReaderConfig({}).recipients).toEqual(['xo', 'operator']);
    expect(shouldStartOperatorInboxConsumer({})).toBe(false);
    expect(
      resolveInboxReaderConfig({ INBOX_READER_OPERATOR_OWNER: 'consumer' }).recipients
    ).toEqual(['xo']);
    expect(shouldStartOperatorInboxConsumer({ INBOX_READER_OPERATOR_OWNER: 'consumer' })).toBe(
      true
    );
  });

  test('Test 22 surface_cursor_reads_each_line_once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const surfacePath = join(root, 'surface.jsonl');
    savedEnv.OPERATOR_INBOX_SURFACE_PATH = process.env.OPERATOR_INBOX_SURFACE_PATH;
    process.env.OPERATOR_INBOX_SURFACE_PATH = surfacePath;
    const lines = Array.from({ length: 2500 }, (_, index) =>
      JSON.stringify({
        messageId: `surface-${index}`,
        sender: 'overseer',
        taskType: 'run_report',
        originalBody: '{"kind":"overseer_run_report","summary":"ok"}',
        createdAt: OLD,
      })
    );
    await writeFile(surfacePath, `${lines.join('\n')}\n`);

    const linesOf = (calls: { section: string; md: string }[]): number => {
      const call = calls.find(c => c.section === 'operator_backlog');
      if (!call) return 0;
      const match = /operator backlog: (\d+) lines/.exec(call.md);
      return match ? Number(match[1]) : 0;
    };

    const run1Ops = fakeOps();
    const r1 = await harness([], { mode: 'dry-run', ops: run1Ops, root });
    expect(linesOf(run1Ops.calls)).toBe(2000);
    const cursorAfter1 = r1.result.digest?.surface_cursor ?? 0;
    expect(cursorAfter1).toBeGreaterThan(0);

    // Run 2's backlog write fails -> cursor must not advance.
    const run2Ops = fakeOps('operator_backlog');
    const r2 = await harness([], { mode: 'dry-run', ops: run2Ops, root });
    expect(r2.result.digest?.surface_cursor).toBe(cursorAfter1);

    // Run 3 re-reads lines 2001-2500 and advances to EOF.
    const run3Ops = fakeOps();
    const r3 = await harness([], { mode: 'dry-run', ops: run3Ops, root });
    expect(linesOf(run3Ops.calls)).toBe(500);
    expect(r3.result.digest?.surface_cursor).toBeGreaterThan(cursorAfter1);
  });

  test('Test 28 owner_ack_overdue_24h_note_then_72h_duty_officer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const rows = [
      msg({
        id: 'xo-25h',
        recipient: 'xo',
        sender: 'codex',
        task_type: 'agent_message',
        body: 'needs a look',
        created_at: '2026-09-28T11:00:00.000Z',
      }),
      msg({
        id: 'op-73h',
        recipient: 'operator',
        sender: 'voice',
        task_type: 'agent_message',
        body: 'please review the call',
        created_at: '2026-09-26T11:00:00.000Z',
      }),
    ];
    const created: Array<{ recipient: string; body: string }> = [];
    const createMessage: InboxReaderDeps['createAuthenticatedMessage'] = async (_ctx, data) => {
      created.push({ recipient: data.recipient, body: data.body });
      return null;
    };
    const r1 = await harness(rows, { mode: 'dry-run', ops: fakeOps(), createMessage, root });
    expect(r1.result.digest?.overdue.map(o => o.id).sort()).toEqual(['op-73h', 'xo-25h']);
    expect(created).toHaveLength(1);
    expect(created[0].recipient).toBe('duty-officer');
    expect(JSON.parse(created[0].body).kind).toBe('owner_ack_overdue');
    expect(JSON.parse(created[0].body).message_id).toBe('op-73h');

    const r2 = await harness(rows, { mode: 'dry-run', ops: fakeOps(), createMessage, root });
    expect(r2.result.digest?.overdue).toHaveLength(0);
    expect(created).toHaveLength(1);
  });

  test('Test 30 canary_fires_above_25_not_at_25', async () => {
    const seatRows = (count: number): InboxMessage[] =>
      Array.from({ length: count }, (_, index) =>
        msg({
          id: `canary-${index}`,
          recipient: 'xo',
          sender: 'codex',
          task_type: 'agent_message',
          body: `note ${index}`,
          created_at: '2026-09-29T05:00:00.000Z', // 7h before NOW
        })
      );

    // A: 26 rows -> one canary alert; a second run within 6h is suppressed.
    const rootA = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(rootA);
    const a1 = await harness(seatRows(26), { mode: 'dry-run', ops: fakeOps(), root: rootA });
    const canaryA = (a1.result.digest?.alerts ?? []).filter(x => x.kind === 'queued_age_canary');
    expect(canaryA).toHaveLength(1);
    expect(canaryA[0].recipient).toBe('xo');
    const a2 = await harness(seatRows(26), { mode: 'dry-run', ops: fakeOps(), root: rootA });
    expect(
      (a2.result.digest?.alerts ?? []).filter(x => x.kind === 'queued_age_canary')
    ).toHaveLength(0);

    // B: 25 rows -> no canary alert.
    const b = await harness(seatRows(25), { mode: 'dry-run', ops: fakeOps() });
    expect(
      (b.result.digest?.alerts ?? []).filter(x => x.kind === 'queued_age_canary')
    ).toHaveLength(0);

    // C: a principal with no consumer and one queued row -> alert naming it.
    const c = await harness(seatRows(1), {
      mode: 'dry-run',
      ops: fakeOps(),
      noConsumerQueued: async () => [{ principal: 'overseer', count: 1 }],
    });
    const canaryC = (c.result.digest?.alerts ?? []).filter(x => x.kind === 'queued_age_canary');
    expect(canaryC.some(alert => alert.recipient === 'overseer')).toBe(true);
  });

  test('heartbeat fires every run, even when listing fails', async () => {
    let beats = 0;
    const root = await mkdtemp(join(tmpdir(), 'inbox-reader-'));
    roots.push(root);
    const result = await runInboxReader({
      root,
      listMessages: async () => {
        throw new Error('boom');
      },
      registerWorker: async () => undefined,
      heartbeatWorker: async () => {
        beats += 1;
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(beats).toBe(1);
    expect(result.errors.join()).toContain('list_failed');
    expect(readWorkerHeartbeatAlarmConfig().workers).toContain('inbox-reader');
  });
});
