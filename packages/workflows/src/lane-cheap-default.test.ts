/**
 * lane-cheap-default.test.ts
 *
 * Test scenario 3 from WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01:
 *
 * S3: No lane other than the EXEMPT main Claude lane (bdc-feature-development.yaml) has
 *     `model: sonnet` at the YAML top level. The exempt lane MUST have the exemption comment.
 *
 * This catches the "Claude usage leak" where un-pinned housekeeping nodes in non-Claude
 * lanes fall through to the top-level default and bill Claude unnecessarily.
 *
 * Design: read the raw file content rather than parsing so we can inspect the exact
 * top-level `model:` line without YAML parse inferring defaults.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const LANES_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

// The main Claude lane is EXEMPT: its top-level model: sonnet is intentional.
const EXEMPT_LANE = 'bdc-feature-development.yaml';

// Only test lanes (the bdc-feature-development family)
const LANE_FILES = readdirSync(LANES_DIR)
  .filter(f => f.startsWith('bdc-feature-development') && f.endsWith('.yaml'))
  .sort();

describe('lane cheap defaults (no Claude usage leak)', () => {
  it('S3a: non-exempt lanes have no top-level `model: sonnet`', () => {
    const leaking: string[] = [];
    for (const file of LANE_FILES) {
      if (file === EXEMPT_LANE) continue;
      const content = readFileSync(join(LANES_DIR, file), 'utf-8');
      // Match a YAML top-level `model: sonnet` line (not indented)
      if (/^model:\s*sonnet\s*$/m.test(content)) {
        leaking.push(file);
      }
    }
    if (leaking.length > 0) {
      throw new Error(
        'These lanes still have top-level `model: sonnet` (Claude usage leak):\n' +
          leaking.map(f => '  ' + f).join('\n') +
          "\nChange the top-level model to the lane's build model " +
          'and pin war-council-validator to provider: claude model: sonnet.'
      );
    }
  });

  it('S3b: exempt main Claude lane retains top-level `model: sonnet`', () => {
    const content = readFileSync(join(LANES_DIR, EXEMPT_LANE), 'utf-8');
    expect(/^model:\s*sonnet\s*$/m.test(content)).toBe(true);
  });

  it('S3c: exempt main Claude lane has the exemption comment', () => {
    const content = readFileSync(join(LANES_DIR, EXEMPT_LANE), 'utf-8');
    expect(content).toContain('Main Claude build lane');
  });
});
