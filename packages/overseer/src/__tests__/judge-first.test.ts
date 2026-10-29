/**
 * Judge-first decision core tests (WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
 *
 * All dependencies are injected -- no mock.module, no live database, no real
 * subprocess spawns. Covers the WO's Section 7 scenarios at the unit level:
 * mandatory verdict rows, fail-loud judge health, claim/replay idempotency,
 * stricter-of-two tier law, and permit-free Tier 0 escalation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import {
  claimOverseerVerdict,
  finalizeOverseerVerdict,
  getOverseerActionsForRun,
  getVerdictByRunHead,
  insertOverseerAction,
  listRunsForOverseerWatch,
  listUnactionedFlagMergeReadyVerdicts,
  promoteObserveOrHealthyVerdict,
  promoteObserveOrHealthyVerdictWithReceipt,
} from '@archon/core/db/overseer';
import { rootLogger } from '@archon/paths';
import {
  buildEvidenceEnvelope,
  buildJudgePrompt,
  envelopeDigest,
  judgeTerminalRun,
  parseJudgeOutput,
  type JudgeOutcome,
  type JudgeSpawnResult,
} from '../judge-first';
import {
  DEFAULT_P0_MAX_RETRIES,
  DEFAULT_ROUTINE_MAX_RETRIES,
  handleRecordJudgeFirst,
  isP0Run,
  resolveJudgeMaxRetries,
} from '../judge-first-pipeline';
import { MAX_TIER, effectiveTier, requiredTierForAction, ruleOnAction } from '../tier-map';
import type {
  OverseerVerdictStoreDeps,
  OverseerWorkflowEvent,
  WatchedRunRecord,
} from '../types.ts';

interface LogDestination {
  write(chunk: string): unknown;
}

const loggerStreamSymbol = Object.getOwnPropertySymbols(rootLogger).find(
  symbol => String(symbol) === 'Symbol(pino.stream)'
)!;
const loggerDestination = (rootLogger as unknown as Record<symbol, LogDestination>)[
  loggerStreamSymbol
];
const originalLogWrite = loggerDestination.write.bind(loggerDestination);

afterEach(() => {
  loggerDestination.write = originalLogWrite;
});

function captureLogOutput(): string[] {
  const chunks: string[] = [];
  loggerDestination.write = (chunk: string): boolean => {
    chunks.push(chunk);
    return true;
  };
  return chunks;
}

function makeRecord(overrides: Partial<WatchedRunRecord> = {}): WatchedRunRecord {
  return {
    runId: 'run-1',
    woId: 'WO-TEST-01',
    owner: 'thinmansoftware',
    repo: 'bdc-harness',
    status: 'completed',
    headBranch: 'feat/test-branch',
    action: 'ignore',
    reason: 'classifier hint reason',
    prEvidence: {
      exists: false,
      state: 'missing',
      checks: { total: 0, passed: 0, failed: 0, pending: 0 },
      mergeable: null,
    },
    ...overrides,
  };
}

function makeEvent(id: string, message: string): OverseerWorkflowEvent {
  return {
    id,
    workflow_run_id: 'run-1',
    event_type: 'node_failed',
    step_name: 'commit-and-push',
    data: { error: message },
    created_at: `2026-07-28T00:00:0${id.slice(-1)}Z`,
  };
}

interface ReplayVerdictRow {
  id: string;
  verdict: string | null;
  proposedAction: string | null;
  actionedAt: string | null;
}

const REPLAY_SAFE_ACTIONS = new Set(['none', 'verdict_write', 'comment_findings']);

interface FakeStoreState {
  claims: { runId: string; headSha?: string }[];
  finalized: Record<string, unknown>[];
  replayRow?: ReplayVerdictRow | null;
  readCalls?: number;
  promoteCalls?: number;
  failReceiptInsert?: boolean;
  receipts?: { action: string; result: string }[];
}

function makeVerdictStore(
  claimResult: { claimed: boolean; verdictId?: string; retryCount?: number },
  state: FakeStoreState
): OverseerVerdictStoreDeps {
  return {
    claimVerdict: async input => {
      state.claims.push({ runId: input.runId, headSha: input.headSha });
      return claimResult;
    },
    finalizeVerdict: async input => {
      state.finalized.push(input as unknown as Record<string, unknown>);
      return input;
    },
    getVerdictByRunHead: async () => {
      state.readCalls = (state.readCalls ?? 0) + 1;
      return state.replayRow ?? null;
    },
    promoteObserveOrHealthyVerdict: async verdictId => {
      const row = state.replayRow;
      if (!row || row.id !== verdictId) return false;
      if (row.verdict !== 'observe' && row.verdict !== 'healthy') return false;
      if (row.actionedAt !== null) return false;
      if (row.proposedAction === null || !REPLAY_SAFE_ACTIONS.has(row.proposedAction)) return false;
      row.proposedAction = 'flag_merge_ready';
      return true;
    },
    promoteObserveOrHealthyVerdictWithReceipt: async input => {
      state.promoteCalls = (state.promoteCalls ?? 0) + 1;
      if (state.failReceiptInsert) {
        throw new Error('receipt_insert_failed');
      }
      const row = state.replayRow;
      if (!row || row.id !== input.verdictId) return false;
      if (row.verdict !== 'observe' && row.verdict !== 'healthy') return false;
      if (row.actionedAt !== null) return false;
      if (row.proposedAction === null || !REPLAY_SAFE_ACTIONS.has(row.proposedAction)) return false;
      row.proposedAction = 'flag_merge_ready';
      const receipts = state.receipts ?? [];
      receipts.push({ action: 'flag_merge_ready', result: input.result });
      state.receipts = receipts;
      return true;
    },
  };
}

function makeDeps(events: OverseerWorkflowEvent[] = []): {
  actions: { action: string; result: string }[];
  deps: Parameters<typeof handleRecordJudgeFirst>[1];
} {
  const actions: { action: string; result: string }[] = [];
  return {
    actions,
    deps: {
      listRunsForWatch: async () => [],
      listRunEvents: async () => events,
      insertOverseerAction: async record => {
        actions.push({ action: record.action, result: record.result });
      },
      findPullRequest: async () => ({
        exists: false,
        state: 'missing',
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: null,
      }),
      mergePullRequest: async () => {
        throw new Error('merge_unreachable_in_tests');
      },
    },
  };
}

const fakeEscalate: Parameters<typeof handleRecordJudgeFirst>[2]['escalate'] = async () =>
  ({ card_id: 'card-fake-1' }) as never;

function verdictOutcome(
  overrides: Partial<Extract<JudgeOutcome, { kind: 'verdict' }>> = {}
): JudgeOutcome {
  return {
    kind: 'verdict',
    verdict: 'healthy',
    confidence: 0.9,
    proposedAction: 'none',
    proposedTier: 0,
    reason: 'run completed cleanly',
    model: 'fake-judge',
    modelRung: 0,
    ...overrides,
  };
}

describe('tier-map: M-15 stricter-of-two law', () => {
  test('the four Tier 0 actions map to tier 0', () => {
    for (const action of [
      'verdict_write',
      'comment_findings',
      'flag_merge_ready',
      'escalate_with_evidence',
    ]) {
      expect(requiredTierForAction(action)).toBe(0);
    }
  });

  test('merge requires tier >= 1 and a tier-0 proposal cannot lower it', () => {
    const ruling = ruleOnAction('merge', 0);
    expect(ruling.requiredTier).toBeGreaterThanOrEqual(1);
    expect(ruling.effectiveTier).toBe(ruling.requiredTier);
    expect(ruling.executableInV1).toBe(false);
  });

  test('unknown action kinds fail closed to MAX_TIER', () => {
    expect(requiredTierForAction('invent_new_door')).toBe(MAX_TIER);
    expect(ruleOnAction('invent_new_door', 0).executableInV1).toBe(false);
  });

  test('the model can raise caution above the code floor', () => {
    expect(effectiveTier(2, 0)).toBe(2);
  });
});

describe('parseJudgeOutput: strict structured parsing', () => {
  test('parses a valid verdict object embedded in narration', () => {
    const parsed = parseJudgeOutput(
      'Here is my verdict:\n{"verdict":"merge_candidate","confidence":0.8,"proposed_action":"flag_merge_ready","proposed_tier":0,"reason":"green PR"}\n'
    );
    expect(parsed?.verdict).toBe('merge_candidate');
    expect(parsed?.confidence).toBe(0.8);
    expect(parsed?.proposedAction).toBe('flag_merge_ready');
  });

  // Regression (2026-07-30, live container): Grok emits its verdict object TWICE,
  // concatenated. The old scan took indexOf('{') .. lastIndexOf('}'), which spans
  // BOTH objects and yields invalid JSON, so every correct real verdict was
  // discarded as judge_invalid_output while the model was answering perfectly.
  // These are the exact 197 bytes captured from `docker exec archon-app-1 grok -p`.
  test('parses the FIRST object when the model emits its verdict twice', () => {
    const one =
      '{"verdict":"healthy","confidence":0.75,"proposed_action":"none","proposed_tier":0,"reason":"test"}';
    const parsed = parseJudgeOutput(one + one);
    expect(parsed).not.toBeNull();
    expect(parsed?.verdict).toBe('healthy');
    expect(parsed?.confidence).toBe(0.75);
    expect(parsed?.proposedAction).toBe('none');
  });

  test('parses duplicated pretty-printed output (the shape seen in the 7/30 logs)', () => {
    const pretty =
      '{\n  "verdict": "healthy",\n  "confidence": 0.75,\n  "proposed_action": "none",\n  "proposed_tier": 0,\n  "reason": "Workflow reached completed state"\n}';
    const parsed = parseJudgeOutput(`${pretty}\n${pretty}`);
    expect(parsed?.verdict).toBe('healthy');
    expect(parsed?.reason).toContain('completed state');
  });

  test('a brace inside a string value does not truncate the scan', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"needs_human","confidence":0.4,"proposed_action":"escalate_with_evidence","proposed_tier":0,"reason":"saw a literal } and { in the log tail"}'
    );
    expect(parsed?.verdict).toBe('needs_human');
    expect(parsed?.reason).toContain('literal }');
  });

  // Regression (2026-07-31, live): the model self-assigned proposed_tier 1 or 2 on
  // notify-class actions (80 of 194 verdicts at tier 1, 8 at tier 2). Stricter-of-two
  // then correctly refused 88 Tier 0 actions -- including ALL 27 flag_merge_ready on
  // 47 genuine merge candidates. The tier law was right; soliciting a tier from the
  // model and treating it as an authority floor was not. Any volunteered tier is now
  // ignored; code owns the floor.
  test('ignores a model-volunteered tier so it cannot suppress a Tier 0 action', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"merge_candidate","confidence":0.75,"proposed_action":"flag_merge_ready","proposed_tier":1,"reason":"green mergeable PR"}'
    );
    expect(parsed?.proposedAction).toBe('flag_merge_ready');
    expect(parsed?.proposedTier).toBe(0);
    expect(ruleOnAction(parsed!.proposedAction, parsed!.proposedTier).executableInV1).toBe(true);
  });

  test('an inflated tier cannot widen authority either -- merge still refused', () => {
    const parsed = parseJudgeOutput(
      '{"verdict":"merge_candidate","confidence":0.9,"proposed_action":"merge","proposed_tier":0,"reason":"looks fine"}'
    );
    const ruling = ruleOnAction(parsed!.proposedAction, parsed!.proposedTier);
    expect(ruling.requiredTier).toBeGreaterThanOrEqual(1);
    expect(ruling.executableInV1).toBe(false);
  });

  test('the prompt no longer solicits a tier', () => {
    const prompt = buildJudgePrompt(buildEvidenceEnvelope(makeRecord(), []));
    expect(prompt).not.toContain('"proposed_tier"');
    expect(prompt).toContain('Do NOT emit an authority tier');
  });

  test('rejects non-JSON, unknown verdicts, and out-of-range confidence', () => {
    expect(parseJudgeOutput('VERDICT: APPROVE')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"maybe","confidence":0.5}')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"healthy","confidence":1.5}')).toBeNull();
  });
});

describe('judgeTerminalRun: model ladder + fail-loud health', () => {
  const envelope = buildEvidenceEnvelope(makeRecord(), []);
  const ignoreOutcome = async (): Promise<never> => ({}) as never;

  test('ladder exhaustion by spawn failure is judge_unavailable, never a verdict', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['dead-a', 'dead-b'],
      spawn: async () => ({ exitCode: 1, stdout: '', timedOut: false }),
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('judge_unavailable');
  });

  test('ladder exhaustion by unparseable output is judge_invalid_output', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['chatty'],
      spawn: async () => ({ exitCode: 0, stdout: 'I feel great about this run!', timedOut: false }),
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('judge_invalid_output');
  });

  test('climbs the ladder: rung 0 dies, rung 1 answers', async () => {
    const spawn = async (binary: string): Promise<JudgeSpawnResult> =>
      binary === 'cheap'
        ? { exitCode: 124, stdout: '', timedOut: true }
        : {
            exitCode: 0,
            stdout:
              '{"verdict":"observe","confidence":0.7,"proposed_action":"none","proposed_tier":0,"reason":"ok"}',
            timedOut: false,
          };
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['cheap', 'strong'],
      spawn,
      recordOutcome: ignoreOutcome,
    });
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind === 'verdict') {
      expect(outcome.model).toBe('strong');
      expect(outcome.modelRung).toBe(1);
    }
  });

  // #852 (live 2026-09-15 13:47Z): OVERSEER_JUDGE_LADDER=codex,grok,cursor with
  // codex out of quota and grok out of credits. cursor was the only live rung,
  // so the ONLY acceptable outcome is its verdict -- never judge_unavailable.
  test('#852: codex and grok dead, cursor answers -- determinate verdict, not judge_unavailable', async () => {
    const spawned: string[] = [];
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['codex', 'grok', 'cursor'],
      spawn: async (binary: string): Promise<JudgeSpawnResult> => {
        spawned.push(binary);
        if (binary !== 'cursor') return { exitCode: 1, stdout: '', timedOut: false };
        return {
          exitCode: 0,
          stdout:
            '{"verdict":"observe","confidence":0.7,"proposed_action":"none","reason":"uneventful terminal run"}',
          timedOut: false,
        };
      },
      recordOutcome: ignoreOutcome,
    });
    expect(spawned).toEqual(['codex', 'grok', 'cursor']);
    expect(outcome).toMatchObject({
      kind: 'verdict',
      verdict: 'observe',
      model: 'cursor',
      modelRung: 2,
    });
  });

  test('records an unavailable outcome when spawning throws', async () => {
    const recorded: unknown[] = [];
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['missing'],
      spawn: async () => {
        throw new Error('ENOENT');
      },
      recordOutcome: async (...args) => {
        recorded.push(args);
        return {} as never;
      },
    });
    expect(outcome.kind).toBe('judge_unavailable');
    expect(recorded).toEqual([['missing', { exitCode: -1, timedOut: false }, 'judge-first']]);
  });

  test('logs a health-write failure with serialized error details without crashing', async () => {
    const output = captureLogOutput();
    await expect(
      judgeTerminalRun(envelope, {
        ladder: ['healthy-spawn'],
        spawn: async () => ({
          exitCode: 0,
          stdout:
            '{"verdict":"observe","confidence":0.7,"proposed_action":"none","proposed_tier":0,"reason":"ok"}',
          timedOut: false,
        }),
        recordOutcome: async () => {
          throw new Error('health write failed');
        },
      })
    ).resolves.toMatchObject({ kind: 'verdict' });
    const entry = output
      .flatMap(chunk => chunk.trim().split('\n'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.msg === 'overseer.judge_first.resource_health_record_failed');
    expect(entry?.level).toBe(50);
    expect(entry?.err).toMatchObject({ message: 'health write failed' });
    expect((entry?.err as { stack?: string } | undefined)?.stack).toContain('health write failed');
  });
});

describe('handleRecordJudgeFirst: pipeline', () => {
  test('Test 1: healthy run gets mandatory verdict row + verdict_write receipt', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(makeRecord({ action: 'success' }), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-1', retryCount: 0 }, state),
      judge: async () => verdictOutcome(),
      escalate: fakeEscalate,
    });
    expect(state.finalized).toHaveLength(1);
    expect(state.finalized[0]?.status).toBe('verdict');
    expect(state.finalized[0]?.verdict).toBe('healthy');
    expect(actions.map(a => a.action)).toEqual(['verdict_write']);
  });

  test('Test 2: dead judge finalizes an alarm state, never a semantic verdict', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(makeRecord({ status: 'failed', action: 'escalate' }), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-2', retryCount: 0 }, state),
      judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
      escalate: fakeEscalate,
    });
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(state.finalized[0]?.verdict).toBeUndefined();
    // Retry budget not yet exhausted: no receipt row, so the run stays retryable.
    expect(actions).toHaveLength(0);
  });

  test('Test 2b: exhausted retries escalate loudly with evidence', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(makeRecord({ status: 'failed', action: 'escalate' }), deps, {
      dryRun: false,
      actor: 'test',
      maxRetries: 3,
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-3', retryCount: 3 }, state),
      judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
      escalate: fakeEscalate,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('escalate_with_evidence');
    expect(actions[0]?.result).toContain('operator_card:card-fake-1');
  });

  // WO-HARNESS-OVERSEER-JUDGE-BUDGET-CIRCUIT-01 (narrowed): P0 must escalate on the
  // FIRST judge health failure, not after the routine 3-retry wait. Outcome kinds are
  // judge_unavailable | judge_invalid_output | evidence_unavailable -- there is no
  // literal judge_daily_budget_exhausted value (daily circuit deleted in #602).
  test('Test 2c: P0 run escalates on first judge health failure (no retry wait)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(
      makeRecord({
        status: 'failed',
        action: 'escalate',
        woId: 'WO-HARNESS-CRITICAL-01',
        metadata: { priority: 'P0' },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        // Deliberately omit maxRetries so the pipeline must derive P0 sizing itself.
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-p0', retryCount: 0 }, state),
        judge: async () => ({
          kind: 'judge_unavailable',
          reason: 'all ladder rung(s) unavailable (spawn failure, timeout, or nonzero exit)',
        }),
        escalate: fakeEscalate,
      }
    );
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('escalate_with_evidence');
    expect(actions[0]?.result).toContain('operator_card:card-fake-1');
    expect(actions[0]?.result).toMatch(/judge_health_judge_unavailable|p0/i);
  });

  test('Test 2d: routine run still does not escalate at retryCount 0', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'boom')]);
    await handleRecordJudgeFirst(
      makeRecord({ status: 'failed', action: 'escalate', woId: 'WO-ROUTINE-01' }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-r0', retryCount: 0 }, state),
        judge: async () => ({ kind: 'judge_unavailable', reason: 'all rungs dead' }),
        escalate: fakeEscalate,
      }
    );
    expect(state.finalized[0]?.status).toBe('judge_unavailable');
    expect(actions).toHaveLength(0);
  });
});

describe('judge retry budget sizing (WO-HARNESS-OVERSEER-JUDGE-BUDGET-CIRCUIT-01)', () => {
  test('routine default is 3 retries; P0 default is 0 (immediate escalate)', () => {
    // Sized against #1390 volume (~533 verdicts sample): daily CALL cap was deleted
    // because it killed 60% of verdicts. Per-run retry ceiling remains so a dead
    // judge cannot re-queue forever. P0 skips the wait.
    expect(DEFAULT_ROUTINE_MAX_RETRIES).toBe(3);
    expect(DEFAULT_P0_MAX_RETRIES).toBe(0);
  });

  test('isP0Run detects metadata.priority, metadata.prio, labels, and woId markers', () => {
    expect(isP0Run(makeRecord({ metadata: { priority: 'P0' } }))).toBe(true);
    expect(isP0Run(makeRecord({ metadata: { prio: 'p0' } }))).toBe(true);
    expect(isP0Run(makeRecord({ metadata: { labels: ['wo', 'prio:P0'] } }))).toBe(true);
    expect(isP0Run(makeRecord({ woId: 'WO-P0-AUTH-01' }))).toBe(true);
    expect(isP0Run(makeRecord({ woId: 'WO-HARNESS-FOO-01' }))).toBe(false);
    expect(isP0Run(makeRecord({ metadata: { priority: 'P1' } }))).toBe(false);
  });

  test('resolveJudgeMaxRetries prefers explicit option, then P0, then routine', () => {
    const p0 = makeRecord({ metadata: { priority: 'P0' } });
    const routine = makeRecord({ woId: 'WO-ROUTINE-01' });
    expect(resolveJudgeMaxRetries(p0, {})).toBe(DEFAULT_P0_MAX_RETRIES);
    expect(resolveJudgeMaxRetries(routine, {})).toBe(DEFAULT_ROUTINE_MAX_RETRIES);
    expect(resolveJudgeMaxRetries(p0, { maxRetries: 7 })).toBe(7);
    expect(resolveJudgeMaxRetries(routine, { maxRetries: 1 })).toBe(1);
  });
});

describe('handleRecordJudgeFirst: pipeline (continued)', () => {
  test('Test 3: lost claim means replay -- no model call, no duplicate action', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let judgeCalls = 0;
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: false }, state),
      judge: async () => {
        judgeCalls += 1;
        return verdictOutcome();
      },
      escalate: fakeEscalate,
    });
    expect(judgeCalls).toBe(0);
    // Replay of a non-actionable (ignore) record now writes exactly ONE
    // terminal watch_closed disposition (judge-first window drain, 8th canary
    // defect 2026-08-25) -- and nothing else: no merge, no escalation, no
    // model call, no finalize.
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe('watch_closed');
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3b: lost claim on a merge_ready record writes NOTHING (stays live)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({ action: 'merge_ready', reason: 'green mergeable PR' }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3d: lost claim with a still-OPEN PR stays open -- CI may be pending (11th defect)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({
        action: 'ignore',
        reason: 'completed run; PR not merge-ready (checks pending)',
        prEvidence: {
          exists: true,
          state: 'open',
          checks: { total: 3, passed: 1, failed: 0, pending: 2 },
          mergeable: true,
        },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 3c: lost claim with a TRANSIENT lookup failure stays open (no close)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(
      makeRecord({
        action: 'ignore',
        prEvidence: {
          exists: false,
          state: 'lookup_failed',
          checks: { total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable: null,
          lookupFailed: true,
        },
      }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: false }, state),
        judge: async () => verdictOutcome(),
        escalate: fakeEscalate,
      }
    );
    expect(actions).toHaveLength(0);
    expect(state.finalized).toHaveLength(0);
  });

  test('Test 4: model proposing merge at tier 0 is refused by the stricter code tier', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-4', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'observe', proposedAction: 'merge', proposedTier: 0 }),
      escalate: fakeEscalate,
    });
    expect(state.finalized[0]?.requiredTier).toBeGreaterThanOrEqual(1);
    expect(actions.map(a => a.action)).toEqual(['verdict_write', 'tier_refused']);
    expect(coordinatorCalled).toBe(0);
  });

  test('Test 5: Tier 0 escalation runs without any permit and never yields permit_missing', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps([makeEvent('e1', 'genuine failure')]);
    await handleRecordJudgeFirst(
      makeRecord({ status: 'failed', action: 'escalate', errorClass: 'unknown', metadata: {} }),
      deps,
      {
        dryRun: false,
        actor: 'test',
        verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-5', retryCount: 0 }, state),
        judge: async () =>
          verdictOutcome({ verdict: 'failed_genuine', proposedAction: 'escalate_with_evidence' }),
        escalate: fakeEscalate,
      }
    );
    const escalation = actions.find(a => a.action === 'escalate_with_evidence');
    expect(escalation).toBeDefined();
    expect(escalation?.result).not.toContain('permit_missing');
    expect(escalation?.result).toContain('operator_card:card-fake-1');
  });

  test('merge_candidate with a genuinely merge-ready PR flags and hands off to the steward', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 3, passed: 3, failed: 0, pending: 0 },
        mergeable: true,
        headSha: 'abc123',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 42 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-6', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.map(a => a.action)).toEqual(['verdict_write', 'flag_merge_ready']);
    expect(coordinatorCalled).toBe(1);
    expect(state.claims[0]?.headSha).toBe('abc123');
  });

  test('dry run: flag_merge_ready receipt written, steward handoff suppressed', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    let coordinatorCalled = 0;
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        headSha: 'def456',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 43 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: true,
      actor: 'test',
      mergeCoordinator: async () => {
        coordinatorCalled += 1;
        return undefined;
      },
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-7', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.find(a => a.action === 'flag_merge_ready')?.result).toContain('dry_run');
    expect(coordinatorCalled).toBe(0);
  });

  test('merge_candidate WITHOUT a merge-ready PR does not flag (deterministic gate holds)', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    await handleRecordJudgeFirst(makeRecord(), deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-8', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'merge_candidate', proposedAction: 'flag_merge_ready' }),
      escalate: fakeEscalate,
    });
    expect(actions.map(a => a.action)).toEqual(['verdict_write']);
  });

  test('duplicate_work without a comment channel records a loud unavailable receipt', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: false,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 44 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-9', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'duplicate_work', proposedAction: 'comment_findings' }),
      escalate: fakeEscalate,
    });
    const comment = actions.find(a => a.action === 'comment_findings');
    expect(comment?.result).toContain('comment_channel_unavailable');
  });

  test('comment_findings posts through the injected channel', async () => {
    const state: FakeStoreState = { claims: [], finalized: [] };
    const { actions, deps } = makeDeps();
    const posted: string[] = [];
    deps.commentOnPullRequest = async input => {
      posted.push(input.body);
      return { commented: true, url: 'https://github.com/x/y/pull/44#comment-1' };
    };
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: false,
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 44 },
      },
    });
    await handleRecordJudgeFirst(record, deps, {
      dryRun: false,
      actor: 'test',
      verdictStore: makeVerdictStore({ claimed: true, verdictId: 'v-10', retryCount: 0 }, state),
      judge: async () =>
        verdictOutcome({ verdict: 'duplicate_work', proposedAction: 'comment_findings' }),
      escalate: fakeEscalate,
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('duplicate_work');
    expect(actions.find(a => a.action === 'comment_findings')?.result).toContain('commented:');
  });

  function greenReplayRecord(
    checks: { total: number; passed: number; failed: number; pending: number } = {
      total: 3,
      passed: 3,
      failed: 0,
      pending: 0,
    }
  ): WatchedRunRecord {
    return makeRecord({
      action: 'ignore',
      reason: 'completed run; PR open',
      prEvidence: {
        exists: true,
        state: 'open',
        checks,
        mergeable: true,
        headSha: 'H',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1372 },
      },
    });
  }

  function replayState(verdict: string): FakeStoreState {
    return {
      claims: [],
      finalized: [],
      readCalls: 0,
      promoteCalls: 0,
      replayRow: {
        id: 'verdict-replay-1',
        verdict,
        proposedAction: 'comment_findings',
        actionedAt: null,
      },
    };
  }

  async function runReplayTick(
    record: WatchedRunRecord,
    state: FakeStoreState,
    dryRun = false,
    withHandoff = true
  ): Promise<{
    actions: { action: string; result: string }[];
    judgeCalls: number;
    coordinatorCalls: WatchedRunRecord[];
    handoffCalls: WatchedRunRecord[];
  }> {
    const { actions, deps } = makeDeps();
    let judgeCalls = 0;
    const coordinatorCalls: WatchedRunRecord[] = [];
    const handoffCalls: WatchedRunRecord[] = [];
    await handleRecordJudgeFirst(record, deps, {
      dryRun,
      actor: 'test',
      mergeCoordinator: async seen => {
        coordinatorCalls.push(seen);
      },
      ...(withHandoff
        ? {
            deterministicMergeHandoff: {
              handoff: async (seen: WatchedRunRecord) => {
                handoffCalls.push(seen);
              },
            },
          }
        : {}),
      verdictStore: makeVerdictStore({ claimed: false }, state),
      judge: async () => {
        judgeCalls += 1;
        return verdictOutcome();
      },
      escalate: fakeEscalate,
    });
    return { actions, judgeCalls, coordinatorCalls, handoffCalls };
  }

  test('replay green Test 1: pending checks stay observe and do not merge', async () => {
    const state = replayState('observe');
    const record = greenReplayRecord({ total: 18, passed: 17, failed: 0, pending: 1 });
    const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
      record,
      state
    );
    expect(judgeCalls).toBe(0);
    expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    expect(state.readCalls).toBe(0);
    expect(state.promoteCalls).toBe(0);
    expect(coordinatorCalls).toHaveLength(0);
    expect(handoffCalls).toHaveLength(0);
    expect(state.replayRow?.verdict).toBe('observe');
    expect(state.replayRow?.proposedAction).toBe('comment_findings');
  });

  test('replay green Test 2: green after observe promotes once and calls the coordinator', async () => {
    const state = replayState('observe');
    const record = greenReplayRecord();
    const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
      record,
      state
    );
    const handoffs = state.receipts ?? [];
    expect(judgeCalls).toBe(0);
    expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.result.startsWith('steward_handoff:replay_green:verdict:')).toBe(true);
    expect(handoffs[0]?.result).toBe('steward_handoff:replay_green:verdict:verdict-replay-1');
    expect(state.replayRow?.proposedAction).toBe('flag_merge_ready');
    expect(state.promoteCalls).toBe(1);
    expect(coordinatorCalls).toHaveLength(0);
    expect(handoffCalls).toEqual([record]);
  });

  test('replay green Test 2b: green after healthy promotes once and calls the coordinator', async () => {
    const state = replayState('healthy');
    const record = greenReplayRecord();
    const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
      record,
      state
    );
    const handoffs = state.receipts ?? [];
    expect(judgeCalls).toBe(0);
    expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.result).toBe('steward_handoff:replay_green:verdict:verdict-replay-1');
    expect(state.replayRow?.proposedAction).toBe('flag_merge_ready');
    expect(coordinatorCalls).toHaveLength(0);
    expect(handoffCalls).toEqual([record]);
  });

  test('replay green Test 3: second tick is a no-op', async () => {
    const state = replayState('observe');
    const record = greenReplayRecord();
    const first = await runReplayTick(record, state);
    const second = await runReplayTick(record, state);
    const handoffs = state.receipts ?? [];
    expect(first.judgeCalls).toBe(0);
    expect(second.judgeCalls).toBe(0);
    expect(handoffs).toHaveLength(1);
    expect(first.coordinatorCalls).toHaveLength(0);
    expect(second.coordinatorCalls).toHaveLength(0);
    expect(first.handoffCalls).toHaveLength(1);
    expect(second.handoffCalls).toHaveLength(0);
    expect(state.promoteCalls).toBe(1);
    expect(state.replayRow?.proposedAction).toBe('flag_merge_ready');
  });

  test.each(['needs_human', 'failed_genuine', 'duplicate_work'])(
    'replay green Test 4: %s prior verdict never auto-merges',
    async verdict => {
      const state = replayState(verdict);
      const record = greenReplayRecord();
      const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
        record,
        state
      );
      expect(judgeCalls).toBe(0);
      expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
      expect(state.readCalls).toBe(1);
      expect(state.promoteCalls).toBe(0);
      expect(coordinatorCalls).toHaveLength(0);
      expect(handoffCalls).toHaveLength(0);
      expect(state.replayRow?.proposedAction).toBe('comment_findings');
    }
  );

  test('replay green Test 6: dry run records the handoff and does not act', async () => {
    const state = replayState('observe');
    const record = greenReplayRecord();
    const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
      record,
      state,
      true
    );
    const handoffs = actions.filter(action => action.action === 'flag_merge_ready');
    expect(judgeCalls).toBe(0);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.result.endsWith(':dry_run')).toBe(true);
    expect(handoffs[0]?.result).toBe(
      'steward_handoff:replay_green:verdict:verdict-replay-1:dry_run'
    );
    expect(state.promoteCalls).toBe(0);
    expect(state.replayRow?.proposedAction).toBe('comment_findings');
    expect(coordinatorCalls).toHaveLength(0);
    expect(handoffCalls).toHaveLength(0);
  });

  test('replay green: receipt insert failure does not promote and does not hand off', async () => {
    const state = replayState('observe');
    state.failReceiptInsert = true;
    const record = greenReplayRecord();
    const failed = await runReplayTick(record, state);
    expect(failed.judgeCalls).toBe(0);
    expect(failed.actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    expect(state.receipts ?? []).toHaveLength(0);
    expect(failed.handoffCalls).toHaveLength(0);
    expect(failed.coordinatorCalls).toHaveLength(0);
    expect(state.promoteCalls).toBe(1);
    expect(state.replayRow?.proposedAction).toBe('comment_findings');
    expect(state.replayRow?.verdict).toBe('observe');

    state.failReceiptInsert = false;
    const retried = await runReplayTick(record, state);
    expect(retried.handoffCalls).toEqual([record]);
    expect(retried.coordinatorCalls).toHaveLength(0);
    expect(state.replayRow?.proposedAction).toBe('flag_merge_ready');
    expect(state.receipts).toEqual([
      {
        action: 'flag_merge_ready',
        result: 'steward_handoff:replay_green:verdict:verdict-replay-1',
      },
    ]);
  });

  test('replay green: missing deterministic handoff does not promote', async () => {
    const state = replayState('observe');
    const record = greenReplayRecord();
    const { actions, judgeCalls, coordinatorCalls, handoffCalls } = await runReplayTick(
      record,
      state,
      false,
      false
    );
    expect(judgeCalls).toBe(0);
    expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    expect(state.promoteCalls).toBe(0);
    expect(state.replayRow?.proposedAction).toBe('comment_findings');
    expect(coordinatorCalls).toHaveLength(0);
    expect(handoffCalls).toHaveLength(0);
  });

  test.each([
    ['escalate_with_evidence', null],
    [null, null],
    ['not_a_real_action', null],
    ['flag_merge_ready', null],
    ['comment_findings', '2026-10-29T00:00:00.000Z'],
  ] as const)(
    'replay green Test 7 unit: unsafe action %s stays blocked',
    async (proposedAction, actionedAt) => {
      const state = replayState('observe');
      state.replayRow = {
        id: 'verdict-replay-1',
        verdict: 'observe',
        proposedAction,
        actionedAt,
      };
      const record = greenReplayRecord();
      const live = await runReplayTick(record, state);
      const dry = await runReplayTick(record, state, true);
      expect(live.judgeCalls).toBe(0);
      expect(dry.judgeCalls).toBe(0);
      expect(live.actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
      expect(dry.actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
      expect(live.handoffCalls).toHaveLength(0);
      expect(dry.handoffCalls).toHaveLength(0);
      expect(live.coordinatorCalls).toHaveLength(0);
      expect(state.promoteCalls).toBe(0);
      expect(state.replayRow?.proposedAction).toBe(proposedAction);
    }
  );
});

const testFileArgs = process.argv.filter(arg => arg.endsWith('.test.ts'));
const soleJudgeFirstFile =
  testFileArgs.length === 1 && testFileArgs[0]?.endsWith('judge-first.test.ts') === true;

if (soleJudgeFirstFile) {
  describe('replay green real adapter', () => {
    let home = '';
    const savedArchonHome = process.env.ARCHON_HOME;
    const savedDatabaseUrl = process.env.DATABASE_URL;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'archon-replay-green-'));
      process.env.ARCHON_HOME = home;
      delete process.env.DATABASE_URL;
      await closeDatabase();
      resetDatabase();
      getDatabase();
    });

    afterAll(async () => {
      await closeDatabase();
      resetDatabase();
      if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedArchonHome;
      if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDatabaseUrl;
      if (home) rmSync(home, { recursive: true, force: true });
    });

    async function seedCompletedRun(id: string): Promise<void> {
      const db = getDatabase();
      await db.query(
        `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, title)
         VALUES ($1, 'test', $1, 'Test')`,
        [`conv-${id}`]
      );
      await db.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, workflow_name, user_message, status, metadata, completed_at)
         VALUES ($1, $2, 'bdc-feature-development', $3, 'completed', $4, $5)`,
        [
          id,
          `conv-${id}`,
          'Implement WO-REPLAY-GREEN-01',
          JSON.stringify({
            woId: 'WO-REPLAY-GREEN-01',
            targetRepo: 'thinmansoftware/bdc-harness',
            headBranch: `wo/${id}`,
          }),
          '2026-10-29T00:00:00.000Z',
        ]
      );
    }

    async function seedVerdict(input: {
      runId: string;
      verdict: string;
      proposedAction: string | null;
      headSha?: string;
    }): Promise<string> {
      const claim = await claimOverseerVerdict({
        runId: input.runId,
        woId: 'WO-REPLAY-GREEN-01',
        headSha: input.headSha ?? 'H',
      });
      if (!claim.verdictId) throw new Error(`claim_failed:${input.runId}`);
      await finalizeOverseerVerdict({
        verdictId: claim.verdictId,
        status: 'verdict',
        verdict: input.verdict,
        ...(input.proposedAction === null ? {} : { proposedAction: input.proposedAction }),
      });
      return claim.verdictId;
    }

    function prEvidence(pending: number): WatchedRunRecord['prEvidence'] {
      const total = pending > 0 ? 18 : 3;
      return {
        exists: true,
        state: 'open',
        checks: { total, passed: total - pending, failed: 0, pending },
        mergeable: true,
        headSha: 'H',
        pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1373 },
      };
    }

    function realVerdictStore(
      overrides: Partial<OverseerVerdictStoreDeps> = {}
    ): OverseerVerdictStoreDeps {
      return {
        claimVerdict: claimOverseerVerdict,
        finalizeVerdict: finalizeOverseerVerdict,
        getVerdictByRunHead,
        promoteObserveOrHealthyVerdict,
        promoteObserveOrHealthyVerdictWithReceipt,
        ...overrides,
      };
    }

    async function installReceiptFailureGuards(): Promise<void> {
      const db = getDatabase();
      await db.query(
        `CREATE TRIGGER reject_replay_green_receipt BEFORE INSERT ON overseer_actions
         WHEN NEW.action = 'flag_merge_ready'
         BEGIN SELECT RAISE(ABORT, 'receipt_insert_failed'); END`
      );
      await db.query(
        `CREATE TRIGGER reject_replay_green_revert BEFORE UPDATE ON overseer_verdicts
         WHEN OLD.proposed_action = 'flag_merge_ready' AND NEW.proposed_action != 'flag_merge_ready'
         BEGIN SELECT RAISE(ABORT, 'revert_failed'); END`
      );
    }

    async function dropReceiptFailureGuards(): Promise<void> {
      const db = getDatabase();
      await db.query('DROP TRIGGER IF EXISTS reject_replay_green_receipt');
      await db.query('DROP TRIGGER IF EXISTS reject_replay_green_revert');
    }

    async function runRealReplay(input: {
      runId: string;
      evidence: WatchedRunRecord['prEvidence'];
      dryRun?: boolean;
      action?: WatchedRunRecord['action'];
      store?: OverseerVerdictStoreDeps;
      tally?: { handoff: number; coordinator: number; judge: number };
      withHandoff?: boolean;
      judge?: Parameters<typeof handleRecordJudgeFirst>[2]['judge'];
    }): Promise<{ handoff: number; coordinator: number; judge: number }> {
      const tally = input.tally ?? { handoff: 0, coordinator: 0, judge: 0 };
      const { deps } = makeDeps();
      deps.insertOverseerAction = async record => {
        await insertOverseerAction(record);
      };
      await handleRecordJudgeFirst(
        makeRecord({
          runId: input.runId,
          woId: 'WO-REPLAY-GREEN-01',
          action: input.action ?? 'ignore',
          prEvidence: input.evidence,
        }),
        deps,
        {
          dryRun: input.dryRun ?? false,
          actor: 'test',
          mergeCoordinator: async () => {
            tally.coordinator += 1;
          },
          ...(input.withHandoff === false
            ? {}
            : {
                deterministicMergeHandoff: {
                  handoff: async () => {
                    tally.handoff += 1;
                  },
                },
              }),
          verdictStore: input.store ?? realVerdictStore(),
          judge: async (envelope, judgeOptions) => {
            tally.judge += 1;
            if (input.judge) return input.judge(envelope, judgeOptions);
            return verdictOutcome();
          },
          escalate: fakeEscalate,
        }
      );
      return tally;
    }

    test('replay green Test 7: safe actions promote once on the real adapter', async () => {
      const cases = [
        ['observe', 'none'],
        ['observe', 'verdict_write'],
        ['observe', 'comment_findings'],
        ['healthy', 'none'],
        ['healthy', 'verdict_write'],
        ['healthy', 'comment_findings'],
      ] as const;
      for (const [verdict, proposedAction] of cases) {
        const runId = `run-safe-${verdict}-${proposedAction}`;
        await seedCompletedRun(runId);
        const verdictId = await seedVerdict({ runId, verdict, proposedAction });
        const first = await runRealReplay({ runId, evidence: prEvidence(0) });
        const second = await runRealReplay({ runId, evidence: prEvidence(0) });
        const row = await getVerdictByRunHead({ runId, headSha: 'H' });
        const actions = await getOverseerActionsForRun(runId);
        const live = actions.filter(
          action =>
            action.action === 'flag_merge_ready' &&
            action.result === `steward_handoff:replay_green:verdict:${verdictId}`
        );
        expect(first.judge).toBe(0);
        expect(first.coordinator).toBe(0);
        expect(first.handoff).toBe(1);
        expect(second.handoff).toBe(0);
        expect(second.judge).toBe(0);
        expect(second.coordinator).toBe(0);
        expect(row?.proposedAction).toBe('flag_merge_ready');
        expect(live).toHaveLength(1);
        expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(false);
      }
    });

    test('replay green Test 7: unsafe rows are not promoted by the real adapter', async () => {
      const blocked: { id: string; verdict: string; action: string | null; actioned?: boolean }[] =
        [
          {
            id: 'run-block-escalate-observe',
            verdict: 'observe',
            action: 'escalate_with_evidence',
          },
          {
            id: 'run-block-escalate-healthy',
            verdict: 'healthy',
            action: 'escalate_with_evidence',
          },
          { id: 'run-block-null-observe', verdict: 'observe', action: null },
          { id: 'run-block-null-healthy', verdict: 'healthy', action: null },
          { id: 'run-block-unknown-observe', verdict: 'observe', action: 'not_a_real_action' },
          { id: 'run-block-unknown-healthy', verdict: 'healthy', action: 'not_a_real_action' },
          { id: 'run-block-ready-observe', verdict: 'observe', action: 'flag_merge_ready' },
          { id: 'run-block-ready-healthy', verdict: 'healthy', action: 'flag_merge_ready' },
          {
            id: 'run-block-actioned-observe',
            verdict: 'observe',
            action: 'comment_findings',
            actioned: true,
          },
          {
            id: 'run-block-actioned-healthy',
            verdict: 'healthy',
            action: 'none',
            actioned: true,
          },
        ];
      for (const blockedRow of blocked) {
        await seedCompletedRun(blockedRow.id);
        const verdictId = await seedVerdict({
          runId: blockedRow.id,
          verdict: blockedRow.verdict,
          proposedAction: blockedRow.action,
        });
        if (blockedRow.actioned) {
          await getDatabase().query(`UPDATE overseer_verdicts SET actioned_at = $2 WHERE id = $1`, [
            verdictId,
            '2026-10-29T00:00:00.000Z',
          ]);
        }
        const tick = await runRealReplay({ runId: blockedRow.id, evidence: prEvidence(0) });
        const promoted = await promoteObserveOrHealthyVerdict(verdictId);
        const row = await getVerdictByRunHead({ runId: blockedRow.id, headSha: 'H' });
        const actions = await getOverseerActionsForRun(blockedRow.id);
        expect(tick.handoff).toBe(0);
        expect(tick.coordinator).toBe(0);
        expect(tick.judge).toBe(0);
        expect(promoted).toBe(false);
        expect(row?.proposedAction).toBe(blockedRow.action);
        expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
      }
    });

    test('replay green Test 7: raced escalation is refused by the conditional update', async () => {
      const runId = 'run-race-escalate';
      await seedCompletedRun(runId);
      const verdictId = await seedVerdict({
        runId,
        verdict: 'observe',
        proposedAction: 'comment_findings',
      });
      const tick = await runRealReplay({
        runId,
        evidence: prEvidence(0),
        store: realVerdictStore({
          getVerdictByRunHead: async input => {
            const row = await getVerdictByRunHead(input);
            if (row) {
              await getDatabase().query(
                `UPDATE overseer_verdicts SET proposed_action = 'escalate_with_evidence' WHERE id = $1`,
                [row.id]
              );
            }
            return row;
          },
        }),
      });
      const row = await getVerdictByRunHead({ runId, headSha: 'H' });
      const actions = await getOverseerActionsForRun(runId);
      expect(tick.handoff).toBe(0);
      expect(tick.coordinator).toBe(0);
      expect(tick.judge).toBe(0);
      expect(await promoteObserveOrHealthyVerdict(verdictId)).toBe(false);
      expect(row?.proposedAction).toBe('escalate_with_evidence');
      expect(actions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
    });

    test('replay green Test 7: concurrent green ticks promote and hand off once', async () => {
      const runId = 'run-concurrent-green';
      await seedCompletedRun(runId);
      const verdictId = await seedVerdict({
        runId,
        verdict: 'healthy',
        proposedAction: 'verdict_write',
      });
      const tally = { handoff: 0, coordinator: 0, judge: 0 };
      await Promise.all([
        runRealReplay({ runId, evidence: prEvidence(0), tally }),
        runRealReplay({ runId, evidence: prEvidence(0), tally }),
      ]);
      const row = await getVerdictByRunHead({ runId, headSha: 'H' });
      const actions = await getOverseerActionsForRun(runId);
      const live = actions.filter(
        action =>
          action.action === 'flag_merge_ready' &&
          action.result === `steward_handoff:replay_green:verdict:${verdictId}`
      );
      expect(tally.handoff).toBe(1);
      expect(tally.coordinator).toBe(0);
      expect(tally.judge).toBe(0);
      expect(row?.proposedAction).toBe('flag_merge_ready');
      expect(live).toHaveLength(1);
    });

    test('replay green: receipt insert failure rolls the promotion back', async () => {
      const runId = 'run-receipt-fail';
      await seedCompletedRun(runId);
      const verdictId = await seedVerdict({
        runId,
        verdict: 'observe',
        proposedAction: 'comment_findings',
      });
      // The revert trigger fails any compensating UPDATE that tries to leave
      // flag_merge_ready after it has committed. Only a transaction that rolls
      // the promotion back with the failed receipt keeps the prior action.
      await installReceiptFailureGuards();
      let failed: { handoff: number; coordinator: number; judge: number };
      try {
        failed = await runRealReplay({
          runId,
          evidence: prEvidence(0),
        });
      } finally {
        await dropReceiptFailureGuards();
      }
      const unchanged = await getVerdictByRunHead({ runId, headSha: 'H' });
      const failedActions = await getOverseerActionsForRun(runId);
      expect(failed.handoff).toBe(0);
      expect(failed.coordinator).toBe(0);
      expect(failed.judge).toBe(0);
      expect(unchanged?.proposedAction).toBe('comment_findings');
      expect(failedActions.filter(action => action.action === 'flag_merge_ready')).toHaveLength(0);
      expect((await listUnactionedFlagMergeReadyVerdicts()).some(row => row.id === verdictId)).toBe(
        false
      );

      const retried = await runRealReplay({ runId, evidence: prEvidence(0) });
      const promoted = await getVerdictByRunHead({ runId, headSha: 'H' });
      const retriedActions = await getOverseerActionsForRun(runId);
      expect(retried.handoff).toBe(1);
      expect(retried.coordinator).toBe(0);
      expect(promoted?.proposedAction).toBe('flag_merge_ready');
      expect(
        retriedActions.filter(
          action =>
            action.action === 'flag_merge_ready' &&
            action.result === `steward_handoff:replay_green:verdict:${verdictId}`
        )
      ).toHaveLength(1);
      expect((await listUnactionedFlagMergeReadyVerdicts()).some(row => row.id === verdictId)).toBe(
        true
      );
    });

    test('replay green Test 8: watch selector keeps a commented observe until green, then drops it', async () => {
      const runId = 'run-watch-observe';
      await seedCompletedRun(runId);
      const initial = await runRealReplay({
        runId,
        evidence: prEvidence(1),
        judge: async () =>
          verdictOutcome({
            verdict: 'observe',
            proposedAction: 'comment_findings',
            reason: 'checks still pending',
          }),
      });
      expect(initial.judge).toBe(1);
      expect(initial.handoff).toBe(0);
      expect(initial.coordinator).toBe(0);
      const seeded = await getVerdictByRunHead({ runId, headSha: 'H' });
      const verdictId = seeded?.id;
      expect(verdictId).toBeTruthy();
      expect(seeded?.verdict).toBe('observe');
      expect(seeded?.proposedAction).toBe('comment_findings');
      const initialActions = await getOverseerActionsForRun(runId);
      expect(initialActions.map(action => action.action).sort()).toEqual([
        'comment_findings',
        'verdict_write',
      ]);
      expect((await listRunsForOverseerWatch()).map(run => run.id)).toContain(runId);

      const pending = await runRealReplay({ runId, evidence: prEvidence(1) });
      expect(pending.handoff).toBe(0);
      expect(pending.judge).toBe(0);
      expect((await listRunsForOverseerWatch()).map(run => run.id)).toContain(runId);
      expect((await getVerdictByRunHead({ runId, headSha: 'H' }))?.proposedAction).toBe(
        'comment_findings'
      );

      const green = await runRealReplay({ runId, evidence: prEvidence(0) });
      expect(green.handoff).toBe(1);
      expect(green.coordinator).toBe(0);
      expect(green.judge).toBe(0);
      expect((await getVerdictByRunHead({ runId, headSha: 'H' }))?.proposedAction).toBe(
        'flag_merge_ready'
      );
      expect((await listRunsForOverseerWatch()).map(run => run.id)).not.toContain(runId);

      const repeat = await runRealReplay({ runId, evidence: prEvidence(0) });
      expect(repeat.handoff).toBe(0);
      expect(repeat.judge).toBe(0);
      const actions = await getOverseerActionsForRun(runId);
      expect(
        actions.filter(
          action => action.result === `steward_handoff:replay_green:verdict:${verdictId}`
        )
      ).toHaveLength(1);
    });

    test('replay green Test 8: excluded rows do not hand off', async () => {
      const excluded = [
        ['run-ex-human', 'needs_human', 'escalate_with_evidence', 'comment_findings'],
        ['run-ex-genuine', 'failed_genuine', 'escalate_with_evidence', 'comment_findings'],
        ['run-ex-dup', 'duplicate_work', 'comment_findings', 'comment_findings'],
        ['run-ex-escalation', 'observe', 'comment_findings', 'escalate_with_evidence'],
        ['run-ex-closed-watch', 'observe', 'none', 'watch_closed'],
        ['run-ex-merged', 'healthy', 'verdict_write', 'merged'],
        ['run-ex-tier', 'observe', 'none', 'tier_refused'],
        ['run-ex-denied', 'healthy', 'comment_findings', 'escalation_denied'],
      ] as const;
      for (const [runId, verdict, proposedAction, terminalAction] of excluded) {
        await seedCompletedRun(runId);
        await seedVerdict({ runId, verdict, proposedAction });
        await insertOverseerAction({
          runId,
          woId: 'WO-REPLAY-GREEN-01',
          class: 'none',
          action: terminalAction,
          result: 'terminal',
        });
        expect((await listRunsForOverseerWatch()).map(run => run.id)).not.toContain(runId);
        if (verdict !== 'observe' && verdict !== 'healthy') {
          const tick = await runRealReplay({ runId, evidence: prEvidence(0) });
          expect(tick.handoff).toBe(0);
          expect(tick.coordinator).toBe(0);
          expect(tick.judge).toBe(0);
        }
      }

      const closedId = 'run-ex-closed-pr';
      await seedCompletedRun(closedId);
      await seedVerdict({ runId: closedId, verdict: 'observe', proposedAction: 'none' });
      const closed = await runRealReplay({
        runId: closedId,
        action: 'ignore',
        evidence: { ...prEvidence(0), state: 'closed' },
      });
      expect(closed.handoff).toBe(0);
      const closedActions = await getOverseerActionsForRun(closedId);
      expect(closedActions.some(action => action.action === 'flag_merge_ready')).toBe(false);
      expect(closedActions.some(action => action.action === 'watch_closed')).toBe(true);

      const discoveryId = 'pr-discovery:thinmansoftware/bdc-harness#1373';
      await claimOverseerVerdict({
        runId: discoveryId,
        woId: 'WO-REPLAY-GREEN-01',
        headSha: 'H',
      });
      expect(
        (await listRunsForOverseerWatch()).some(run => run.id.startsWith('pr-discovery:'))
      ).toBe(false);
    });
  });
}

if (!soleJudgeFirstFile) {
  test('replay green real adapter executes in an isolated process', () => {
    const child = Bun.spawnSync(['bun', 'test', import.meta.path, '--timeout', '30000'], {
      cwd: process.cwd(),
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
    expect(child.exitCode, output).toBe(0);
  });
}

describe('evidence envelope: bounded by construction', () => {
  test('caps the event tail at 20 and truncates long messages', () => {
    const events = Array.from({ length: 50 }, (_, i) => makeEvent(`e${i}`, 'x'.repeat(2000)));
    const envelope = buildEvidenceEnvelope(makeRecord(), events);
    expect(envelope.eventTail).toHaveLength(20);
    expect(envelope.eventTail[0]!.message.length).toBeLessThanOrEqual(403);
    expect(envelope.hint.action).toBe('ignore');
  });

  test('event tail reads node_output instead of serialized JSON', () => {
    const envelope = buildEvidenceEnvelope(makeRecord(), [
      {
        id: 'evt-node-output',
        workflow_run_id: 'run-1',
        event_type: 'node_completed',
        step_name: 'commit-and-push',
        data: { node_output: 'EVIDENCE_ERROR: Tests: 969/980' },
        created_at: '2026-09-25T00:00:00Z',
      },
    ]);
    expect(envelope.eventTail[0]?.message).toBe('EVIDENCE_ERROR: Tests: 969/980');
  });

  test('carries selected PR identity and other open PRs for the WO', () => {
    const envelope = buildEvidenceEnvelope(
      makeRecord({
        prEvidence: {
          exists: true,
          state: 'open',
          checks: { total: 1, passed: 1, failed: 0, pending: 0 },
          mergeable: true,
          htmlUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/968',
          pr: {
            owner: 'thinmansoftware',
            repo: 'bdc-harness',
            number: 968,
            headRef: 'feat/wo-x-01-thread-abc',
            author: 'builder',
            createdAt: '2026-09-25T01:00:00Z',
          },
          otherOpenPrsForWo: [
            {
              number: 967,
              headRef: 'archon/task-web-worker-1',
              createdAt: '2026-09-25T00:30:00Z',
            },
          ],
        },
      }),
      []
    );
    expect(envelope.pr.number).toBe(968);
    expect(envelope.pr.headRef).toBe('feat/wo-x-01-thread-abc');
    expect(envelope.pr.author).toBe('builder');
    expect(envelope.pr.createdAt).toBe('2026-09-25T01:00:00Z');
    expect(envelope.otherOpenPrsForWo).toEqual([
      {
        number: 967,
        headRef: 'archon/task-web-worker-1',
        createdAt: '2026-09-25T00:30:00Z',
      },
    ]);
    expect(envelope.otherOpenPrsForWoLookupFailed).toBe(false);
    const prompt = buildJudgePrompt(envelope);
    expect(prompt).toContain('archon/task-');
    expect(prompt).toContain('runWindow');
    expect(prompt).toContain('never duplicate_work');
    expect(prompt).toContain('never needs_human');
    expect(envelope.runWindow).toEqual({ startedAt: null, endedAt: null });
  });

  test('bounds the run window to the earliest and latest event timestamps', () => {
    const envelope = buildEvidenceEnvelope(makeRecord(), [
      makeEvent('e1', 'first'),
      makeEvent('e9', 'last'),
      {
        id: 'e-blank',
        workflow_run_id: 'run-1',
        event_type: 'node_completed',
        step_name: 'commit-and-push',
        data: {},
      },
    ]);
    expect(envelope.runWindow).toEqual({
      startedAt: '2026-07-28T00:00:01Z',
      endedAt: '2026-07-28T00:00:09Z',
    });
  });

  test('defaults missing PR identity to null and an empty other-PR list', () => {
    const envelope = buildEvidenceEnvelope(makeRecord(), []);
    expect(envelope.pr.number).toBeNull();
    expect(envelope.pr.headRef).toBeNull();
    expect(envelope.pr.author).toBeNull();
    expect(envelope.pr.createdAt).toBeNull();
    expect(envelope.otherOpenPrsForWo).toEqual([]);
    expect(envelope.otherOpenPrsForWoLookupFailed).toBe(false);
  });

  test('truncates otherOpenPrsForWo to five entries', () => {
    const otherOpenPrsForWo = Array.from({ length: 6 }, (_, index) => ({
      number: 100 + index,
      headRef: `feat/extra-${index}`,
      createdAt: `2026-09-25T00:0${index}:00Z`,
    }));
    const envelope = buildEvidenceEnvelope(
      makeRecord({
        prEvidence: {
          exists: true,
          state: 'open',
          checks: { total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable: null,
          pr: { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1 },
          otherOpenPrsForWo,
        },
      }),
      []
    );
    expect(envelope.otherOpenPrsForWoLookupFailed).toBe(false);
    expect(envelope.otherOpenPrsForWo).toHaveLength(5);
    expect(envelope.otherOpenPrsForWo?.[0]?.number).toBe(100);
    expect(envelope.otherOpenPrsForWo?.[4]?.number).toBe(104);
  });

  test('marks a failed sibling lookup as unavailable and drops stale siblings', () => {
    const envelope = buildEvidenceEnvelope(
      makeRecord({
        prEvidence: {
          exists: true,
          state: 'open',
          checks: { total: 1, passed: 1, failed: 0, pending: 0 },
          mergeable: true,
          pr: {
            owner: 'thinmansoftware',
            repo: 'bdc-harness',
            number: 968,
            headRef: 'feat/wo-x-01-thread-abc',
            author: 'builder',
            createdAt: '2026-09-25T01:00:00Z',
          },
          otherOpenPrsForWoLookupFailed: true,
          otherOpenPrsForWo: [
            {
              number: 967,
              headRef: 'archon/task-web-worker-1',
              createdAt: '2026-09-25T00:30:00Z',
            },
          ],
        },
      }),
      []
    );
    expect(envelope.otherOpenPrsForWo).toBeNull();
    expect(envelope.otherOpenPrsForWoLookupFailed).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain('archon/task-web-worker-1');
    const prompt = buildJudgePrompt(envelope);
    expect(prompt).toContain('otherOpenPrsForWoLookupFailed: true');
    expect(prompt).toContain('otherOpenPrsForWo: null');
    expect(prompt).toContain('sibling list is unavailable');
    expect(prompt).toContain('not evidence that no');
    expect(prompt).toContain('proof of exclusivity');
  });

  test('builds the same envelope and digest twice', () => {
    const record = makeRecord({
      prEvidence: {
        exists: true,
        state: 'open',
        checks: { total: 1, passed: 1, failed: 0, pending: 0 },
        mergeable: true,
        pr: {
          owner: 'thinmansoftware',
          repo: 'bdc-harness',
          number: 968,
          headRef: 'feat/wo-x-01-thread-abc',
          author: 'builder',
          createdAt: '2026-09-25T01:00:00Z',
        },
        otherOpenPrsForWo: [
          {
            number: 967,
            headRef: 'archon/task-web-worker-1',
            createdAt: '2026-09-25T00:30:00Z',
          },
        ],
      },
    });
    const first = buildEvidenceEnvelope(record, []);
    const second = buildEvidenceEnvelope(record, []);
    expect(second).toEqual(first);
    expect(envelopeDigest(second)).toBe(envelopeDigest(first));
  });
});

// Codex fallback rung (John 2026-08-26: "Give it to codex" -- xAI credits dry).
import { describe as dCx, test as tCx, expect as eCx, mock as mCx } from 'bun:test';
import { judgeTerminalRun as judgeCx } from '../judge-first.js';

dCx('codex judge rung invocation', () => {
  tCx('codex rung judges when grok is unavailable', async () => {
    const spawns: string[][] = [];
    const recorded: string[] = [];
    const outcome = await judgeCx(
      {
        runId: 'run-cx',
        woId: 'WO-CX-01',
        status: 'completed',
        reason: 'r',
        events: [],
      } as never,
      {
        ladder: ['grok', 'codex'],
        spawn: async (binary: string, _prompt: string) => {
          spawns.push([binary]);
          if (binary === 'grok') return { exitCode: 1, stdout: '', timedOut: false };
          return {
            exitCode: 0,
            stdout:
              'chatter\n{"verdict":"observe","confidence":0.8,"proposed_action":"none","reason":"ok"}',
            timedOut: false,
          };
        },
        recordOutcome: async binary => {
          recorded.push(binary);
          return {} as never;
        },
      }
    );
    eCx(spawns.map(s => s[0])).toEqual(['grok', 'codex']);
    eCx(recorded).toEqual(['grok', 'codex']);
    eCx(outcome.kind).toBe('verdict');
  });
});
