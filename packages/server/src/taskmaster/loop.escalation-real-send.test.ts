/**
 * P0 escalation REAL-SEND tests (fence 281, found building bdc-harness PR 1484).
 *
 * The PR 1390 tests used a fake createTask, so they never reached the real
 * subject_key validator: a Taskmaster escalate_p0 whose thread ref is not a
 * GitHub issue (dispatch:<id>) was rejected with
 * dispatch_subject_key_invalid:shape on every real send.
 *
 * Everything here is real: a temp-home SqliteAdapter behind getDatabase(), the
 * real taskmaster journal DAL (no deps.db), and the real
 * createAuthenticatedMessage with its real validator and recipient check (no
 * deps.createTask). Only the Telegram page transport is captured, because a
 * test cannot page John.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rootLogger } from '@archon/paths';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { createTaskmasterState, tick, type ListedThread, type TaskmasterDeps } from './loop';

const T0 = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR = 3_600_000;
const DISPATCH_REF = 'dispatch:3f0c8d2a-1b4e-4c7d-9a10-5e2f6b7c8d9e';
const GH_REF = 'gh:thinmansoftware/bdc-harness#1484';

const saved = {
  home: process.env.ARCHON_HOME,
  url: process.env.DATABASE_URL,
  toIssue: process.env.TASKMASTER_ESCALATE_TO_ISSUE,
  fire: process.env.TASKMASTER_FIRE_VERB_ENABLED,
  blocker: process.env.TASKMASTER_BLOCKER_REPORT,
};
let home = '';

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  await closeDatabase();
  resetDatabase();
  home = mkdtempSync(join(tmpdir(), 'tm-p0-real-send-'));
  process.env.ARCHON_HOME = home;
  delete process.env.DATABASE_URL;
  // gh: refs take the dispatch path (not the GitHub-comment path) so the
  // unchanged-key case is exercised against the same real validator.
  process.env.TASKMASTER_ESCALATE_TO_ISSUE = 'false';
  process.env.TASKMASTER_FIRE_VERB_ENABLED = 'false';
  process.env.TASKMASTER_BLOCKER_REPORT = 'false';
  // Touch the database so the schema and principal seeds exist.
  await getDatabase().query('SELECT 1');
});

afterEach(async () => {
  await closeDatabase();
  resetDatabase();
  restore('ARCHON_HOME', saved.home);
  restore('DATABASE_URL', saved.url);
  restore('TASKMASTER_ESCALATE_TO_ISSUE', saved.toIssue);
  restore('TASKMASTER_FIRE_VERB_ENABLED', saved.fire);
  restore('TASKMASTER_BLOCKER_REPORT', saved.blocker);
  removeTempDirWithRetry(home);
});

function p0Thread(ref: string): ListedThread {
  return {
    ref,
    priority: 'P0',
    lastActivityAt: new Date(T0 - 2 * HOUR).toISOString(),
    isUnclaimedP0: true,
    recipient: 'xo',
    title: 'Unclaimed P0 item',
    ownerLogin: null,
    labels: ['wo', 'prio:P0'],
  };
}

function realDeps(ref: string, clock: { nowMs: number }, pages: string[]): TaskmasterDeps {
  return {
    now: () => new Date(clock.nowMs),
    headroom: async () => ({
      state: 'OK',
      tokensRemaining: 500_000,
      isUnknown: false,
      source: 'local_artifacts',
      observedAt: new Date(clock.nowMs).toISOString(),
    }),
    listThreads: async () => [p0Thread(ref)],
    listUndeliveredRulings: async () => [],
    getGithubIssueEvidence: async () => null,
    getDispatchReceiptCutoverAt: async () => new Date(T0 - 86_400_000).toISOString(),
    checkExpectations: async () => {},
    refreshLaneHealth: async () => {},
    reconcileWoClaims: async () => [],
    pageOperator: async (text: string) => {
      pages.push(text);
    },
  };
}

interface JournalRow {
  thread_ref: string;
  action_type: string;
  outcome: string;
  proposal_json: string;
  idempotency_key: string | null;
}

async function journal(): Promise<JournalRow[]> {
  const result = await getDatabase().query<JournalRow>(
    'SELECT thread_ref, action_type, outcome, proposal_json, idempotency_key FROM tm_journal ORDER BY created_at, id'
  );
  return [...result.rows];
}

/** Escalation rows only: the same tick also sends the daily digest to duty-officer. */
async function dispatchRows(): Promise<{ recipient: string; subject_key: string | null }[]> {
  const result = await getDatabase().query<{ recipient: string; subject_key: string | null }>(
    "SELECT recipient, subject_key FROM agent_dispatch_messages WHERE sender_principal_id = 'system:taskmaster' AND recipient = 't3-desktop'"
  );
  return [...result.rows];
}

function captureLogs(): { lines: string[]; stop: () => void } {
  const streamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
    symbol => symbol.description === 'pino.stream'
  );
  if (streamSymbol === undefined) throw new Error('pino.stream symbol missing on rootLogger');
  const stream = (rootLogger as unknown as Record<symbol, { write: (chunk: string) => boolean }>)[
    streamSymbol
  ];
  const lines: string[] = [];
  const original = stream.write;
  stream.write = (chunk: string) => {
    lines.push(String(chunk));
    return true;
  };
  return {
    lines,
    stop: () => {
      stream.write = original;
    },
  };
}

