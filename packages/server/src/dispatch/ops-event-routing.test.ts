import { beforeEach, describe, expect, test } from 'bun:test';
import {
  classifyOpsEvent,
  resetOpsRouteSuppressionForTests,
  routeOpsEvent,
  type OpsEvent,
} from './ops-event-routing';

function ev(partial: Partial<OpsEvent> & { body: string }): OpsEvent {
  return {
    sender: 'taskmaster',
    task_type: 'agent_message',
    priority: 'normal',
    subject_key: null,
    ...partial,
  };
}

describe('ops-event-routing', () => {
  beforeEach(() => resetOpsRouteSuppressionForTests());

  test('routine_events_land_in_digest_only', () => {
    const fixtures: OpsEvent[] = [
      ev({ sender: 'overseer', task_type: 'run_report', body: 'run finished: PASS for example' }),
      ev({
        sender: 'overseer',
        task_type: 'run_report',
        body: 'run failed; retry scheduled in 5m',
      }),
      ev({ sender: 'overseer', body: 'PR opened: https://github.com/x/y/pull/1' }),
      ev({ sender: 'overseer', body: 'checks green on head abc123' }),
      ev({ sender: 'cauldron', body: 'rate-limit window reset for codex' }),
      ev({ sender: 'cauldron', body: 'session archived cleanly' }),
    ];
    for (const fixture of fixtures) {
      const verdict = routeOpsEvent(fixture);
      expect(verdict.class).toBe('ROUTINE');
      expect(verdict.destination).toBe('digest');
      expect(verdict.default_if_unanswered).toBe('');
    }
  });

  test('needs_person_interrupts_naming_item_and_default', () => {
    const verdict = routeOpsEvent(
      ev({
        sender: 'taskmaster',
        body: 'decision needed: approve deploy for gh:thinmansoftware/bdc-xo#1538',
        subject_key: 'gh:thinmansoftware/bdc-xo#1538',
      })
    );
    expect(verdict.class).toBe('NEEDS_A_PERSON');
    expect(verdict.destination).toBe('interrupt');
    expect(verdict.default_if_unanswered.length).toBeGreaterThan(0);
  });

  test('blocker_interrupts_with_blocker_priority', () => {
    const blockerReport = routeOpsEvent(
      ev({
        sender: 'taskmaster',
        task_type: 'run_report',
        body: 'blocked',
        taskmaster_blocker_report: true,
      })
    );
    expect(blockerReport.class).toBe('BLOCKER');
    expect(blockerReport.destination).toBe('interrupt');

    const security = routeOpsEvent(
      ev({ sender: 'overseer', body: 'rotate the service_role key now' })
    );
    expect(security.class).toBe('BLOCKER');
    expect(security.destination).toBe('interrupt');
  });

  test('each_fixture_lands_in_exactly_one_place', () => {
    const fixtures: OpsEvent[] = [
      ev({ sender: 'overseer', task_type: 'run_report', body: 'run finished: PASS' }),
      ev({ sender: 'overseer', task_type: 'run_report', body: 'run failed; retry scheduled' }),
      ev({ sender: 'overseer', body: 'PR opened' }),
      ev({ sender: 'overseer', body: 'checks green' }),
      ev({ sender: 'cauldron', body: 'rate-limit window reset' }),
      ev({ sender: 'cauldron', body: 'session archived' }),
      ev({
        sender: 'taskmaster',
        body: 'decision needed: approve deploy',
        subject_key: 'gh:thinmansoftware/bdc-xo#1538',
      }),
      ev({
        sender: 'taskmaster',
        task_type: 'run_report',
        body: 'blk',
        taskmaster_blocker_report: true,
        subject_key: 'wo:WO-A-01',
      }),
      ev({ sender: 'overseer', body: 'service_role key exposed', subject_key: 'wo:WO-B-01' }),
    ];
    for (const fixture of fixtures) {
      const verdict = routeOpsEvent(fixture);
      const digest = verdict.destination === 'digest';
      const interrupt = verdict.destination === 'interrupt';
      // Exactly one destination; never both, never neither.
      expect(digest !== interrupt).toBe(true);
      expect(digest || interrupt).toBe(true);
    }
  });

  test('repeat_blocker_same_subject_within_24h_goes_to_digest', () => {
    const store = new Map<string, string>();
    const ctxAt = (iso: string) => ({
      now: new Date(iso),
      lastBlockerAt: (key: string) => store.get(key) ?? null,
      recordBlocker: (key: string, at: string) => void store.set(key, at),
    });
    const fixture = ev({
      sender: 'taskmaster',
      task_type: 'run_report',
      body: 'blocker',
      taskmaster_blocker_report: true,
      subject_key: 'wo:WO-REPEAT-01',
    });

    const first = routeOpsEvent(fixture, ctxAt('2026-10-20T00:00:00.000Z'));
    expect(first.class).toBe('BLOCKER');
    expect(first.destination).toBe('interrupt');

    const second = routeOpsEvent(fixture, ctxAt('2026-10-20T03:00:00.000Z'));
    expect(second.class).toBe('ROUTINE');
    expect(second.destination).toBe('digest');

    const third = routeOpsEvent(fixture, ctxAt('2026-10-21T01:00:00.000Z'));
    expect(third.class).toBe('BLOCKER');
    expect(third.destination).toBe('interrupt');
  });

  test('failed_without_retry_path_is_blocker', () => {
    const exhausted = classifyOpsEvent(
      ev({
        sender: 'overseer',
        task_type: 'run_report',
        body: 'run failed; retries exhausted for WO-EXAMPLE-01',
      })
    );
    expect(exhausted.class).toBe('BLOCKER');

    const tiers = classifyOpsEvent(
      ev({ sender: 'overseer', task_type: 'run_report', body: 'all tiers exhausted' })
    );
    expect(tiers.class).toBe('BLOCKER');

    const scheduled = classifyOpsEvent(
      ev({ sender: 'overseer', task_type: 'run_report', body: 'run failed; retry scheduled' })
    );
    expect(scheduled.class).toBe('ROUTINE');
  });

  test('owner_question_is_blocker', () => {
    const question = classifyOpsEvent(
      ev({ sender: 'codex', task_type: 'agent_message', body: 'Which base branch should I use?' })
    );
    expect(question.class).toBe('BLOCKER');

    const nonQuestion = classifyOpsEvent(
      ev({
        sender: 'overseer',
        task_type: 'agent_message',
        body: 'review complete, verdict posted',
      })
    );
    expect(nonQuestion.class).toBe('ROUTINE');
  });

  test('expectation_exhausted_notice_is_routine_unless_blocker_priority', () => {
    const ordinary = classifyOpsEvent(
      ev({
        sender: 'taskmaster',
        priority: 'normal',
        body: 'expectation EXHAUSTED: owed by operator',
      })
    );
    expect(ordinary.class).toBe('ROUTINE');

    const blocker = classifyOpsEvent(
      ev({
        sender: 'taskmaster',
        priority: 'blocker',
        body: 'expectation EXHAUSTED: owed by operator',
      })
    );
    expect(blocker.class).toBe('BLOCKER');
  });
});
