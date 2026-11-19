/**
 * docker-entrypoint.sh safe.directory pruning.
 *
 * Lifts the real safe.directory block out of docker-entrypoint.sh (no re-typed
 * copy) and runs it with bash against a temporary GIT_CONFIG_GLOBAL seeded with
 * a '*' entry plus path entries. Asserts exactly one '*' remains, no path
 * entries remain, and that the block is idempotent and set -e safe.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entrypoint = readFileSync(new URL('../../docker-entrypoint.sh', import.meta.url), 'utf8');

function extractBlock(source: string): string {
  const start = source.indexOf('if ! $RUNNER git config --global --get-all safe.directory');
  const endMarker = "'^/' || [ $? -eq 5 ]";
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0)
    throw new Error('safe.directory block not found in docker-entrypoint.sh');
  return source.slice(start, end + endMarker.length);
}

function runBlock(config: string): { entries: string[]; status: number } {
  const dir = mkdtempSync(join(tmpdir(), 'archon-gitcfg-'));
  const cfg = join(dir, 'gitconfig');
  writeFileSync(cfg, config);
  try {
    const script = `set -e\nRUNNER=""\n${extractBlock(entrypoint)}\n${extractBlock(entrypoint)}\necho done\n`;
    execFileSync('bash', ['-c', script], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: cfg, HOME: dir, MSYS_NO_PATHCONV: '1' },
      encoding: 'utf8',
    });
    let entries: string[] = [];
    try {
      entries = execFileSync('git', ['config', '--file', cfg, '--get-all', 'safe.directory'], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
    } catch {
      entries = [];
    }
    return { entries, status: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('entrypoint safe.directory block', () => {
  it("keeps exactly one '*' and removes all path entries", () => {
    const { entries } = runBlock(
      '[safe]\n\tdirectory = *\n\tdirectory = /.archon/a\n\tdirectory = /.archon/b\n\tdirectory = /.archon/c\n'
    );
    expect(entries).toEqual(['*']);
  });

  it("adds '*' and prunes paths when '*' was missing", () => {
    const { entries } = runBlock('[safe]\n\tdirectory = /.archon/a\n\tdirectory = /.archon/b\n');
    expect(entries).toEqual(['*']);
  });

  it('is a no-op (exit 5 tolerated under set -e) when only * exists', () => {
    const { entries } = runBlock('[safe]\n\tdirectory = *\n');
    expect(entries).toEqual(['*']);
  });
});
