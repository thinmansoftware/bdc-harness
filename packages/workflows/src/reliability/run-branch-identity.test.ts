import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
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

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

function openPrNode(yaml: string): string {
  const normalized = yaml.replace(/\r\n/g, '\n');
  const marker = '\n  - id: open-pr-if-needed\n';
  const start = normalized.indexOf(marker);
  if (start < 0) throw new Error('open-pr-if-needed node missing');
  const rest = normalized.slice(start + 1);
  const next = rest.indexOf('\n  - id: ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

function assertOpenPrGuard(node: string): void {
  expect(node).toContain('ERROR: base_branch_mismatch');
  expect(node).toContain('ERROR: recorded_base_branch_missing');
  expect(node).not.toContain('gh pr edit');
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
