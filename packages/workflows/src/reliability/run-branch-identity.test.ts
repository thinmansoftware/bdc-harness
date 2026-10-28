import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assertPrBaseAllowed,
  resolveRecordedBaseBranch,
  resolveRecordedHeadBranch,
} from './run-branch-identity';

const LANE_FILES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
] as const;

const DEFAULTS_DIR = join(import.meta.dir, '../../../../.archon/workflows/defaults');

function openPrNode(yaml: string): string {
  const marker = '\n  - id: open-pr-if-needed\n';
  const start = yaml.indexOf(marker);
  if (start < 0) throw new Error('open-pr-if-needed node missing');
  const rest = yaml.slice(start + 1);
  const next = rest.indexOf('\n  - id: ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('resolveRecordedBaseBranch', () => {
  test('direct, conductor, and escalated non-repair specs record the declared base', () => {
    const fixtures = [
      'Fire path: direct\nBase branch: dev\n',
      'Fire path: smart-cauldron conductor\nBase branch: dev\n',
      'Fire path: escalated\nBase branch: dev\n',
    ];
    for (const spec of fixtures) {
      expect(resolveRecordedBaseBranch(spec, { cauldron_base: 'staging' }, 'main')).toBe('dev');
      expect(resolveRecordedHeadBranch(spec, 'archon/thread-abc')).toBe('archon/thread-abc');
    }
  });

  test('repair records the live PR base, never the declared base', () => {
    const spec = 'Base branch: dev\nRepair target: PR #99 (branch feat/example)\n';
    expect(resolveRecordedBaseBranch(spec, { cauldron_base: 'dev' }, 'staging')).toBe('staging');
    expect(resolveRecordedHeadBranch(spec, 'archon/thread-abc')).toBe('feat/example');
  });

  test('repair with no live base is a miss, never dev', () => {
    const spec = 'Base branch: dev\nRepair target: PR #99 (branch feat/example)\n';
    expect(
      resolveRecordedBaseBranch(spec, { cauldron_base: 'dev', base_branch: 'dev' }, undefined)
    ).toBe(undefined);
    expect(resolveRecordedBaseBranch(spec, undefined, '   ')).toBeUndefined();
    expect(resolveRecordedHeadBranch(spec, 'archon/thread-abc')).toBe('feat/example');
  });

  test('project-map fallback applies only when the spec declares no base', () => {
    const undeclared = 'Fire path: direct\nNo base declared.\n';
    expect(
      resolveRecordedBaseBranch(
        undeclared,
        { cauldron_base: 'dev', base_branch: 'main' },
        undefined
      )
    ).toBe('dev');
    expect(resolveRecordedBaseBranch(undeclared, { base_branch: 'staging' }, undefined)).toBe(
      'staging'
    );
    expect(
      resolveRecordedBaseBranch('Base branch: release/ce\n', { cauldron_base: 'dev' }, undefined)
    ).toBe('release/ce');
    expect(
      resolveRecordedBaseBranch(undeclared, { cauldron_base: '  ', base_branch: ' ' }, undefined)
    ).toBe(undefined);
  });
});

describe('assertPrBaseAllowed', () => {
  test('named base_branch_mismatch when recorded and attempted bases differ', () => {
    expect(() => assertPrBaseAllowed('dev', 'main')).toThrow(Error);
    try {
      assertPrBaseAllowed('dev', 'main');
      throw new Error('expected base_branch_mismatch');
    } catch (error) {
      const mismatch = error as Error;
      if (mismatch.message === 'expected base_branch_mismatch') throw mismatch;
      expect(mismatch.name).toBe('base_branch_mismatch');
      expect(mismatch.message).toContain('recorded=dev');
      expect(mismatch.message).toContain('attempted=main');
    }
  });

  test('equal or incomplete bases are allowed', () => {
    expect(() => assertPrBaseAllowed('dev', 'dev')).not.toThrow();
    expect(() => assertPrBaseAllowed('dev', '')).not.toThrow();
    expect(() => assertPrBaseAllowed(undefined, 'main')).not.toThrow();
  });
});

