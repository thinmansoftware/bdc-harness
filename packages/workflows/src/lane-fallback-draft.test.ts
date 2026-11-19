/**
 * WO-HARNESS-MERGE-GATES-01, Test 7: fallback_pr_is_opened_as_a_draft_in_all_13_lanes.
 *
 * The noninteractive-salvage node opens a "FALLBACK: opus-repaired build needs human review" PR from a
 * failed run. It must be a DRAFT: no automatic path can then merge or approve it, and a person marks it
 * ready (provisioner PR 111 was merged unattended from a failed run on 2026-11-13).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LANES_DIR = join(import.meta.dir, '../../../.archon/workflows/defaults');
const LANES = readdirSync(LANES_DIR)
  .filter(name => /^bdc-feature-development.*\.yaml$/.test(name))
  .sort();
const TITLE = '--title "FALLBACK: opus-repaired build needs human review"';

describe('the 13 bdc-feature-development lanes', () => {
  test('there are 13 lanes', () => {
    expect(LANES.length).toBe(13);
  });

  for (const lane of LANES) {
    test(`${lane}: exactly one FALLBACK gh pr create, and it carries --draft after --base`, () => {
      const text = readFileSync(join(LANES_DIR, lane), 'utf-8').replace(/\r\n/g, '\n');
      const lines = text.split('\n');
      const titleIndexes = lines
        .map((line, index) => (line.includes(TITLE) ? index : -1))
        .filter(index => index >= 0);
      expect(titleIndexes.length).toBe(1);
      const index = titleIndexes[0] as number;
      // The command starts on the line before the title line.
      const start = lines[index - 1] as string;
      expect(start).toContain('gh pr create');
      expect(start).toContain('--base "$BASE_BRANCH" --draft');
    });

    test(`${lane}: no other gh pr create line carries --draft`, () => {
      const text = readFileSync(join(LANES_DIR, lane), 'utf-8').replace(/\r\n/g, '\n');
      const withDraft = text
        .split('\n')
        .filter(line => line.includes('gh pr create') && line.includes('--draft'));
      expect(withDraft.length).toBe(1);
    });
  }
});
