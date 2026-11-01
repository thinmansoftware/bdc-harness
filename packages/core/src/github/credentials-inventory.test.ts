/**
 * Test 7 (WO-HARNESS-GITHUB-TOKEN-PROVIDER-REFRESH-01): the credentials
 * inventory doc exists and carries a row for each of the nine credentials in
 * Section 4 of the WO. Placed under packages/core/src/github so the spec's
 * literal Stop 4 command (`bun test packages/core/src/github ...`) executes it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INVENTORY_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'credentials-inventory.md'
);

// One identifying token per credential row in Section 4 (nine rows total).
const REQUIRED_ROWS = [
  'GITHUB_APP_ID', // thinman-overseer App
  'GITHUB_APP_MERGE_MANAGER_', // merge manager App
  'GITHUB_APP_RUN_NODES_', // run nodes App
  'GITHUB_APP_TASKMASTER_', // taskmaster App (currently empty)
  'MERGE_MANAGER_GH_TOKEN', // legacy PAT fallbacks row
  'CURSOR_API_KEY', // Cursor static key
  'auth.json', // Codex OAuth file
  '.credentials.json', // Claude OAuth file
  'XAI_API_KEY', // Grok static key
];

describe('Test 7: credentials inventory', () => {
  const doc = readFileSync(INVENTORY_PATH, 'utf8');

  it('contains a row for each of the nine Section 4 credentials', () => {
    for (const token of REQUIRED_ROWS) {
      expect(doc).toContain(token);
    }
  });

  it('is ASCII-only (Rule 13)', () => {
    expect(/^[\x00-\x7f]*$/.test(doc)).toBe(true);
  });
});
