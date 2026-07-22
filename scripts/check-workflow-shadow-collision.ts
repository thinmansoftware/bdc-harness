#!/usr/bin/env bun
/**
 * Fails if any file under .archon/workflows/ (root level, not defaults/) has
 * the same filename as a file under .archon/workflows/defaults/.
 *
 * bdc-harness authors its own bundled workflow defaults, so a root-level file
 * with the same name as a defaults/ file can only be an accidental leak (a
 * resolved workflow run definition committed by mistake) -- it silently
 * shadows the maintained default at discovery time (repo overrides defaults
 * by exact filename), freezing every future fix to that default invisibly.
 *
 * Anchor: 2026-07-22 -- 8 stray root-level files (bdc-multi-stage-development.yaml
 * among them) were found shadowing their defaults/ counterparts, each leaked by a
 * separate self-build WO over ~6 weeks. One of them masked the WO-HARNESS-LANE-
 * PROVIDER-EXPLICIT-01 fix (#404) from ever taking effect on the live canary lane.
 *
 * Usage:
 *   bun run scripts/check-workflow-shadow-collision.ts          # exit 1 if collisions found
 *   bun run scripts/check-workflow-shadow-collision.ts --check  # exit 2 if collisions found (CI)
 *
 * Exit codes:
 *   0  no filename collisions between .archon/workflows/*.yaml and defaults/*.yaml
 *   1  collisions found (default mode)
 *   2  collisions found (--check mode, used by `bun run validate`)
 */
import { readdirSync } from 'fs';
import { join, resolve } from 'path';

export function listYamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      entry => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))
    )
    .map(entry => entry.name)
    .sort();
}

/** Filenames present in both the root workflow list and the defaults/ list, sorted. */
export function findShadowCollisions(rootFiles: string[], defaultFiles: string[]): string[] {
  const defaults = new Set(defaultFiles);
  return [...new Set(rootFiles)].filter(name => defaults.has(name)).sort();
}

if (import.meta.main) {
  const REPO_ROOT = resolve(import.meta.dir, '..');
  const WORKFLOWS_ROOT = join(REPO_ROOT, '.archon', 'workflows');
  const DEFAULTS_ROOT = join(WORKFLOWS_ROOT, 'defaults');

  const CHECK_ONLY = process.argv.includes('--check');

  const collisions = findShadowCollisions(
    listYamlFiles(WORKFLOWS_ROOT),
    listYamlFiles(DEFAULTS_ROOT)
  );

  if (collisions.length === 0) {
    console.log('check-workflow-shadow-collision: OK (0 collisions)');
    process.exit(0);
  }

  console.error(
    `check-workflow-shadow-collision: ${collisions.length} root-level workflow file(s) ` +
      'share a filename with a .archon/workflows/defaults/ file, silently shadowing it:\n'
  );
  for (const name of collisions) {
    console.error(`  - .archon/workflows/${name}  shadows  .archon/workflows/defaults/${name}`);
  }
  console.error(
    '\nThis repo authors its own workflow defaults -- a root-level file with the same name ' +
      'is never an intentional override, only a leaked artifact. Delete the root-level copy ' +
      '(git rm .archon/workflows/<name>.yaml) so discovery falls through to defaults/.'
  );
  process.exit(CHECK_ONLY ? 2 : 1);
}