describe('cauldron lane PR open guard', () => {
  test('each feature lane refuses a base mismatch inside open-pr-if-needed and does not retarget', () => {
    expect(LANE_FILES.length).toBe(13);
    for (const file of LANE_FILES) {
      const yaml = readFileSync(join(DEFAULTS_DIR, file), 'utf8');
      const node = openPrNode(yaml);
      expect(node).toContain('ERROR: base_branch_mismatch');
      expect(node).toContain('ERROR: recorded_base_branch_missing');
      expect(node).toContain('# existing-pr-base-guard: begin');
      expect(node).toContain('--json url,baseRefName');
      expect(node).toContain('accept_open_pr_or_refuse');
      expect(node).not.toContain('gh pr edit');
      expect(node).not.toContain('.[0].url // empty');
      expect(node).toContain('--base "$BASE_BRANCH"');
      expect(node).not.toContain('${BASE_BRANCH:+--base');
      expect(node).not.toContain('${BASE_BRANCH:-dev}');
    }
  });
});

const GUARD_BEGIN = '# existing-pr-base-guard: begin';
const GUARD_END = '# existing-pr-base-guard: end';

const EXISTING_PR_ON_MAIN = `[
  {
    "baseRefName": "main",
    "url": "https://github.com/acme/widgets/pull/55"
  }
]
`;

const EXISTING_PR_ON_DEV = `[
  {
    "baseRefName": "dev",
    "url": "https://github.com/acme/widgets/pull/55"
  }
]
`;

const NO_OPEN_PR = '[]\n';

const EXISTING_PR_WITHOUT_BASE = `[
  {
    "baseRefName": null,
    "url": "https://github.com/acme/widgets/pull/55"
  }
]
`;

/**
 * The bytes the workflow engine runs: YAML block-scalar dedent of the shipped
 * existing-PR guard, not a retyped copy.
 */
function existingPrGuard(yaml: string): string {
  const at = yaml.indexOf(GUARD_BEGIN);
  const end = yaml.indexOf(GUARD_END);
  if (at < 0 || end < at) {
    throw new Error('existing-pr-base-guard markers missing');
  }
  const lineStart = yaml.lastIndexOf('\n', at) + 1;
  const endLine = yaml.lastIndexOf('\n', end);
  const chunk = yaml.slice(lineStart, endLine);
  const lines = chunk.split('\n');
  const widths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.length - line.trimStart().length);
  const min = Math.min(...widths);
  return lines.map(line => (line.startsWith(' '.repeat(min)) ? line.slice(min) : line)).join('\n');
}

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
  args: string;
  creates: number;
}

