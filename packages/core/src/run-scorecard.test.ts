import { describe, expect, test } from 'bun:test';
import {
  RUN_SCORECARD_VERSION,
  isFeatureDevFamily,
  scoreRunFromEvents,
  type ScorecardEventInput,
} from './run-scorecard';

const FEATURE_LANE = 'bdc-feature-development';
const WO_MSG = 'WO_ID=WO-HARNESS-RUN-OUTCOME-SCORECARD-01 --project bdc-harness';

function ev(
  event_type: string,
  step_name: string | null,
  created_at: string,
  data?: Record<string, unknown>
): ScorecardEventInput {
  return { event_type, step_name, created_at, data: data ?? null };
}

describe('scoreRunFromEvents', () => {
  // Test 1 (WO Section 7): landing success.
  test('landing node_completed => landing_ok=1, honest_success=1, pipeline_axis=success', () => {
    const events = [
      ev('workflow_started', null, '2026-08-01T10:00:00.000Z'),
      ev('node_completed', 'implement', '2026-08-01T10:02:00.000Z'),
      ev('node_completed', 'commit-and-push', '2026-08-01T10:03:00.000Z'),
      ev('node_completed', 'open-pr-if-needed', '2026-08-01T10:04:00.000Z'),
      ev('workflow_completed', null, '2026-08-01T10:05:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
      gh: { prUrl: null, joinComplete: true },
    });
    expect(card.landingOk).toBe(1);
    expect(card.landingSkipped).toBe(0);
    expect(card.honestSuccess).toBe(1);
    expect(card.pipelineAxis).toBe('success');
    expect(card.moduleAxis).toBe('none');
    expect(card.terminalEvent).toBe('workflow_completed');
    expect(card.statusColumn).toBe('completed');
    expect(card.lastFailedStep).toBeNull();
    expect(card.woId).toBe('WO-HARNESS-RUN-OUTCOME-SCORECARD-01');
    expect(card.scoreVersion).toBe(RUN_SCORECARD_VERSION);
    // gh join complete + feature family + terminal present + no tie => not partial.
    expect(card.scorePartial).toBe(0);
    expect(card.ghJoinComplete).toBe(1);
  });

  // Guard: status='completed' alone must NOT count as success without a landing node.
  test('status=completed with no landing node does NOT set landing_ok', () => {
    const events = [
      ev('node_completed', 'implement', '2026-08-01T10:02:00.000Z'),
      ev('workflow_completed', null, '2026-08-01T10:05:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.landingOk).toBe(0);
    expect(card.honestSuccess).toBe(0);
  });

  // Test 2 (WO Section 7): already-satisfied skip.
  test('already-satisfied gate JSON => landing_skipped=1, honest_success=1, pipeline_axis=skip', () => {
    const events = [
      ev('node_completed', 'check-already-satisfied', '2026-08-01T10:01:00.000Z', {
        output: 'ALREADY_SATISFIED=true\nSATISFIED_EVIDENCE=files present',
      }),
      ev('node_completed', 'gate-already-satisfied', '2026-08-01T10:01:30.000Z', {
        output: '{"ALREADY_SATISFIED":true,"PRECHECK_VERDICT":"already-satisfied"}',
      }),
      ev('workflow_completed', null, '2026-08-01T10:02:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.landingOk).toBe(0);
    expect(card.landingSkipped).toBe(1);
    expect(card.honestSuccess).toBe(1);
    expect(card.pipelineAxis).toBe('skip');
    expect(card.moduleAxis).toBe('none');
  });

  test('already-merged-on-base verdict is also a skip', () => {
    const events = [
      ev('node_completed', 'gate-already-satisfied', '2026-08-01T10:01:30.000Z', {
        output: '{"ALREADY_SATISFIED":true,"PRECHECK_VERDICT":"already-merged-on-base"}',
      }),
    ];
    const card = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.landingSkipped).toBe(1);
    expect(card.honestSuccess).toBe(1);
  });

  test('needs-build gate verdict is NOT a skip', () => {
    const events = [
      ev('node_completed', 'gate-already-satisfied', '2026-08-01T10:01:30.000Z', {
        output: '{"ALREADY_SATISFIED":false,"PRECHECK_VERDICT":"needs-build"}',
      }),
      ev('node_failed', 'plan-review', '2026-08-01T10:03:00.000Z'),
      ev('workflow_failed', null, '2026-08-01T10:04:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.landingSkipped).toBe(0);
    expect(card.honestSuccess).toBe(0);
  });

  // Test 3 (WO Section 7): completed-without-landing is a failure; plan-review => spec.
  test('completed-without-landing + node_failed on plan-review => honest_success=0, pipeline_axis=spec', () => {
    const events = [
      ev('node_completed', 'implement', '2026-08-01T10:02:00.000Z'),
      ev('node_failed', 'plan-review', '2026-08-01T10:03:00.000Z'),
      ev('workflow_completed', null, '2026-08-01T10:05:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.landingOk).toBe(0);
    expect(card.landingSkipped).toBe(0);
    expect(card.honestSuccess).toBe(0);
    expect(card.lastFailedStep).toBe('plan-review');
    expect(card.pipelineAxis).toBe('spec');
    expect(card.statusColumn).toBe('completed');
  });

  test('latest node_failed wins by created_at; build failure maps to build', () => {
    const events = [
      ev('node_failed', 'plan-review', '2026-08-01T10:01:00.000Z'),
      ev('node_failed', 'implement', '2026-08-01T10:04:00.000Z'),
      ev('workflow_failed', null, '2026-08-01T10:05:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
    });
    expect(card.lastFailedStep).toBe('implement');
    expect(card.pipelineAxis).toBe('build');
  });

  test('tie in latest node_failed picks lowest step_name and sets score_partial=1', () => {
    const events = [
      ev('node_failed', 'plan-review', '2026-08-01T10:04:00.000Z'),
      ev('node_failed', 'implement', '2026-08-01T10:04:00.000Z'),
      ev('workflow_failed', null, '2026-08-01T10:05:00.000Z'),
    ];
    const card = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events,
      gh: { prUrl: null, joinComplete: true },
    });
    // Lowest step_name alphabetically between 'implement' and 'plan-review'.
    expect(card.lastFailedStep).toBe('implement');
    expect(card.scorePartial).toBe(1);
  });

  test('module_axis: loop_iteration_failed => loop; node_failover => tools', () => {
    const loopCard = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events: [
        ev('loop_iteration_failed', 'implement', '2026-08-01T10:02:00.000Z'),
        ev('node_failed', 'implement', '2026-08-01T10:03:00.000Z'),
        ev('workflow_failed', null, '2026-08-01T10:04:00.000Z'),
      ],
    });
    expect(loopCard.moduleAxis).toBe('loop');

    const toolsCard = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events: [
        ev('node_failover', 'implement', '2026-08-01T10:02:00.000Z'),
        ev('node_failed', 'implement', '2026-08-01T10:03:00.000Z'),
        ev('workflow_failed', null, '2026-08-01T10:04:00.000Z'),
      ],
    });
    expect(toolsCard.moduleAxis).toBe('tools');
  });

  test('score_partial forced when no terminal event, no gh, or non-family lane', () => {
    // No terminal event + no gh => partial.
    const noTerminal = scoreRunFromEvents({
      status: 'running',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events: [ev('node_completed', 'commit-and-push', '2026-08-01T10:03:00.000Z')],
    });
    expect(noTerminal.terminalEvent).toBe('none');
    expect(noTerminal.scorePartial).toBe(1);
    expect(noTerminal.ghJoinComplete).toBe(0);

    // Non-family lane => partial even with gh + terminal.
    const nonFamily = scoreRunFromEvents({
      status: 'completed',
      userMessage: WO_MSG,
      workflowName: 'archon-assist',
      events: [
        ev('node_completed', 'commit-and-push', '2026-08-01T10:03:00.000Z'),
        ev('workflow_completed', null, '2026-08-01T10:05:00.000Z'),
      ],
      gh: { prUrl: null, joinComplete: true },
    });
    expect(nonFamily.scorePartial).toBe(1);
  });

  test('gh hit populates gh_pr_url without flipping landing_ok/honest_success', () => {
    const card = scoreRunFromEvents({
      status: 'failed',
      userMessage: WO_MSG,
      workflowName: FEATURE_LANE,
      events: [
        ev('node_failed', 'implement', '2026-08-01T10:03:00.000Z'),
        ev('workflow_failed', null, '2026-08-01T10:04:00.000Z'),
      ],
      gh: { prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/9', joinComplete: true },
    });
    expect(card.ghPrUrl).toBe('https://github.com/thinmansoftware/bdc-harness/pull/9');
    expect(card.ghJoinComplete).toBe(1);
    expect(card.landingOk).toBe(0);
    expect(card.honestSuccess).toBe(0);
  });

  test('isFeatureDevFamily recognizes feature-dev lanes and rejects others', () => {
    expect(isFeatureDevFamily('bdc-feature-development')).toBe(true);
    expect(isFeatureDevFamily('bdc-feature-development-codex')).toBe(true);
    expect(isFeatureDevFamily('archon-feature-development')).toBe(true);
    expect(isFeatureDevFamily('archon-assist')).toBe(false);
    expect(isFeatureDevFamily('bdc-bug-fix')).toBe(false);
  });
});
