/**
 * lane-retirement.test.ts
 *
 * Guards the deliverable of WO-HARNESS-RETIRE-DEAD-LANES-01 (John's 2026-07-06
 * lane ruling: Cauldron lanes = CLAUDE + CODEX ONLY; all other feature lanes,
 * including qwen, are retired and may only return via the earn-the-seat path).
 *
 * These assertions codify the WO's stop point (section 12) plus the guard the
 * Codex diff review flagged as missing: retired lane names must not reappear
 * outside .archon/workflows/retired/, and the workflows ROOT must not gain
 * stray project-tier copies of retired lanes or defaults-only support
 * workflows (which, for bdc-harness's self-hosted Archon instance, would
 * override defaults/ by filename and silently re-enable a retired lane).
 *
 * Filesystem-based on purpose: file presence in defaults/ is exactly what the
 * runtime registry serves, so the invariant must be checked against the real
 * directory tree, not a parsed abstraction.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOWS_ROOT = join(REPO_ROOT, '.archon/workflows');
const DEFAULTS_DIR = join(WORKFLOWS_ROOT, 'defaults');
const RETIRED_DIR = join(WORKFLOWS_ROOT, 'retired');

// The two active feature lanes after the ruling (section 6): Claude and Codex.
const KEEPER_LANES = ['bdc-feature-development.yaml', 'bdc-feature-development-codex.yaml'].sort();

// The nine lanes relocated to retired/ (section 6 matrix), qwen included.
const RETIRED_LANES = [
  'bdc-feature-development-glm.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-qwen.yaml',
  'bdc-feature-development-open-a.yaml',
  'bdc-feature-development-open-b.yaml',
  'bdc-feature-development-fusion-cx-glm.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-fusion-ds-glm.yaml',
  'bdc-feature-development-fusion-qwen-glm.yaml',
].sort();

// Substring markers used by the WO's own stop-point grep
// (`ls defaults/ | grep -cE "glm|zero|qwen|open-a|open-b|fusion"` must be 0).
const RETIRED_NAME_MARKERS = /(glm|zero|qwen|open-a|open-b|fusion)/;

// Files that were NEVER part of the workflows ROOT before this WO and must not
// be introduced there: any fusion lane, the zero lane, and the three
// defaults-only support workflows a WIP checkpoint erroneously copied to root.
// (The pre-existing root copies of -glm/-open-a/-open-b belong to bdc-harness's
// self-hosted instance and predate this WO; cleaning those up is out of scope
// here, so they are deliberately NOT asserted against.)
const FORBIDDEN_AT_ROOT = [
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-qwen.yaml',
  'bdc-feature-development-fusion-cx-glm.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-fusion-ds-glm.yaml',
  'bdc-feature-development-fusion-qwen-glm.yaml',
  'bdc-audit-claude.yaml',
  'bdc-author-wo-batch.yaml',
  'bdc-multi-stage-development.yaml',
];

function yamlFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.yaml') || name.endsWith('.yml'))
    .filter(name => statSync(join(dir, name)).isFile())
    .sort();
}

describe('WO-HARNESS-RETIRE-DEAD-LANES-01 lane retirement invariants', () => {
  it('defaults/ keeps exactly the two active feature lanes (base, codex)', () => {
    const featureLanes = yamlFilesIn(DEFAULTS_DIR).filter(f =>
      f.startsWith('bdc-feature-development')
    );
    expect(featureLanes).toEqual(KEEPER_LANES);
  });

  it('defaults/ contains no retired lane names (WO stop point: grep count 0)', () => {
    const offenders = yamlFilesIn(DEFAULTS_DIR).filter(
      f => f.startsWith('bdc-feature-development') && RETIRED_NAME_MARKERS.test(f)
    );
    expect(offenders).toEqual([]);
  });

  it('retired/ holds exactly the nine retired lanes (qwen included)', () => {
    const retired = yamlFilesIn(RETIRED_DIR);
    expect(retired).toEqual(RETIRED_LANES);
    expect(retired).toContain('bdc-feature-development-qwen.yaml');
  });

  it('no lane file exists in both defaults/ and retired/ (single source of truth)', () => {
    const inDefaults = new Set(yamlFilesIn(DEFAULTS_DIR));
    const duplicated = yamlFilesIn(RETIRED_DIR).filter(f => inDefaults.has(f));
    expect(duplicated).toEqual([]);
  });

  it('workflows ROOT has no stray retired-lane or defaults-only support copies', () => {
    const rootFiles = new Set(yamlFilesIn(WORKFLOWS_ROOT));
    const stray = FORBIDDEN_AT_ROOT.filter(f => rootFiles.has(f));
    expect(stray).toEqual([]);
  });
});
