import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { substituteNodeOutputRefs } from '../dag-executor';
import type { NodeOutput } from '../schemas/workflow-run';

/**
 * Test 16 (WO-HARNESS-OVERSEER-REWORK-LOOP-01, Section 9): extracts the
 * gate-already-satisfied bash node from the real lane YAML and executes it
 * with the DAG executor's OWN substituteNodeOutputRefs(escapedForBash=true),
 * exactly as tickWorkflow substitutes it in production (dag-executor.ts:3172).
 *
 * A raw find/replace substitution here would be unfaithful: shellQuote wraps
 * multi-line node output in single quotes (dag-executor.ts:1270), which is
 * why the gate's own leading comment calls out that the PREVIOUS heredoc
 * pattern silently broke -- a naive substitution can look correct while
 * hiding the exact class of bug this gate was written to survive.
 */

type WorkflowNode = { id?: string; bash?: string };

function loadGateScript(): string {
  const workflowPath = resolve(
    import.meta.dir,
    '../../../../.archon/workflows/defaults/bdc-feature-development-codex.yaml'
  );
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as {
    nodes?: WorkflowNode[];
  };
  const script = workflow.nodes?.find(node => node.id === 'gate-already-satisfied')?.bash;
  if (!script) throw new Error('gate-already-satisfied bash node not found in lane YAML');
  return script;
}

function nodeOutputs(entries: Record<string, string>): Map<string, NodeOutput> {
  const map = new Map<string, NodeOutput>();
  for (const [id, output] of Object.entries(entries)) {
    map.set(id, { state: 'completed', output });
  }
  return map;
}

function runGate(script: string): { exitCode: number; stdout: string; stderr: string } {
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
  const result = Bun.spawnSync([bash, '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe('bdc-feature-development-codex gate-already-satisfied (Stop 5, Test 16)', () => {
  it('forces needs-build when read-spec carries the REWORK_DIRECTIVE line, overriding an already-satisfied verdict', () => {
    const rawScript = loadGateScript();
    const substituted = substituteNodeOutputRefs(
      rawScript,
      nodeOutputs({
        'check-already-satisfied': [
          'ALREADY_SATISFIED=true',
          'SATISFIED_EVIDENCE=WO-HARNESS-OVERSEER-REWORK-LOOP-01 files present',
        ].join('\n'),
        'read-spec': [
          '# WO-HARNESS-OVERSEER-REWORK-LOOP-01',
          '',
          '## Rework directive (engine-appended, do not edit)',
          'REWORK_DIRECTIVE: overseer-changes-requested',
          'Repair target: PR #936 (branch feat/wo-harness-overseer-rework-loop-01-thread-abc123)',
          'Rework head: ' + 'c'.repeat(40),
          'Review message: review-msg-1',
          'The Overseer rejected this exact head. Every finding below is an unmet requirement of this WO. Fix each one on this branch; do not open a new PR.',
          '### Overseer findings',
          '[major] pr-rework.ts: missing test coverage for the rework gate.',
        ].join('\n'),
      }),
      true
    );

    const result = runGate(substituted);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('rework directive present -- forcing needs-build');
    const parsed = JSON.parse(result.stdout) as {
      ALREADY_SATISFIED: boolean;
      PRECHECK_VERDICT: string;
    };
    expect(parsed.ALREADY_SATISFIED).toBe(false);
    expect(parsed.PRECHECK_VERDICT).toBe('needs-build');
  });

  it('preserves the already-satisfied verdict when no REWORK_DIRECTIVE line is present', () => {
    const rawScript = loadGateScript();
    const substituted = substituteNodeOutputRefs(
      rawScript,
      nodeOutputs({
        'check-already-satisfied': [
          'ALREADY_SATISFIED=true',
          'SATISFIED_EVIDENCE=WO-HARNESS-OVERSEER-REWORK-LOOP-01 files present',
        ].join('\n'),
        'read-spec': ['# WO-HARNESS-OVERSEER-REWORK-LOOP-01', '', 'Ordinary spec body.'].join('\n'),
      }),
      true
    );

    const result = runGate(substituted);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('rework directive present');
    const parsed = JSON.parse(result.stdout) as {
      ALREADY_SATISFIED: boolean;
      PRECHECK_VERDICT: string;
    };
    expect(parsed.ALREADY_SATISFIED).toBe(true);
    expect(parsed.PRECHECK_VERDICT).toBe('already-satisfied');
  });

  it('still returns needs-build when check-already-satisfied found nothing and no directive is present', () => {
    const rawScript = loadGateScript();
    const substituted = substituteNodeOutputRefs(
      rawScript,
      nodeOutputs({
        'check-already-satisfied': 'ALREADY_SATISFIED=false',
        'read-spec': ['# WO-HARNESS-OVERSEER-REWORK-LOOP-01', '', 'Ordinary spec body.'].join('\n'),
      }),
      true
    );

    const result = runGate(substituted);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ALREADY_SATISFIED: boolean;
      PRECHECK_VERDICT: string;
    };
    expect(parsed.ALREADY_SATISFIED).toBe(false);
    expect(parsed.PRECHECK_VERDICT).toBe('needs-build');
  });

  it('a REWORK_DIRECTIVE line only matches the exact expected text, not a look-alike prose mention', () => {
    const rawScript = loadGateScript();
    const substituted = substituteNodeOutputRefs(
      rawScript,
      nodeOutputs({
        'check-already-satisfied': 'ALREADY_SATISFIED=true\nSATISFIED_EVIDENCE=present',
        'read-spec': [
          '# WO-HARNESS-OVERSEER-REWORK-LOOP-01',
          '',
          'This WO discusses the REWORK_DIRECTIVE mechanism in prose but does not carry the line itself.',
        ].join('\n'),
      }),
      true
    );

    const result = runGate(substituted);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('rework directive present');
    const parsed = JSON.parse(result.stdout) as { PRECHECK_VERDICT: string };
    expect(parsed.PRECHECK_VERDICT).toBe('already-satisfied');
  });
});
