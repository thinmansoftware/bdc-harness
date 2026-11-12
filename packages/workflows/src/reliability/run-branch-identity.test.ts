import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runLanePrFixture } from './run-pr.test-fixture';
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

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

function openPrNode(yaml: string): string {
  // Windows checkout of text=auto YAML is CRLF. These anchors are
  // newline-terminated (see bdc-push-correctness.test.ts).
  const text = yaml.replace(/\r\n/g, '\n');
  const marker = '\n  - id: open-pr-if-needed\n';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error('open-pr-if-needed node missing');
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n  - id: ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

function assertOpenPrGuard(node: string): void {
  expect(node).toContain('ERROR: base_branch_mismatch');
  expect(node).toContain('ERROR: recorded_base_branch_missing');
  expect(node).toContain('# existing-pr-base-guard: begin');
  expect(node).toContain('--json number,url,headRefName,headRefOid,baseRefName,author,state');
  expect(node).toContain('rpr_find');
  expect(node).toContain('rpr_owned');
  expect(node).toContain('p["baseRefName"] == os.environ["RPR_BASE"]');
  expect(node).not.toContain('gh pr edit');
  expect(node).not.toContain('.[0].url // empty');
  expect(node).toContain('--base "$BASE_BRANCH"');
  expect(node).not.toContain('${BASE_BRANCH:+--base');
  expect(node).not.toContain('${BASE_BRANCH:-dev}');
}

function expectMissingOpenPrNode(yaml: string): void {
  let thrown: unknown;
  try {
    openPrNode(yaml);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe('open-pr-if-needed node missing');
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
      const raw = readFileSync(join(DEFAULTS_DIR, file), 'utf8');
      const canonical = toLf(raw);
      const crlfCheckout = toCrlf(canonical);
      const fromCrlfCheckout = toLf(crlfCheckout);
      expect(fromCrlfCheckout).toBe(canonical);
      expect(canonical.includes('\r')).toBe(false);
      expect(fromCrlfCheckout.includes('\r')).toBe(false);
      const syntheticCrlf = toCrlf(canonical);
      expect(syntheticCrlf.includes('\r\r\n')).toBe(false);
      expect(toLf(syntheticCrlf)).toBe(canonical);
      const lfNode = openPrNode(canonical);
      const crlfNode = openPrNode(syntheticCrlf);
      expect(lfNode).toBe(crlfNode);
      assertOpenPrGuard(lfNode);
      assertOpenPrGuard(crlfNode);
    }
  });

  test('LF and CRLF extractions return the same node and exclude the next node', () => {
    const lf =
      '\n  - id: open-pr-if-needed\n    run: target-body\n  - id: next-node\n    run: adjacent-body\n';
    const crlfCheckout = toCrlf(toLf(lf));
    const canonical = toLf(crlfCheckout);
    expect(canonical).toBe(toLf(lf));
    expect(canonical.includes('\r')).toBe(false);
    const syntheticCrlf = toCrlf(canonical);
    expect(syntheticCrlf.includes('\r\r\n')).toBe(false);
    expect(toLf(syntheticCrlf)).toBe(canonical);
    const fromLf = openPrNode(canonical);
    const fromCrlf = openPrNode(syntheticCrlf);
    expect(fromLf).toBe(fromCrlf);
    for (const node of [fromLf, fromCrlf]) {
      expect(node).toContain('id: open-pr-if-needed');
      expect(node).toContain('target-body');
      expect(node).not.toContain('next-node');
      expect(node).not.toContain('adjacent-body');
    }
  });

  test('naive conversion of an existing CRLF checkout becomes CRCRLF and misses the node', () => {
    const lf = '\n  - id: open-pr-if-needed\n    run: target-body\n';
    const crlfCheckout = toCrlf(toLf(lf));
    const crcrlf = crlfCheckout.replace(/\n/g, '\r\n');
    expect(crcrlf.includes('\r\r\n')).toBe(true);
    expectMissingOpenPrNode(crcrlf);
    const canonical = toLf(crlfCheckout);
    expect(canonical.includes('\r')).toBe(false);
    const syntheticCrlf = toCrlf(canonical);
    expect(syntheticCrlf.includes('\r\r\n')).toBe(false);
    expect(openPrNode(canonical)).toBe(openPrNode(syntheticCrlf));
  });

  test('a missing node and a differently named node throw for LF and CRLF', () => {
    const absent = '\n  - id: some-other-node\n    run: nope\n';
    const differentlyNamed = '\n  - id: open-pr-if-needed-extra\n    run: nope\n';
    for (const source of [absent, differentlyNamed]) {
      const canonical = toLf(source);
      const crlfCheckout = toCrlf(canonical);
      expect(toLf(crlfCheckout)).toBe(canonical);
      expect(canonical.includes('\r')).toBe(false);
      expect(crlfCheckout.includes('\r\r\n')).toBe(false);
      expectMissingOpenPrNode(canonical);
      expectMissingOpenPrNode(toCrlf(canonical));
    }
  });
});

const GUARD_BEGIN = '# existing-pr-base-guard: begin';
const GUARD_END = '# existing-pr-base-guard: end';

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

/**
 * Git Bash form of a Windows directory. `C:\foo` and `C:/foo` both become `/c/foo`.
 * The replacement inserts only the captured drive letter. The colon is dropped and
 * the separator after it is left in place, so the result is `/c/...`.
 */
function toGitBashDir(dir: string): string {
  return dir
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

describe('toGitBashDir', () => {
  test('uses only the drive letter so a Windows temp dir is /c/...', () => {
    expect(toGitBashDir('C:\\Users\\runner\\Temp\\pr-base-guard-abc')).toBe(
      '/c/Users/runner/Temp/pr-base-guard-abc'
    );
    expect(toGitBashDir('C:/Users/runner/Temp/pr-base-guard-abc')).toBe(
      '/c/Users/runner/Temp/pr-base-guard-abc'
    );
    expect(toGitBashDir('D:\\a\\b')).toBe('/d/a/b');
  });
});

describe('existing PR base verification', () => {
  test('all 13 lanes carry the same complete ownership and base predicate', () => {
    const guards = LANE_FILES.map(file =>
      existingPrGuard(readFileSync(join(DEFAULTS_DIR, file), 'utf8'))
    );
    expect(guards).toHaveLength(13);
    for (const guard of guards) {
      expect(guard).toBe(guards[0]);
      expect(guard).toContain('p["baseRefName"] == os.environ["RPR_BASE"]');
      expect(guard).not.toContain('gh pr edit');
    }
  });
  for (const [name, fixtureCase] of [
    ['refuses a recorded PR whose live base differs from the recorded base', 'recorded-wrong-base'],
    ['accepts a run-owned ancestor PR with the recorded base', 'own-ancestor'],
    ['refuses a recorded PR whose live base was not returned', 'recorded-missing-base'],
    ['ignores a wrong-base PR discovered after a nonzero create', 'wrong-base-after-create'],
    ['recovers a nonzero create when the owned PR and base match', 'created-nonzero'],
  ]) {
    test(
      name!,
      () => {
        const result = runLanePrFixture(fixtureCase!);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('PASS:');
      },
      60000
    );
  }
});
