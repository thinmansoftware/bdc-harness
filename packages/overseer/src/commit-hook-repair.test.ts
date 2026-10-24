import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { classifyError } from './classify';
import { decide } from './decide';
import { evaluateCondition } from '../../workflows/src/condition-evaluator';

const root = join(import.meta.dir, '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

function hookFixture(): {
  directory: string;
  repo: string;
  artifacts: string;
  run: (attempt: number) => ReturnType<typeof spawnSync>;
  runInitialNode: () => ReturnType<typeof spawnSync>;
  runRetryNode: () => ReturnType<typeof spawnSync>;
} {
  const directory = mkdtempSync(join(tmpdir(), 'real-hook-repair-'));
  const repo = join(directory, 'repo');
  const artifacts = join(directory, 'artifacts');
  mkdirSync(repo);
  mkdirSync(artifacts);
  const env = { ...process.env, HUSKY: undefined };
  const command = (program: string, args: string[]): void => {
    const result = spawnSync(program, args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (result.status !== 0)
      throw new Error(`fixture command failed: ${program}: ${result.stderr}`);
  };
  command('git', ['init']);
  command('git', ['config', 'user.name', 'Harness fixture']);
  command('git', ['config', 'user.email', 'fixture@example.invalid']);
  command('node', [join(root, 'node_modules/husky/bin.js')]);
  const unix = (path: string): string => path.replaceAll('\\', '/');
  writeFileSync(
    join(repo, '.husky/pre-commit'),
    `node '${unix(join(root, 'node_modules/eslint/bin/eslint.js'))}' fixture.ts --config eslint.config.mjs\n`
  );
  writeFileSync(
    join(repo, 'eslint.config.mjs'),
    `import tseslint from ${JSON.stringify(pathToFileURL(join(root, 'node_modules/typescript-eslint/dist/index.js')).href)};
     export default [{files:['**/*.ts'],languageOptions:{parser:tseslint.parser},
       plugins:{'@typescript-eslint':tseslint.plugin},rules:{'@typescript-eslint/explicit-function-return-type':'error'}}];\n`
  );
  writeFileSync(join(repo, 'fixture.ts'), 'export function value() { return 1; }\n');
  const script = join(directory, 'invoke.sh');
  writeFileSync(
    script,
    `set -euo pipefail\nexport UNIQUE_BRANCH=fixture ARTIFACTS_DIR='${unix(artifacts)}'\n` +
      `git() { printf '%s\\n' "$*" >> '${unix(artifacts)}/git-argv'; ` +
      `printf '%s\\n' "\x24{HUSKY-unset}" >> '${unix(artifacts)}/hook-env'; ` +
      `case "$1" in push) return 0;; ls-remote) printf '%s\\trefs/heads/fixture\\n' "$(command git rev-parse HEAD)";; *) command git "$@";; esac; }\n` +
      `source '${unix(join(root, '.archon/scripts/commit-and-push.sh'))}' "$1"\n`
  );
  return {
    directory,
    repo,
    artifacts,
    runRetryNode: () => {
      const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
        nodes: { id: string; bash?: string }[];
      };
      const bash = lane.nodes.find(node => node.id === 'commit-and-push-retry')?.bash;
      if (!bash) throw new Error('retry caller missing');
      const original = readFileSync(script, 'utf8');
      const prefix = original.slice(0, original.indexOf("source '"));
      const retry = join(directory, 'retry-node.sh');
      writeFileSync(retry, prefix + 'export -f git\n' + bash + '\n');
      return spawnSync('bash', [retry], {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      });
    },
    runInitialNode: () => {
      const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
        nodes: { id: string; bash?: string }[];
      };
      const bash = lane.nodes.find(node => node.id === 'commit-and-push')?.bash ?? '';
      const start = bash.indexOf('git status --short\nWO_ID=');
      const end = bash.indexOf('\nDIRTY=', start);
      if (start < 0 || end < 0) throw new Error('initial hook caller markers missing');
      const original = readFileSync(script, 'utf8');
      const prefix = original.slice(0, original.indexOf("source '"));
      const initial = join(directory, 'initial.sh');
      writeFileSync(initial, prefix + 'export -f git\n' + bash.slice(start, end) + '\n');
      return spawnSync('bash', [initial], {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      });
    },
    run: attempt =>
      spawnSync('bash', [script, String(attempt)], {
        cwd: repo,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      }),
  };
}