async function deactivateT3Desktop(): Promise<void> {
  // A real rejection: the recipient principal exists but is inactive, so the
  // real recipient assessment refuses the send.
  await getDatabase().query(
    "UPDATE dispatch_principals SET active = 0 WHERE principal_id = 't3-desktop'"
  );
}

describe('Taskmaster P0 escalation, real Dispatch send', () => {
  test('p0_escalation_dispatch_ref_delivers', async () => {
    const pages: string[] = [];
    const clock = { nowMs: T0 };
    await tick(createTaskmasterState(60_000), realDeps(DISPATCH_REF, clock, pages));

    const rows = await dispatchRows();
    expect(rows).toEqual([{ recipient: 't3-desktop', subject_key: 'digest:2026-11-04' }]);
    const escalations = (await journal()).filter(r => r.thread_ref === DISPATCH_REF);
    expect(escalations.map(r => [r.action_type, r.outcome])).toEqual([['escalate_p0', 'sent']]);
    expect(pages).toEqual([]);
  });

  test('p0_escalation_gh_ref_unchanged', async () => {
    const pages: string[] = [];
    const clock = { nowMs: T0 };
    await tick(createTaskmasterState(60_000), realDeps(GH_REF, clock, pages));

    const rows = await dispatchRows();
    expect(rows).toEqual([
      { recipient: 't3-desktop', subject_key: 'gh:thinmansoftware/bdc-harness#1484' },
    ]);
    const escalations = (await journal()).filter(r => r.thread_ref === GH_REF);
    expect(escalations.map(r => [r.action_type, r.outcome])).toEqual([['escalate_p0', 'sent']]);
    expect(pages).toEqual([]);
  });

  test('rejected_send_is_loud', async () => {
    await deactivateT3Desktop();
    const pages: string[] = [];
    const clock = { nowMs: T0 };
    const logs = captureLogs();
    try {
      await tick(createTaskmasterState(60_000), realDeps(DISPATCH_REF, clock, pages));
    } finally {
      logs.stop();
    }

    expect(await dispatchRows()).toEqual([]);
    const rows = await journal();
    const escalation = rows.filter(r => r.thread_ref === DISPATCH_REF);
    expect(escalation.map(r => [r.action_type, r.outcome])).toEqual([['escalate_p0', 'failed']]);
    const proposal = JSON.parse(escalation[0]!.proposal_json) as Record<string, unknown>;
    expect(String(proposal.failure)).toStartWith('dispatch_recipient_rejected:');
    expect(proposal.failure_stage).toBe('dispatch_send');
    expect(proposal.subject_key).toBe('digest:2026-11-04');

    const rejectedLines = logs.lines.filter(line =>
      line.includes('"msg":"taskmaster.dispatch_send_rejected"')
    );
    expect(rejectedLines).toHaveLength(1);
    expect(rejectedLines[0]).toContain(DISPATCH_REF);
    expect(rejectedLines[0]).toContain('dispatch_recipient_rejected:');

    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('[TASKMASTER SEND REJECTED]');
    expect(pages[0]).toContain(DISPATCH_REF);
    const pageRows = rows.filter(r => r.thread_ref === `dispatch-send-rejected:${DISPATCH_REF}`);
    expect(pageRows.map(r => [r.action_type, r.outcome])).toEqual([['escalate_p0', 'sent']]);
  });

  test('repeat_rejection_pages_once_per_hour', async () => {
    // escalate_p0 re-fires at most once per thread per day (routing cut-off),
    // so the verb that really repeats a rejected send inside one hour is the
    // daily digest: a failed digest row is retried on every tick. Refuse its
    // recipient for real and count rejections against pages.
    await getDatabase().query(
      "UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'duty-officer'"
    );
    const digestRef = 'digest:2026-11-04';
    const pages: string[] = [];
    const clock = { nowMs: T0 };
    const deps = realDeps(GH_REF, clock, pages);
    const state = createTaskmasterState(60_000);
    const logs = captureLogs();
    const rejectionsFor = (ref: string): number =>
      logs.lines.filter(
        line =>
          line.includes('"msg":"taskmaster.dispatch_send_rejected"') &&
          line.includes(`"threadRef":"${ref}"`)
      ).length;
    const digestPages = (): string[] => pages.filter(text => text.includes(digestRef));
    try {
      // Three rejected sends inside the same clock hour: one page.
      await tick(state, deps);
      clock.nowMs = T0 + 20 * 60_000;
      await tick(state, deps);
      clock.nowMs = T0 + 40 * 60_000;
      await tick(state, deps);
      expect(rejectionsFor(digestRef)).toBe(3);
      expect(digestPages()).toHaveLength(1);

      // Two more in the next hour: exactly one more page.
      clock.nowMs = T0 + HOUR + 5 * 60_000;
      await tick(state, deps);
      clock.nowMs = T0 + HOUR + 30 * 60_000;
      await tick(state, deps);
      expect(rejectionsFor(digestRef)).toBe(5);
      expect(digestPages()).toHaveLength(2);
    } finally {
      logs.stop();
    }

    const digestRow = (await journal()).filter(r => r.thread_ref === digestRef);
    expect(digestRow.map(r => [r.action_type, r.outcome])).toEqual([['digest', 'failed']]);
    const pageRows = (await journal()).filter(
      r => r.thread_ref === `dispatch-send-rejected:${digestRef}`
    );
    expect(pageRows.map(r => r.outcome)).toEqual(['sent', 'sent']);
    // The P0 escalation on the same tick still delivered: one bad recipient
    // does not take the other sends down with it.
    expect(await dispatchRows()).toHaveLength(1);
  });
});
