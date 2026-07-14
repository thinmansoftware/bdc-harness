import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

type WorkflowNode = {
  id?: string;
  bash?: string;
};

function loadAssertSpecResolvedScript(): string {
  const workflowPath = resolve(
    import.meta.dir,
    '../../../.archon/workflows/defaults/bdc-harness-wo-onramp.yaml'
  );
  const workflow = Bun.YAML.parse(readFileSync(workflowPath, 'utf8')) as {
    nodes?: WorkflowNode[];
  };
  const script = workflow.nodes?.find(node => node.id === 'assert-spec-resolved')?.bash;
  if (!script) throw new Error('assert-spec-resolved bash node not found');
  return script.replace('NORM_OUT=$normalize-spec.output', 'NORM_OUT=$(cat "$NORM_FILE")');
}

function runGate(invariant: string): { exitCode: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'onramp-spec-gate-'));
  try {
    const normFile = join(dir, 'normalize-output.txt');
    writeFileSync(
      normFile,
      [`BUSINESS_RISK_INVARIANT=${invariant}`, '=== SPEC_CONTENT ===', 'x'.repeat(240)].join('\n'),
      'utf8'
    );
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    const result = Bun.spawnSync([bash, '-c', loadAssertSpecResolvedScript()], {
      cwd: dir,
      env: { ...process.env, NORM_FILE: normFile },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('on-ramp assert-spec-resolved business invariant gate', () => {
  it('accepts a resolved invariant that uses unknown as a real risk state', () => {
    const result = runGate(
      'The substrate must fail closed when evidence is unknown, stale, conflicting, or replayed.'
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('SPEC_RESOLVED=true');
    expect(result.exitCode).toBe(0);
  });

  it('rejects an invariant whose entire value is an unresolved placeholder', () => {
    const result = runGate('unknown');
    expect(result.stderr).toContain('BUSINESS_RISK_INVARIANT is a placeholder');
    expect(result.exitCode).not.toBe(0);
  });
});
