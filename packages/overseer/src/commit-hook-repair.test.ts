import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { classifyError } from './classify';
import { decide } from './decide';

const root = join(import.meta.dir, '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const hookFailure = `lint-staged\n[FAILED] eslint\npackages/server/src/taskmaster/loop.ts 1419:19 error Missing return type on function @typescript-eslint/explicit-function-return-type\nhusky - pre-commit script failed`;

describe('commit hook repair contract', () => {
  test('lint_hook_failure_classified_and_decided', () => {
    const errorClass = classifyError({ nodeId: 'commit-and-push', message: hookFailure });
    expect(errorClass).toBe('commit_hook_lint_failure');
    expect(decide({ errorClass, attempt: 1 })).toMatchObject({
      repairableOnce: true,
      blocker: false,
    });
    expect(decide({ errorClass, attempt: 2 })).toMatchObject({
      repairableOnce: false,
      blocker: true,
    });
  });

  test('hook_failure_text_on_other_node_not_captured', () => {
    expect(classifyError({ nodeId: 'build-manifest', message: hookFailure })).not.toBe(
      'commit_hook_lint_failure'
    );
    expect(classifyError({ nodeId: 'commit-and-push', message: 'git push rejected' })).not.toBe(
      'commit_hook_lint_failure'
    );
  });

  test('real_hook_repair_roundtrip', () => {
    const script = read('.archon/scripts/commit-and-push.sh');
    expect(script).toContain('git commit -m');
    expect(script).toContain('commit-hook-output.txt');
  });

  test('second_failure_does_not_loop', () => {
    const lane = read('.archon/workflows/defaults/bdc-feature-development-codex.yaml');
    expect(lane).toContain('.archon/scripts/commit-and-push.sh 1');
    expect(lane).toContain('.archon/scripts/commit-and-push.sh 2');
    expect(lane).not.toContain('.archon/scripts/commit-and-push.sh 3');
  });

  test('lane_yaml_structure_has_one_bounded_repair', () => {
    const lane = read('.archon/workflows/defaults/bdc-feature-development-codex.yaml');
    expect(lane.match(/id: commit-hook-repair/g)?.length).toBe(1);
    expect(lane).toContain('OPUS_REPAIR=fixed');
  });

  test('unpushed_repair_makes_open_pr_draft', () => {
    const lane = read('.archon/workflows/defaults/bdc-feature-development-codex.yaml');
    expect(lane).toContain('gh pr ready "$PR"');
    expect(lane).toContain('NOT pushed');
  });

  for (const repairState of ['needs_human', 'classification_failed', 'retry_failed', 'pushed']) {
    test(`terminal_hook_handling_${repairState}`, () => {
      const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
        nodes: {
          id: string;
          bash?: string;
          depends_on?: string[];
          trigger_rule?: string;
          when?: string;
        }[];
      };
      const terminal = lane.nodes.find(node => node.id === 'commit-hook-terminal');
      expect(terminal?.trigger_rule).toBe('all_done');
      expect(terminal?.when).toBeUndefined();
      expect(lane.nodes.find(node => node.id === 'open-pr-if-needed')?.depends_on).toEqual([
        'commit-hook-terminal',
      ]);
      const directory = mkdtempSync(join(tmpdir(), 'hook-terminal-'));
      const unixDirectory = directory.replaceAll('\\', '/');
      const pushed = repairState === 'pushed';
      writeFileSync(join(directory, 'commit-and-push.env'), 'UNIQUE_BRANCH=repair-branch\n');
      writeFileSync(join(directory, 'diff-review-final.out'), 'UNRESOLVED missing return type\n');
      const script =
        `export ARTIFACTS_DIR='${unixDirectory}' ARCHON_NODE_OUT='${unixDirectory}'\n` +
        `git() { case "$1" in ls-remote) printf '${pushed ? 'local-head' : 'old-head'}\\trefs/heads/repair-branch\\n';; rev-parse) echo local-head;; diff) return ${pushed ? '0' : '1'};; ls-files) return 0;; remote) echo https://github.com/thinmansoftware/bdc-harness.git;; esac; }\n` +
        `gh() { if [ "$2" = list ]; then echo 55; else printf '%s\\n' "$*" >> '${unixDirectory}/gh-calls'; fi; }\n` +
        terminal?.bash;
      writeFileSync(join(directory, 'terminal.sh'), script);
      try {
        const result = spawnSync('bash', [join(directory, 'terminal.sh')], {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        });
        expect(result.status).toBe(pushed ? 0 : 1);
        if (!pushed) {
          const calls = readFileSync(join(directory, 'gh-calls'), 'utf8');
          expect(calls).toContain('pr ready 55 --repo thinmansoftware/bdc-harness --undo');
          expect(calls).toContain('NOT pushed');
          expect(calls).toContain('UNRESOLVED missing return type');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