function runExistingPrGuard(
  guard: string,
  list1: string,
  list2: string,
  createRc: number
): GuardResult {
  const dir = mkdtempSync(join(tmpdir(), 'pr-base-guard-'));
  try {
    const list1Path = join(dir, 'list1.json');
    const list2Path = join(dir, 'list2.json');
    const argsLog = join(dir, 'args.log');
    const listCount = join(dir, 'list.count');
    const createCount = join(dir, 'create.count');
    writeFileSync(list1Path, list1);
    writeFileSync(list2Path, list2);
    writeFileSync(argsLog, '');
    writeFileSync(listCount, '0');
    writeFileSync(createCount, '0');
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_ARGS_LOG"
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  echo "unexpected retarget" >&2
  exit 97
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  n=$(cat "$GH_LIST_COUNT")
  n=$((n + 1))
  printf '%s' "$n" > "$GH_LIST_COUNT"
  if [ "$n" -eq 1 ]; then
    cat "$GH_LIST_1"
  else
    cat "$GH_LIST_2"
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  n=$(cat "$GH_CREATE_COUNT")
  n=$((n + 1))
  printf '%s' "$n" > "$GH_CREATE_COUNT"
  echo "https://github.com/acme/widgets/pull/created"
  exit "$GH_CREATE_RC"
fi
echo "unexpected gh: $*" >&2
exit 96
`
    );
    chmodSync(gh, 0o755);
    const script = join(dir, 'guard.sh');
    writeFileSync(script, `set -euo pipefail\n${guard}\n`);
    const result = Bun.spawnSync(['bash', script], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GH_ARGS_LOG: argsLog,
        GH_LIST_COUNT: listCount,
        GH_CREATE_COUNT: createCount,
        GH_LIST_1: list1Path,
        GH_LIST_2: list2Path,
        GH_CREATE_RC: String(createRc),
        RECORDED_BASE_BRANCH: 'dev',
        UNIQUE_BRANCH: 'feat/identity-01',
        REPO: 'acme/widgets',
        TITLE: 't',
        BODY_FILE: '/dev/null',
        BASE_BRANCH: 'dev',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      args: readFileSync(argsLog, 'utf8'),
      creates: Number(readFileSync(createCount, 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('existing PR base verification', () => {
  test('every lane refuses a pre-existing main PR when the recorded base is dev', () => {
    const guards = LANE_FILES.map(file =>
      existingPrGuard(readFileSync(join(DEFAULTS_DIR, file), 'utf8'))
    );
    expect(guards.length).toBe(13);
    for (const guard of guards) {
      expect(guard).toBe(guards[0]);
    }
    for (const [index, file] of LANE_FILES.entries()) {
      const guard = guards[index];
      if (!guard) throw new Error(`missing guard for ${file}`);
      const result = runExistingPrGuard(guard, EXISTING_PR_ON_MAIN, EXISTING_PR_ON_MAIN, 0);
      expect(result.code, file).toBe(1);
      expect(result.stderr).toContain('ERROR: base_branch_mismatch: recorded=dev attempted=main');
      expect(result.stdout).not.toContain('PR already exists');
      expect(result.stdout).not.toContain('PR_URL=');
      expect(result.creates).toBe(0);
      expect(result.args).toContain('--json url,baseRefName');
      expect(result.args).toContain('--head feat/identity-01');
      expect(result.args).not.toContain('pr edit');
    }
  });

  test('accepts an existing PR whose real base matches the recorded base', () => {
    const guard = existingPrGuard(
      readFileSync(join(DEFAULTS_DIR, 'bdc-feature-development.yaml'), 'utf8')
    );
    const result = runExistingPrGuard(guard, EXISTING_PR_ON_DEV, EXISTING_PR_ON_DEV, 0);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('PR_URL=https://github.com/acme/widgets/pull/55');
    expect(result.stdout).toContain('PR already exists (no create needed).');
    expect(result.creates).toBe(0);
    expect(result.stderr).not.toContain('base_branch_mismatch');
  });

  test('refuses an existing PR whose real base was not returned', () => {
    const guard = existingPrGuard(
      readFileSync(join(DEFAULTS_DIR, 'bdc-feature-development.yaml'), 'utf8')
    );
    const result = runExistingPrGuard(guard, EXISTING_PR_WITHOUT_BASE, EXISTING_PR_WITHOUT_BASE, 0);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      'ERROR: base_branch_mismatch: recorded=dev attempted=<unverified>'
    );
    expect(result.stdout).not.toContain('PR already exists');
    expect(result.creates).toBe(0);
  });

  test('refuses a wrong-base PR found after create returns non-zero', () => {
    const guard = existingPrGuard(
      readFileSync(join(DEFAULTS_DIR, 'bdc-feature-development.yaml'), 'utf8')
    );
    const result = runExistingPrGuard(guard, NO_OPEN_PR, EXISTING_PR_ON_MAIN, 1);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('ERROR: base_branch_mismatch: recorded=dev attempted=main');
    expect(result.stdout).not.toContain('PR confirmed via list');
    expect(result.creates).toBe(1);
    expect(result.args).not.toContain('pr edit');
  });

  test('keeps quirk recovery when the confirmed PR base matches', () => {
    const guard = existingPrGuard(
      readFileSync(join(DEFAULTS_DIR, 'bdc-feature-development.yaml'), 'utf8')
    );
    const result = runExistingPrGuard(guard, NO_OPEN_PR, EXISTING_PR_ON_DEV, 1);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'PR created despite non-zero exit (gh CLI quirk; PR confirmed via list).'
    );
    expect(result.stdout).toContain('PR_URL=https://github.com/acme/widgets/pull/55');
    expect(result.creates).toBe(1);
  });
});
