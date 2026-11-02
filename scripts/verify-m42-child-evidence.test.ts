import { describe, expect, test } from 'bun:test';
import {
  REQUIRED_CHILD_WO_IDS,
  verifyM42ChildEvidence,
  type ChildManifestEntry,
  type ParentManifestFile,
} from './verify-m42-child-evidence';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

function allChildren(
  overrides: Partial<Record<string, Partial<ChildManifestEntry>>> = {}
): ChildManifestEntry[] {
  return REQUIRED_CHILD_WO_IDS.map((wo_id, i) => ({
    wo_id,
    base_sha: A,
    pr_head: B,
    reviewed_head: B,
    merge_sha: C,
    pr_number: 400 + i,
    ...overrides[wo_id],
  }));
}

function manifest(children: ChildManifestEntry[]): ParentManifestFile {
  return { children };
}

const passDeps = {
  revParseVerify: () => true,
  diffNameOnly: () => [] as string[],
};

describe('verify-m42-child-evidence', () => {
  test('accepts complete unique children with verified SHAs and prints valid', () => {
    const result = verifyM42ChildEvidence(manifest(allChildren()), passDeps);
    expect(result).toEqual({ ok: true });
  });

  test('rejects missing child', () => {
    const children = allChildren().filter(c => c.wo_id !== 'WO-HARNESS-OVERSEER-REPAIR-REFIRE-01');
    const result = verifyM42ChildEvidence(manifest(children), passDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('WO-HARNESS-OVERSEER-REPAIR-REFIRE-01'))).toBe(
        true
      );
    }
  });

  test('rejects duplicate child id', () => {
    const children = [...allChildren(), allChildren()[0]!];
    const result = verifyM42ChildEvidence(manifest(children), passDeps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('duplicate'))).toBe(true);
  });

  test('rejects invalid sha and reviewed_head mismatch', () => {
    const children = allChildren({
      'WO-HARNESS-OVERSEER-CONTROL-PLANE-01': {
        base_sha: '',
        pr_head: 'nope',
        reviewed_head: D,
        merge_sha: C,
      },
    });
    const result = verifyM42ChildEvidence(manifest(children), passDeps);
    expect(result.ok).toBe(false);
  });

  test('rejects unverified commit objects', () => {
    const result = verifyM42ChildEvidence(manifest(allChildren()), {
      revParseVerify: sha => sha !== B,
      diffNameOnly: () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('verified commit'))).toBe(true);
  });

  test('rejects S4-S7 diffs that touch S8-owned paths', () => {
    const result = verifyM42ChildEvidence(manifest(allChildren()), {
      revParseVerify: () => true,
      diffNameOnly: () => [
        'packages/overseer/src/service.ts',
        'packages/overseer/src/actions/x.ts',
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.includes('forbidden S8-owned path'))).toBe(true);
    }
  });

  test('fail-fast when git diff fails for S4-S7', () => {
    const result = verifyM42ChildEvidence(manifest(allChildren()), {
      revParseVerify: () => true,
      diffNameOnly: () => {
        throw new Error('child_evidence_fail_fast: git diff failed');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.includes('fail_fast'))).toBe(true);
  });
});