const hookFailure = `lint-staged\n[FAILED] eslint\npackages/server/src/taskmaster/loop.ts 1419:19 error Missing return type on function @typescript-eslint/explicit-function-return-type\nhusky - pre-commit script failed`;

describe('commit hook repair contract', () => {
  test('actual initial caller carries its helper into a target repo without Harness files', () => {
    const fixture = hookFixture();
    try {
      const first = fixture.runInitialNode();
      expect(first.status, first.stderr).toBe(1);
      expect(readFileSync(join(fixture.artifacts, 'commit-hook-output.txt'), 'utf8')).toContain(
        'explicit-function-return-type'
      );
      expect(existsSync(join(fixture.repo, '.archon'))).toBe(false);
      expect(readFileSync(join(fixture.artifacts, 'commit-and-push.sh'), 'utf8')).toBe(
        read('.archon/scripts/commit-and-push.sh').replace(/\r\n/g, '\n')
      );
      writeFileSync(
        join(fixture.repo, 'fixture.ts'),
        'export function value(): number { return 1; }\n'
      );
      const retry = fixture.runRetryNode();
      expect(retry.status, retry.stderr).toBe(0);
      expect(existsSync(join(fixture.artifacts, 'commit-and-push.succeeded'))).toBe(true);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
  test('open PR consumes the successful retry branch and refreshed lease', () => {
    const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
      nodes: { id: string; bash?: string }[];
    };
    const opener = lane.nodes.find(node => node.id === 'open-pr-if-needed')?.bash ?? '';
    const start = opener.indexOf('COMMIT_PUSH_OUTPUT=');
    const end = opener.indexOf('# WO-HARNESS-OPEN-PR-ORIGIN-WAIT-01', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const directory = mkdtempSync(join(tmpdir(), 'hook-open-pr-'));
    try {
      writeFileSync(join(directory, 'commit-and-push.out'), 'pre-commit hook failed\n');
      writeFileSync(
        join(directory, 'commit-and-push-retry.out'),
        'unique_branch=repair-existing\nREPAIR_TARGET_LEASE_SHA=fresh-head\n'
      );
      const script =
        `set -euo pipefail\nexport ARCHON_NODE_OUT='${directory.replaceAll('\\', '/')}'\nDECIDE_OUTPUT='pr_required: true'\n` +
        opener.slice(start, end) +
        '\nprintf "%s:%s\\n" "$UNIQUE_BRANCH" "$REPAIR_TARGET_LEASE_SHA"\n';
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('repair-existing:fresh-head');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
    const fixture = hookFixture();
    try {
      writeFileSync(join(fixture.repo, 'space file.ts'), 'export const kept = true;\n');
      expect(fixture.run(1).status).toBe(1);
      expect(readFileSync(join(fixture.artifacts, 'commit-hook-output.txt'), 'utf8')).toContain(
        'explicit-function-return-type'
      );
      writeFileSync(
        join(fixture.repo, 'fixture.ts'),
        'export function value(): number { return 1; }\n'
      );
      writeFileSync(join(fixture.repo, 'unrelated.ts'), 'export const unrelated = true;\n');
      expect(fixture.run(2).status).toBe(0);
      const commit = spawnSync('git', ['log', '-1', '--format=%s'], {
        cwd: fixture.repo,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(commit.stdout.trim()).toBe('feat: work order implementation');
      const files = spawnSync('git', ['show', '--format=', '--name-only', 'HEAD'], {
        cwd: fixture.repo,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(files.stdout).toContain('space file.ts');
      expect(files.stdout).not.toContain('unrelated.ts');
      expect(readFileSync(join(fixture.artifacts, 'git-argv'), 'utf8')).not.toMatch(
        /--no-verify|--no-hooks/
      );
      expect(
        readFileSync(join(fixture.artifacts, 'hook-env'), 'utf8').split('\n').filter(Boolean)
      ).toEqual(
        Array(
          readFileSync(join(fixture.artifacts, 'hook-env'), 'utf8').split('\n').filter(Boolean)
            .length
        ).fill('unset')
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test('a second real hook failure remains failed with the attempt counter at two', () => {
    const fixture = hookFixture();
    try {
      expect(fixture.run(1).status).toBe(1);
      expect(fixture.run(2).status).toBe(1);
      expect(readFileSync(join(fixture.artifacts, 'commit-hook-attempt.txt'), 'utf8').trim()).toBe(
        '2'
      );
      const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: fixture.repo,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(head.status).not.toBe(0);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
  test('a successful clean initial push skips the real retry node and an empty path record is valid', () => {
    const fixture = hookFixture();
    try {
      writeFileSync(
        join(fixture.repo, 'fixture.ts'),
        'export function value(): number { return 1; }\n'
      );
      for (const args of [
        ['add', '.'],
        ['commit', '-m', 'bootstrap'],
      ]) {
        const result = spawnSync('git', args, {
          cwd: fixture.repo,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        });
        expect(result.status).toBe(0);
      }
      expect(fixture.run(1).status).toBe(0);
      const paths = join(fixture.artifacts, 'commit-hook-staged-paths.nul');
      expect(readFileSync(paths).length).toBe(0);
      const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
        nodes: { id: string; bash?: string }[];
      };
      const retry = lane.nodes.find(node => node.id === 'commit-and-push-retry')?.bash;
      expect(retry).toBeDefined();
      const result = spawnSync(
        'bash',
        ['-c', `export ARTIFACTS_DIR='${fixture.artifacts.replaceAll('\\', '/')}';\n${retry}`],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }
      );
      expect(result.status).toBe(0);
      expect(readFileSync(join(fixture.artifacts, 'commit-hook-attempt.txt'), 'utf8').trim()).toBe(
        '1'
      );
      // A deliberate replay with no paths is a valid no-op; an absent record is not.
      expect(fixture.run(2).status).toBe(0);
      rmSync(paths);
      expect(fixture.run(2).status).toBe(1);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  test('second_failure_does_not_loop', () => {
    const lane = read('.archon/workflows/defaults/bdc-feature-development-codex.yaml');
    expect(lane).toContain('bash "$ARTIFACTS_DIR/commit-and-push.sh" 1');
    expect(lane).toContain('bash "$ARTIFACTS_DIR/commit-and-push.sh" 2');
    expect(lane).not.toContain('bash "$ARTIFACTS_DIR/commit-and-push.sh" 3');
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

  test('hook recovery preserves the repair authorization gate for every outcome', () => {
    const lane = parse(read('.archon/workflows/defaults/bdc-feature-development-codex.yaml')) as {
      nodes: { id: string; depends_on?: string[]; when?: string }[];
    };
    for (const id of [
      'commit-hook-repair',
      'classify-commit-hook-repair',
      'commit-and-push-retry',
      'commit-hook-terminal',
      'open-pr-if-needed',
    ]) {
      const node = lane.nodes.find(item => item.id === id)!;
      expect(node.depends_on).toContain('repair-gate');
      for (const allow of [undefined, 'malformed', 'no', 'yes']) {
        for (const verdict of [undefined, 'fixed', 'already_satisfied', 'needs_human', 'unknown']) {
          const outputs = new Map([
            [
              'classify-commit-hook-repair',
              { state: 'completed' as const, output: JSON.stringify({ verdict }) },
            ],
          ]);
          if (allow !== undefined) {
            outputs.set('repair-gate', {
              state: 'completed',
              output: allow === 'malformed' ? '{' : JSON.stringify({ REPAIR_GATE_ALLOW: allow }),
            });
          }
          const result = evaluateCondition(node.when ?? '', outputs);
          expect(result.parsed).toBe(true);
          expect(result.result).toBe(
            allow === 'yes' &&
              (id !== 'commit-and-push-retry' ||
                verdict === 'fixed' ||
                verdict === 'already_satisfied')
          );
        }
      }
    }
  });

  for (const repairState of [
    'needs_human',
    'classification_failed',
    'retry_failed',
    'missing_env',
    'pushed',
  ]) {
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
      expect(terminal?.when).toBe("$repair-gate.output.REPAIR_GATE_ALLOW == 'yes'");
      expect(lane.nodes.find(node => node.id === 'open-pr-if-needed')?.depends_on).toEqual([
        'commit-hook-terminal',
        'repair-gate',
      ]);
      const directory = mkdtempSync(join(tmpdir(), 'hook-terminal-'));
      const unixDirectory = directory.replaceAll('\\', '/');
      const pushed = repairState === 'pushed';
      if (repairState !== 'missing_env') {
        writeFileSync(join(directory, 'commit-and-push.env'), 'UNIQUE_BRANCH=repair-branch\n');
      }
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
        if (!pushed && repairState !== 'missing_env') {
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
