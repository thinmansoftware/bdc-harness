import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CODEX_LANE = join(REPO_ROOT, '.archon/workflows/defaults/bdc-feature-development-codex.yaml');

function extractRtaCore(yaml: string): string {
  const begin = '# ---- BEGIN rta core';
  const end = '# ---- END rta core ----';
  const marker = yaml.indexOf(begin);
  const finish = yaml.indexOf(end, marker);
  if (marker < 0 || finish < 0) throw new Error('rta core markers missing');
  const lineStart = yaml.lastIndexOf('\n', marker) + 1;
  const endLine = yaml.indexOf('\n', finish);
  const block = yaml.slice(lineStart, endLine === -1 ? yaml.length : endLine);
  return block
    .split('\n')
    .map(line => (line.startsWith('      ') ? line.slice(6) : line))
    .join('\n');
}

const RTA_CORE = extractRtaCore(readFileSync(CODEX_LANE, 'utf8'));

function bash(
  script: string,
  env: Record<string, string>
): { exitCode: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rta-'));
  const scriptPath = join(dir, 'rta.sh');
  try {
    writeFileSync(scriptPath, script);
    const result = Bun.spawnSync(['bash', scriptPath], {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runRta(raw: string, pr = '826'): { exitCode: number; stdout: string; stderr: string } {
  const script = `set -euo pipefail\n${RTA_CORE}\nrta_plan_authorizes "$PLAN_REVIEW_RAW" "$PR_NUMBER"\n`;
  return bash(script, { PLAN_REVIEW_RAW: raw, PR_NUMBER: pr });
}

function wrap(body: string): string {
  return [
    'Reviewer critique before the fence.',
    '=== APPROVED_PLAN_BEGIN ===',
    body,
    '=== APPROVED_PLAN_END ===',
    'Reviewer critique after the fence.',
  ].join('\n');
}

function expectRefuse(raw: string, reason: string): void {
  const result = runRta(raw);
  if (result.exitCode !== 1) {
    throw new Error(`expected exit 1, got ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  }
  expect(result.stdout).toContain(`repair_target_plan_authorization_refused: ${reason}`);
}

describe('repair-target plan authorization', () => {
  it('Test 11: standalone field is accepted', () => {
    for (const line of [
      'repair_target_authorized_by_spec: #826',
      '  repair_target_authorized_by_spec: #826',
    ]) {
      const result = runRta(wrap(['Commit message: fix: x', line].join('\n')));
      if (result.exitCode !== 0) {
        throw new Error(`${line}\n${result.stdout}\n${result.stderr}`);
      }
      expect(result.stdout).toContain('repair_target_plan_authorization: ok #826');
    }
  });

  it('Test 12: negated prose is refused', () => {
    for (const line of [
      'Do not emit repair_target_authorized_by_spec: #826',
      'Never repair_target_authorized_by_spec: #826 here',
    ]) {
      expectRefuse(wrap(line), 'no_standalone_field');
    }
  });

  it('Test 13: quoted and decorated mentions are refused', () => {
    for (const line of [
      '`repair_target_authorized_by_spec: #826`',
      '- repair_target_authorized_by_spec: #826',
      '> repair_target_authorized_by_spec: #826',
      '**repair_target_authorized_by_spec: #826**',
      '"repair_target_authorized_by_spec: #826"',
    ]) {
      expectRefuse(wrap(line), 'no_standalone_field');
    }
  });

  it('Test 14: a field inside a code block in the plan is refused', () => {
    const body = ['```', 'repair_target_authorized_by_spec: #826', '```'].join('\n');
    expectRefuse(wrap(body), 'no_standalone_field');
  });

  it('Test 15: the field outside the fence is refused', () => {
    const before = [
      'repair_target_authorized_by_spec: #826',
      '=== APPROVED_PLAN_BEGIN ===',
      'Commit message: fix: x',
      '=== APPROVED_PLAN_END ===',
      'Reviewer critique after the fence.',
    ].join('\n');
    const after = [
      'Reviewer critique before the fence.',
      '=== APPROVED_PLAN_BEGIN ===',
      'Commit message: fix: x',
      '=== APPROVED_PLAN_END ===',
      'repair_target_authorized_by_spec: #826',
    ].join('\n');
    expectRefuse(before, 'no_standalone_field');
    expectRefuse(after, 'no_standalone_field');
  });

  it('Test 16: more than one approved-plan fence is refused', () => {
    const fieldSecond = [
      'Reviewer critique before the fence.',
      '=== APPROVED_PLAN_BEGIN ===',
      'Commit message: fix: x',
      '=== APPROVED_PLAN_END ===',
      '=== APPROVED_PLAN_BEGIN ===',
      'repair_target_authorized_by_spec: #826',
      '=== APPROVED_PLAN_END ===',
      'Reviewer critique after the fence.',
    ].join('\n');
    const fieldFirst = [
      'Reviewer critique before the fence.',
      '=== APPROVED_PLAN_BEGIN ===',
      'repair_target_authorized_by_spec: #826',
      '=== APPROVED_PLAN_END ===',
      '=== APPROVED_PLAN_BEGIN ===',
      'Commit message: fix: x',
      '=== APPROVED_PLAN_END ===',
      'Reviewer critique after the fence.',
    ].join('\n');
    expectRefuse(fieldSecond, 'fence_count');
    expectRefuse(fieldFirst, 'fence_count');
  });

  it('Test 17: multiple authorization fields are refused', () => {
    expectRefuse(
      wrap(
        ['repair_target_authorized_by_spec: #826', 'repair_target_authorized_by_spec: #827'].join(
          '\n'
        )
      ),
      'multiple_fields'
    );
    expectRefuse(
      wrap(
        ['repair_target_authorized_by_spec: #826', 'repair_target_authorized_by_spec: #826'].join(
          '\n'
        )
      ),
      'multiple_fields'
    );
  });

  it('Test 18: CRLF does not break or bypass the parse', () => {
    const positive = wrap(
      ['Commit message: fix: x', 'repair_target_authorized_by_spec: #826'].join('\n')
    ).replace(/\n/g, '\r\n');
    const negated = wrap('Do not emit repair_target_authorized_by_spec: #826').replace(
      /\n/g,
      '\r\n'
    );
    const ok = runRta(positive);
    if (ok.exitCode !== 0) throw new Error(`${ok.stdout}\n${ok.stderr}`);
    expect(ok.stdout).toContain('repair_target_plan_authorization: ok #826');
    expectRefuse(negated, 'no_standalone_field');
  });

  it('Test 19: number boundaries and trailing text are refused', () => {
    expectRefuse(wrap('repair_target_authorized_by_spec: #8260'), 'pr_mismatch');
    for (const line of [
      'repair_target_authorized_by_spec: #826.',
      'repair_target_authorized_by_spec: #826 (pending)',
      'repair_target_authorized_by_spec: 826',
      'Repair_Target_Authorized_By_Spec: #826',
    ]) {
      expectRefuse(wrap(line), 'no_standalone_field');
    }
  });
});
