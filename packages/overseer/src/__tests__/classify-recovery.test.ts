import { describe, expect, test } from 'bun:test';
import { classifyError, classifyEvidenceFailure } from '../classify';
import { planRecovery } from '../watch';

describe('automatic recovery classification', () => {
  test('classifies bash and loop timeouts distinctly', () => {
    expect(classifyError({ message: "Bash node 'ascii-gate' timed out after 120000ms" })).toBe(
      'bash_node_timeout'
    );
    expect(classifyError({ message: "Loop 'implement' iteration 2 exceeded idle timeout" })).toBe(
      'loop_idle_timeout'
    );
  });
  test('classifies manifest evidence before verify heuristic', () => {
    expect(
      classifyError({ nodeId: 'manifest-evidence-check', message: 'failed', exitCode: 1 })
    ).toBe('evidence_check_failed');
    expect(
      classifyError({
        nodeId: 'verify-tests',
        message: 'EVIDENCE_ERROR: grep_status=1',
        exitCode: 1,
      })
    ).toBe('evidence_check_failed');
  });
  test('reduces the latest run-stop-tests evidence', () => {
    const event = (output: string) => ({
      id: 'e',
      workflow_run_id: 'r',
      event_type: 'node_completed',
      step_name: 'run-stop-tests',
      data: { node_output: output },
      created_at: '2026-09-25T00:00:00Z',
    });
    expect(
      classifyEvidenceFailure([event('TESTS_SOURCE=repo_test_script\nTESTS_STATUS=failed')])
    ).toBe('spec_tests_line_defect');
    expect(
      classifyEvidenceFailure([event('TESTS_SOURCE=spec_declared\nTESTS_STATUS=failed')])
    ).toBe('real_test_failure');
    expect(classifyEvidenceFailure([event('TESTS_STATUS=no_command_declared')])).toBe(
      'spec_tests_line_defect'
    );
  });
  test('uses the fixed recovery map', () => {
    expect(planRecovery('bash_node_timeout').plan).toBe('refire');
    expect(planRecovery('worktree_collision')).toEqual({
      plan: 'refire',
      reason: 'worktree_collision',
      precondition: 'release_terminal_worktree',
    });
    expect(planRecovery('evidence_check_failed', 'spec_tests_line_defect').plan).toBe(
      'operator_card'
    );
    expect(planRecovery('evidence_check_failed', 'real_test_failure').plan).toBe('none');
  });
});
