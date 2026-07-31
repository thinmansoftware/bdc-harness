/**
 * Judge-first decision core tests (WO-HARNESS-OVERSEER-V2-JUDGE-FIRST-01).
 *
 * All dependencies are injected -- no mock.module, no live database, no real
 * subprocess spawns. Covers the WO's Section 7 scenarios at the unit level:
 * mandatory verdict rows, fail-loud judge health, claim/replay idempotency,
 * stricter-of-two tier law, permit-free Tier 0 escalation, and the budget
 * circuit degrading loudly.
 */

import { describe, expect, test } from 'bun:test';
import {
  JudgeBudgetCircuit,
  buildEvidenceEnvelope,
  judgeTerminalRun,
  parseJudgeOutput,
  type JudgeOutcome,
  type JudgeSpawnResult,
} from '../judge-first';
import { handleRecordJudgeFirst } from '../judge-first-pipeline';
import { MAX_TIER, effectiveTier, requiredTierForAction, ruleOnAction } from '../tier-map';
import type {
  OverseerVerdictStoreDeps,
  OverseerWorkflowEvent,
  WatchedRunRecord,
} from '../types.ts';

function makeRecord(overrides: Partial<WatchedRunRecord> = {}): WatchedRunRecord {
  return {
    runId: 'run-1',
    woId: 'WO-TEST-01',
    owner: 'bluedevilcollectibles',
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

interface FakeStoreState {
  claims: { runId: string; headSha?: string }[];
  finalized: Record<string, unknown>[];
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

  test('rejects non-JSON, unknown verdicts, and out-of-range confidence', () => {
    expect(parseJudgeOutput('VERDICT: APPROVE')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"maybe","confidence":0.5}')).toBeNull();
    expect(parseJudgeOutput('{"verdict":"healthy","confidence":1.5}')).toBeNull();
  });
});

describe('judgeTerminalRun: model ladder + fail-loud health', () => {
  const envelope = buildEvidenceEnvelope(makeRecord(), []);

  test('ladder exhaustion by spawn failure is judge_unavailable, never a verdict', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['dead-a', 'dead-b'],
      spawn: async () => ({ exitCode: 1, stdout: '', timedOut: false }),
    });
    expect(outcome.kind).toBe('judge_unavailable');
  });

  test('ladder exhaustion by unparseable output is judge_invalid_output', async () => {
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['chatty'],
      spawn: async () => ({ exitCode: 0, stdout: 'I feel great about this run!', timedOut: false }),
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
    const outcome = await judgeTerminalRun(envelope, { ladder: ['cheap', 'strong'], spawn });
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind === 'verdict') {
      expect(outcome.model).toBe('strong');
      expect(outcome.modelRung).toBe(1);
    }
  });

  test('budget circuit exhaustion degrades loudly to evidence_unavailable (Test 7)', async () => {
    const budget = new JudgeBudgetCircuit(0);
    let spawned = 0;
    const outcome = await judgeTerminalRun(envelope, {
      ladder: ['grok'],
      budget,
      spawn: async () => {
        spawned += 1;
        return { exitCode: 0, stdout: '{}', timedOut: false };
      },
    });
    expect(outcome.kind).toBe('evidence_unavailable');
    if (outcome.kind !== 'verdict') expect(outcome.reason).toContain('budget');
    expect(spawned).toBe(0);
  });

  test('budget circuit rolls over by day', () => {
    let now = new Date('2026-07-28T23:59:00Z');
    const budget = new JudgeBudgetCircuit(1, () => now);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    now = new Date('2026-07-29T00:01:00Z');
    expect(budget.tryConsume()).toBe(true);
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
        pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 42 },
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
        pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 43 },
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
        pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 44 },
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
        pr: { owner: 'bluedevilcollectibles', repo: 'bdc-harness', number: 44 },
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
});

describe('evidence envelope: bounded by construction', () => {
  test('caps the event tail at 20 and truncates long messages', () => {
    const events = Array.from({ length: 50 }, (_, i) => makeEvent(`e${i}`, 'x'.repeat(2000)));
    const envelope = buildEvidenceEnvelope(makeRecord(), events);
    expect(envelope.eventTail).toHaveLength(20);
    expect(envelope.eventTail[0]!.message.length).toBeLessThanOrEqual(403);
    expect(envelope.hint.action).toBe('ignore');
  });
});
