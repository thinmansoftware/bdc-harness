/**
 * WO-HARNESS-MERGE-GATES-01, Tests 1 and 4.
 * Test 1: merge_hold_predicate_returns_the_first_reason.
 * Test 4: coordinator_and_manager_share_one_predicate.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MERGE_HOLD_LABEL, MERGE_HOLD_REASONS, mergeHoldReason } from './merge-holds.ts';

describe('Test 1: merge_hold_predicate_returns_the_first_reason', () => {
  test('labels', () => {
    expect(mergeHoldReason({ labels: [] })).toBeNull();
    expect(mergeHoldReason({ labels: ['merge-hold'] })).toBe('merge_hold_label');
    // GitHub label names are case-insensitive: a spelling difference never releases a hold.
    expect(mergeHoldReason({ labels: ['Merge-Hold'] })).toBe('merge_hold_label');
    expect(mergeHoldReason({ labels: ['  MERGE-HOLD  '] })).toBe('merge_hold_label');
    expect(mergeHoldReason({ labels: ['RUN:BLOCKED'] })).toBe('run_blocked_label');
    expect(mergeHoldReason({ labels: ['Owner:Reworking'] })).toBe('owner_reworking_label');
    expect(mergeHoldReason({ labels: ['run:blocked'] })).toBe('run_blocked_label');
    expect(mergeHoldReason({ labels: ['owner:reworking'] })).toBe('owner_reworking_label');
    expect(mergeHoldReason({ labels: ['merge-held-evidence', 'merge-hold-ish'] })).toBeNull();
  });

  test('order: the result does not depend on label order', () => {
    const forward = ['bug', 'merge-hold', 'owner:reworking'];
    expect(mergeHoldReason({ labels: forward })).toBe('merge_hold_label');
    expect(mergeHoldReason({ labels: [...forward].reverse() })).toBe('merge_hold_label');
    expect(mergeHoldReason({ labels: ['owner:reworking', 'run:blocked'] })).toBe(
      'run_blocked_label'
    );
  });

  test('draft and FALLBACK title', () => {
    expect(mergeHoldReason({ draft: true })).toBe('pr_is_draft');
    expect(mergeHoldReason({ draft: false, title: 'Ordinary change' })).toBeNull();
    expect(mergeHoldReason({ title: 'FALLBACK: opus-repaired build needs human review' })).toBe(
      'fallback_pr_title'
    );
    expect(mergeHoldReason({ title: '  fallback: x' })).toBe('fallback_pr_title');
    // Only a PREFIX holds.
    expect(mergeHoldReason({ title: 'Add FALLBACK handling' })).toBeNull();
    // A label outranks a draft, which outranks a title.
    expect(mergeHoldReason({ labels: ['merge-hold'], draft: true, title: 'FALLBACK: x' })).toBe(
      'merge_hold_label'
    );
    expect(mergeHoldReason({ draft: true, title: 'FALLBACK: x' })).toBe('pr_is_draft');
  });

  test('all-undefined input is clean, and failClosed refuses missing fields', () => {
    expect(mergeHoldReason({})).toBeNull();
    expect(mergeHoldReason({ labels: null, draft: null, title: null })).toBeNull();
    expect(mergeHoldReason({}, { failClosed: true })).toBe('pr_labels_unknown');
    expect(mergeHoldReason({ labels: [] }, { failClosed: true })).toBe('pr_draft_unknown');
    expect(mergeHoldReason({ labels: [], draft: false }, { failClosed: true })).toBeNull();
    // A real hold wins over "unknown".
    expect(mergeHoldReason({ labels: ['merge-hold'] }, { failClosed: true })).toBe(
      'merge_hold_label'
    );
  });

  test('every returned reason is registered as a hold reason', () => {
    const inputs = [
      { labels: ['merge-hold'] },
      { labels: ['run:blocked'] },
      { labels: ['owner:reworking'] },
      { labels: [], draft: true },
      { labels: [], draft: false, title: 'FALLBACK: x' },
    ];
    for (const input of inputs) {
      expect(MERGE_HOLD_REASONS.has(mergeHoldReason(input) ?? '')).toBe(true);
    }
    expect(MERGE_HOLD_REASONS.has('pr_labels_unknown')).toBe(true);
    expect(MERGE_HOLD_REASONS.has('pr_draft_unknown')).toBe(true);
    expect(MERGE_HOLD_LABEL).toBe('merge-hold');
  });
});

function nonTestSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      nonTestSources(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Test 4: coordinator_and_manager_share_one_predicate', () => {
  const root = import.meta.dir;
  const read = (name: string): string => readFileSync(join(root, name), 'utf-8');

  test('the manager, the coordinator and the merge function import mergeHoldReason', () => {
    expect(read('merge-manager.ts')).toContain("from './merge-holds'");
    expect(read('merge-execution-bridge.ts')).toContain("from './merge-holds'");
    expect(read('adapters/github-real-deps.ts')).toContain("from '../merge-holds'");
    for (const file of [
      'merge-manager.ts',
      'merge-execution-bridge.ts',
      'adapters/github-real-deps.ts',
    ]) {
      expect(read(file)).toContain('mergeHoldReason(');
    }
  });

  test('the hold label strings live in no other non-test file', () => {
    const allowed = new Set(['merge-holds.ts', 'merge-candidate-discovery.ts']);
    const offenders: string[] = [];
    for (const file of nonTestSources(root)) {
      const base = file.slice(root.length + 1).replace(/\\/g, '/');
      if (allowed.has(base)) continue;
      const text = readFileSync(file, 'utf-8');
      // Code literals only (a quoted label name); prose in comments may name the labels.
      const codeLines = text.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
      const code = codeLines.join('\n');
      if (/['"`](merge-hold|run:blocked|owner:reworking)['"`]/.test(code)) offenders.push(base);
    }
    expect(offenders).toEqual([]);
  });
});
