import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
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

function runRta(
  raw: string,
  pr = '826',
  core = RTA_CORE
): { exitCode: number; stdout: string; stderr: string } {
  const script = `set -euo pipefail\n${core}\nrta_plan_authorizes "$PLAN_REVIEW_RAW" "$PR_NUMBER"\n`;
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
  it('prose-embedded or decorated markers are not approved-plan boundaries', () => {
    for (const raw of [
      [
        'Example: === APPROVED_PLAN_BEGIN ===',
        'repair_target_authorized_by_spec: #826',
        'Example: === APPROVED_PLAN_END ===',
      ].join('\n'),
      [
        '=== APPROVED_PLAN_BEGIN === example',
        'repair_target_authorized_by_spec: #826',
        '=== APPROVED_PLAN_END === example',
      ].join('\n'),
      [
        '`=== APPROVED_PLAN_BEGIN ===`',
        'repair_target_authorized_by_spec: #826',
        '`=== APPROVED_PLAN_END ===`',
      ].join('\n'),
    ])
      expectRefuse(raw, 'fence_count');
    const actual = runRta(
      'Example: === APPROVED_PLAN_BEGIN ===\n' +
        wrap('repair_target_authorized_by_spec: #826') +
        '\nExample: === APPROVED_PLAN_END ==='
    );
    expect(actual.exitCode).toBe(0);
  });

  const laneDirectory = join(REPO_ROOT, '.archon/workflows/defaults');
  for (const file of readdirSync(laneDirectory).filter(name =>
    /^bdc-feature-development.*\.yaml$/.test(name)
  )) {
    const text = readFileSync(join(laneDirectory, file), 'utf8');
    if (!text.includes('# ---- BEGIN rta core')) continue;
    const core = extractRtaCore(text);
    for (const indent of ['    ', '\t']) {
      it(`${file} refuses Markdown code indentation ${JSON.stringify(indent)}`, () => {
        const result = runRta(
          wrap('\n' + indent + 'repair_target_authorized_by_spec: #826'),
          '826',
          core
        );
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('no_standalone_field');
      });
    }
  }
  it('mixed tabs and deeper indentation cannot authorize a repair', () => {
    for (const indent of [' \t', '   \t', '        ']) {
      expectRefuse(
        wrap('\n' + indent + 'repair_target_authorized_by_spec: #826'),
        'no_standalone_field'
      );
    }
  });

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

  for (const fence of ['~~~', '~~~~', '````', '`````']) {
    it(`refuses authorization inside ${fence} fences and enclosing code blocks`, () => {
      expectRefuse(
        wrap([fence, 'repair_target_authorized_by_spec: #826', fence].join('\n')),
        'no_standalone_field'
      );
      expectRefuse(
        [fence, wrap('repair_target_authorized_by_spec: #826'), fence].join('\n'),
        'no_standalone_field'
      );
    });
  }

  it('shorter or mismatched fences cannot close an existing code block', () => {
    expectRefuse(
      wrap(['````', '```', 'repair_target_authorized_by_spec: #826', '````'].join('\n')),
      'no_standalone_field'
    );
    expectRefuse(
      wrap(['~~~', '```', 'repair_target_authorized_by_spec: #826', '~~~'].join('\n')),
      'no_standalone_field'
    );
  });

  it('a plan boundary inside code cannot authorize a later field', () => {
    expectRefuse(
      [
        '~~~',
        '=== APPROVED_PLAN_BEGIN ===',
        '~~~',
        'repair_target_authorized_by_spec: #826',
        '=== APPROVED_PLAN_END ===',
      ].join('\n'),
      'no_standalone_field'
    );
    expectRefuse(wrap('repair_target_authorized_by_spec: #826\n~~~'), 'no_standalone_field');
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
