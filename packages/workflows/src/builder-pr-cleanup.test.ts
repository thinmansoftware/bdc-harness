import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const shell = process.platform === 'win32' ? process.env.ARCHON_GH_SHIM_TEST_SHELL : '/bin/sh';
const posix = (path: string): string =>
  process.platform === 'win32'
    ? path
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : path;
const root = join(import.meta.dir, '../../..');

for (const [name, current, mode, closes] of [
  ['canonical branch', 'feat/lane-thread-fixture', 'ok', false],
  ['builder branch', 'archon/task-fixture', 'ok', true],
  ['builder listing failure', 'archon/task-fixture', 'listing-failure', false],
  ['canonical URL failure', 'archon/task-fixture', 'url-failure', false],
] as const) {
  test.skipIf(!shell)(`lane PR cleanup preserves ${name}`, () => {
    const lane = parse(
      readFileSync(
        join(root, '.archon/workflows/defaults/bdc-feature-development-codex.yaml'),
        'utf8'
      )
    ) as { nodes: { id: string; bash?: string }[] };
    const bash = lane.nodes.find(node => node.id === 'open-pr-if-needed')?.bash ?? '';
    const start = bash.indexOf('# bdc-xo#2307: close builder PRs');
    expect(start).toBeGreaterThanOrEqual(0);
    const fragment = bash.slice(start);
    const directory = mkdtempSync(join(tmpdir(), 'builder-pr-cleanup-'));
    try {
      const log = join(directory, 'calls.log');
      writeFileSync(join(directory, 'git'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_CURRENT_REF"\n');
      writeFileSync(
        join(directory, 'gh'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
  *'--json url'*)
    [ "$FIXTURE_MODE" = url-failure ] && exit 1
    printf '%s\\n' 'https://github.com/fixture/repo/pull/42' ;;
  *'--json number,headRefName'*)
    [ "$FIXTURE_MODE" = listing-failure ] && exit 1
    printf '%s\\n' '41' ;;
esac
`
      );
      writeFileSync(join(directory, 'fragment.sh'), fragment);
      for (const file of ['gh', 'git']) chmodSync(join(directory, file), 0o755);
      const env = {
        ...process.env,
        FIXTURE_CURRENT_REF: current,
        FIXTURE_MODE: mode,
        FIXTURE_LOG: posix(log),
        UNIQUE_BRANCH: 'feat/lane-thread-fixture',
        REPO: 'fixture/repo',
      };
      const setup = 'PATH=$1; export PATH; exec /bin/sh "$2"';
      const args =
        process.platform === 'win32'
          ? [
              '--noprofile',
              '--norc',
              '-c',
              setup,
              'cleanup-test',
              posix(directory),
              posix(join(directory, 'fragment.sh')),
            ]
          : ['-c', setup, 'cleanup-test', directory, join(directory, 'fragment.sh')];
      const result = spawnSync(shell ?? '/nonexistent', args, {
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls.includes('pr close 41 --repo fixture/repo')).toBe(closes);
      if (current === 'feat/lane-thread-fixture') {
        expect(calls).not.toContain('--json number,headRefName');
        expect(calls).not.toContain('pr close');
      }
      if (closes) {
        expect(calls).toContain(
          'pr list --head archon/task-fixture --repo fixture/repo --state open'
        );
        expect(calls).toContain('select(.headRefName == "archon/task-fixture")');
      }
      if (mode !== 'ok') expect(result.stderr).toContain('WARN:');
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
}
