import { describe, expect, test } from 'bun:test';
import { classifyError, classifyEvidenceFailure } from '../classify';
import { planRecovery } from '../watch';

describe('automatic recovery classification', () => {
  test('classifies bash and loop timeout independently', () => {
    expect(classifyError({ message: "Bash node 'ascii-gate' timed out after 120000ms" })).toBe(
      'bash_node_timeout'
    );
    expect(classifyError({ message: "Loop 'implement' iteration 2 exceeded idle timeout" })).toBe(
      'loop_idle_timeout'
    );
  });
  test('evidence check wins over verify heuristic', () => {
    const message = 'EVIDENCE_ERROR: Tests: prose (tests_status=no_command_declared)';
    expect(classifyError({ message, nodeId: 'verify-tests', exitCode: 1 })).toBe(
      'evidence_check_failed'
    );
    expect(
      classifyError({ message: 'failed', nodeId: 'manifest-evidence-check', exitCode: 1 })
    ).toBe('evidence_check_failed');
  });
  test('reads only run-stop-tests node output', () => {
    const event = (output: string) => [
      {
        id: '1',
        workflow_run_id: 'r',
        event_type: 'node_completed',
        step_name: 'run-stop-tests',
        data: { node_output: output },
      },
    ];
    expect(
      classifyEvidenceFailure(event('TESTS_SOURCE=repo_test_script\nTESTS_STATUS=failed'))
    ).toBe('spec_tests_line_defect');
    expect(classifyEvidenceFailure(event('TESTS_SOURCE=spec_declared\nTESTS_STATUS=failed'))).toBe(
      'real_test_failure'
    );
    expect(classifyEvidenceFailure(event('TESTS_STATUS=no_command_declared'))).toBe(
      'spec_tests_line_defect'
    );
  });
  test('maps recoverable classes deterministically', () => {
    expect(planRecovery('bash_node_timeout').plan).toBe('refire');
    expect(planRecovery('worktree_collision').precondition).toBe('release_terminal_worktree');
    expect(planRecovery('evidence_check_failed', 'spec_tests_line_defect')).toEqual({
      plan: 'operator_card',
      reason: 'spec_tests_line_defect',
    });
    expect(planRecovery('evidence_check_failed', 'real_test_failure').plan).toBe('none');
  });
});
