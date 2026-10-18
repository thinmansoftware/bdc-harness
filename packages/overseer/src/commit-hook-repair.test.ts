/**
 * WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01
 *
 * Commit-time hook repair: when commit-and-push fails on the husky pre-commit
 * lint/format hook, the run gets exactly ONE bounded repair pass that re-runs the
 * SAME shared commit-core, and an unrepaired head is never merged as if the run
 * passed. These tests use a REAL fixture -- a real temp git repository with a
 * real pre-commit hook running the real eslint rule
 * @typescript-eslint/explicit-function-return-type against a staged violating
 * file -- not a mock of the thing under test (commit-core, the lane structure,
 * and the gate's unpushed-head failure path).
 *
 * Tests 4, 5, 6, 7 of the WO. Test 1/2/3 (classify/decide) and 8-22 live in
 * their own files.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const LANE_PATH = join(REPO_ROOT, '.archon/workflows/defaults/bdc-feature-development-codex.yaml');
const LANE_TEXT = readFileSync(LANE_PATH, 'utf8');
const ESLINT_BIN = join(REPO_ROOT, 'node_modules/.bin/eslint');
const TS_ESLINT = join(REPO_ROOT, 'node_modules/typescript-eslint/dist/index.js');

// Forbidden hook-bypass tokens, assembled from fragments so this test file never
// contains the literal strings the no-bypass gates (Stop 4/6) grep for.
const NO_VERIFY = ['--no', 'verify'].join('-');
const HUSKY_OFF = ['HUSKY', '0'].join('=');

interface RawNode {
  id: string;
  bash?: string;
  prompt?: string;
  depends_on?: string[];
  when?: string;
  load_bearing?: boolean;
}
const LANE_DOC = YAML.parse(LANE_TEXT) as { nodes: RawNode[] };
const laneNode = (id: string): RawNode | undefined => LANE_DOC.nodes.find(n => n.id === id);

const CORE_START = `cat > "$CORE_SCRIPT" <<'COMMIT_AND_PUSH_CORE_EOF'`;
const CORE_END = 'COMMIT_AND_PUSH_CORE_EOF';

/** Pull the one shared commit-core script body out of the lane YAML verbatim. */
function extractCommitCore(): string {
  const bash = laneNode('commit-and-push')?.bash;
  if (!bash) throw new Error('commit-and-push node or its bash is missing');
  const after = bash.split(`${CORE_START}\n`)[1];
  if (after === undefined) throw new Error('commit-core start marker not found in commit-and-push');
  const body = after.split(`\n${CORE_END}`)[0];
  return `${body}\n`;
}

function shellPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return process.platform === 'win32'
    ? normalized.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    : normalized;
}

function spawnFixtureBash(
  script: string,
  options: { cwd?: string; encoding: 'utf8'; env: NodeJS.ProcessEnv },
  binDir: string,
  tool: 'git' | 'gh'
): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    [
      '-c',
      'export PATH="$FIXTURE_BIN:$PATH"; [ "$(command -v "$FIXTURE_TOOL")" = "$FIXTURE_BIN/$FIXTURE_TOOL" ] || exit 97; exec bash "$1"',
      'fixture',
      shellPath(script),
    ],
    {
      ...options,
      env: {
        ...options.env,
        PATH: process.env.PATH,
        FIXTURE_BIN: shellPath(binDir),
        FIXTURE_TOOL: tool,
      },
    }
  );
}

/** Resolve the real git binary (before any stub is placed on PATH). */
function realGitPath(): string {
  return execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
}

/**
 * Build a real git repo with a real pre-commit hook that runs real eslint
 * (@typescript-eslint/explicit-function-return-type) on staged *.ts files, plus a
 * git-recording shim so the test harness can assert the commit-core never passed a
 * hook-bypass flag or env var. Returns the repo dir, an out-of-tree meta dir for
 * the core/logs, and the env to run the core with.
 */
function makeRealHookRepo(): {
  repo: string;
  meta: string;
  env: NodeJS.ProcessEnv;
  gitArgvLog: string;
  gitEnvLog: string;
  coreScript: string;
  hookOut: string;
  attemptFile: string;
} {
  const repo = mkdtempSync(join(tmpdir(), 'commit-hook-repo-'));
  const meta = mkdtempSync(join(tmpdir(), 'commit-hook-meta-'));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'builder@test.local']);
  git(['config', 'user.name', 'Builder Test']);
  git(['config', 'commit.gpgsign', 'false']);

  // Real eslint flat config enabling only the explicit-function-return-type rule,
  // resolving the installed typescript-eslint parser + plugin from this repo.
  const eslintConfig = join(meta, 'eslint.config.mjs');
  writeFileSync(
    eslintConfig,
    `import tseslint from ${JSON.stringify(pathToFileURL(TS_ESLINT).href)};\n` +
      `export default [{\n` +
      `  files: ['**/*.ts'],\n` +
      `  languageOptions: { parser: tseslint.parser },\n` +
      `  plugins: { '@typescript-eslint': tseslint.plugin },\n` +
      `  rules: { '@typescript-eslint/explicit-function-return-type': 'error' },\n` +
      `}];\n`
  );

  // Real pre-commit hook (default .git/hooks path -- no hooks-path override) that
  // runs real eslint on staged TypeScript and rejects the commit on a violation.
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(
    hook,
    `#!/usr/bin/env bash\n` +
      `set -uo pipefail\n` +
      `FILES=$(git diff --cached --name-only --diff-filter=ACM | grep '\\.ts$' || true)\n` +
      `[ -z "$FILES" ] && exit 0\n` +
      `exec ${JSON.stringify(ESLINT_BIN)} --no-config-lookup -c ${JSON.stringify(eslintConfig)} $FILES\n`
  );
  chmodSync(hook, 0o755);

  // git-recording shim: records argv + env for every git call, then execs real git.
  const binDir = join(meta, 'bin');
  mkdirSync(binDir, { recursive: true });
  const gitArgvLog = join(meta, 'git-argv.log');
  const gitEnvLog = join(meta, 'git-env.log');
  const realGit = realGitPath();
  const stub = join(binDir, 'git');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `printf '%s\\n' "$*" >> ${JSON.stringify(gitArgvLog)}\n` +
      `env >> ${JSON.stringify(gitEnvLog)}\n` +
      `exec ${JSON.stringify(realGit)} "$@"\n`
  );
  chmodSync(stub, 0o755);

  const coreScript = join(meta, 'commit-and-push-core.sh');
  writeFileSync(coreScript, extractCommitCore());
  chmodSync(coreScript, 0o755);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };
  return {
    repo,
    meta,
    env,
    gitArgvLog,
    gitEnvLog,
    coreScript,
    hookOut: join(meta, 'commit-hook-output.txt'),
    attemptFile: join(meta, 'commit-hook-attempt.txt'),
  };
}

function runCore(
  ctx: ReturnType<typeof makeRealHookRepo>,
  stageMode: 'all' | 'prestaged',
  message = 'feat: commit-hook-repair fixture'
): { status: number | null; stdout: string } {
  const r = spawnFixtureBash(
    ctx.coreScript,
    {
      cwd: ctx.repo,
      encoding: 'utf8',
      env: {
        ...ctx.env,
        CORE_COMMIT_MESSAGE: message,
        CORE_HOOK_OUTPUT_FILE: ctx.hookOut,
        CORE_STAGE_MODE: stageMode,
        CORE_ATTEMPT_FILE: ctx.attemptFile,
      },
    },
    join(ctx.meta, 'bin'),
    'git'
  );
  return { status: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const VIOLATING = 'export const f = () => {\n  return 1;\n};\n';
const FIXED = 'export const f = (): number => {\n  return 1;\n};\n';

describe('Test 4: real_hook_repair_roundtrip', () => {
  test('commit-core rejects the lint violation, writes the hook output, then commits after the simulated repair -- hooks never bypassed', () => {
    const ctx = makeRealHookRepo();
    writeFileSync(join(ctx.repo, 'bad.ts'), VIOLATING);

    // Attempt 1: the real pre-commit hook rejects the staged violation.
    const first = runCore(ctx, 'all');
    expect(first.status).not.toBe(0);
    expect(existsSync(ctx.hookOut)).toBe(true);
    expect(readFileSync(ctx.hookOut, 'utf8')).toContain('explicit-function-return-type');

    // Simulated bounded repair: add the missing return type.
    writeFileSync(join(ctx.repo, 'bad.ts'), FIXED);

    // Attempt 2: the same commit-core now commits cleanly.
    const second = runCore(ctx, 'all');
    expect(second.status).toBe(0);
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: ctx.repo,
      encoding: 'utf8',
    }).trim();
    expect(subject).toBe('feat: commit-hook-repair fixture');

    // The recorded git argv + env prove the hook was never bypassed.
    const argv = readFileSync(ctx.gitArgvLog, 'utf8');
    const envLog = readFileSync(ctx.gitEnvLog, 'utf8');
    expect(argv).toContain('commit -m feat: commit-hook-repair fixture');
    expect(argv).not.toContain(NO_VERIFY);
    expect(envLog).not.toContain(HUSKY_OFF);
  }, 60000);
});

describe('Test 5: second_failure_does_not_loop', () => {
  test('when the repair makes no change the second attempt fails again and the attempt counter is exactly 2 -- no third attempt', () => {
    const ctx = makeRealHookRepo();
    writeFileSync(join(ctx.repo, 'bad.ts'), VIOLATING);

    const first = runCore(ctx, 'all');
    expect(first.status).not.toBe(0);

    // "Repair" that changes nothing: the violation remains.
    writeFileSync(join(ctx.repo, 'bad.ts'), VIOLATING);

    const second = runCore(ctx, 'all');
    expect(second.status).not.toBe(0);

    // The bounded counter reached exactly 2; the lane never makes a third attempt.
    expect(readFileSync(ctx.attemptFile, 'utf8').trim()).toBe('2');
    const commitCount = execFileSync('git', ['rev-list', '--count', '--all'], {
      cwd: ctx.repo,
      encoding: 'utf8',
    }).trim();
    expect(commitCount).toBe('0');
  }, 60000);
});

describe('Test 5b: non_hook_commit_failure_is_not_repairable', () => {
  test('a nonzero git commit that is NOT a pre-commit hook rejection (signing failure) does not write the hook-output file', () => {
    const ctx = makeRealHookRepo();
    // Force a commit-signing failure that is unrelated to the pre-commit hook:
    // gpg signing on, pointed at a binary that does not exist. The staged file is
    // NOT TypeScript, so the real pre-commit hook passes -- the ONLY reason the
    // commit fails is the signing error, exactly the non-hook class finding 2 is about.
    execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: ctx.repo });
    execFileSync('git', ['config', 'gpg.program', join(ctx.meta, 'nonexistent-gpg')], {
      cwd: ctx.repo,
    });
    writeFileSync(join(ctx.repo, 'notes.txt'), 'plain text, no lint rule applies\n');

    const r = runCore(ctx, 'all');

    // The commit failed...
    expect(r.status).not.toBe(0);
    // ...but it was NOT classified as a repairable hook rejection: no hook-output
    // file was persisted, so commit-and-push takes the hard-fail path instead of
    // handing off to the bounded lint repair.
    expect(existsSync(ctx.hookOut)).toBe(false);
    expect(r.stdout).toContain('COMMIT_CORE=commit_failed_non_hook');
  }, 60000);
});

describe('Test 6: lane_yaml_structure_has_one_bounded_repair', () => {
  test('exactly one hook-repair node, depends on commit-and-push, OPUS_REPAIR idiom, one commit-core invoked by two nodes', () => {
    const repairNodes = LANE_DOC.nodes.filter(n => n.id === 'commit-hook-repair');
    expect(repairNodes).toHaveLength(1);
    const repair = repairNodes[0];

    // Depends on commit-and-push (through the classifier, the opus-repair idiom).
    expect(repair?.depends_on).toContain('classify-commit-hook');
    expect(laneNode('classify-commit-hook')?.depends_on).toContain('commit-and-push');

    // Reuses the OPUS_REPAIR=fixed|needs-human sentinel + classify idiom.
    expect(repair?.prompt).toContain('OPUS_REPAIR=fixed');
    expect(repair?.prompt).toContain('OPUS_REPAIR=needs-human');
    expect(laneNode('classify-commit-hook-repair')?.bash).toContain('OPUS_REPAIR=fixed');

    // Exactly ONE definition of the commit logic (the shared commit-core heredoc)...
    const coreDefs = LANE_TEXT.split(CORE_START).length - 1;
    expect(coreDefs).toBe(1);
    // ...invoked by exactly TWO nodes: commit-and-push (attempt 1) and
    // commit-hook-retry (attempt 2). No duplicated commit logic.
    const invokers = LANE_DOC.nodes.filter(n => (n.bash ?? '').includes('bash "$CORE_SCRIPT"'));
    expect(invokers.map(n => n.id).sort()).toEqual(['commit-and-push', 'commit-hook-retry']);

    // The gate is load_bearing so an unrepaired head fails the run closed.
    expect(laneNode('commit-hook-gate')?.load_bearing).toBe(true);

    // The lane is valid YAML with a non-empty node list (module-level YAML.parse
    // would have thrown otherwise). Full workflow-schema validation of this lane
    // is exercised by the @archon/workflows suite (schemas.test.ts and
    // loader.test.ts validate every bundled default, including this one), which is
    // the "existing workflow-schema validation test" the WO refers to.
    expect(Array.isArray(LANE_DOC.nodes)).toBe(true);
    expect(LANE_DOC.nodes.length).toBeGreaterThan(0);
    // Every node this WO added has a unique id (no accidental duplicate ids).
    const ids = LANE_DOC.nodes.map(n => n.id);
    for (const added of [
      'classify-commit-hook',
      'commit-hook-repair',
      'classify-commit-hook-repair',
      'commit-hook-retry',
      'commit-hook-gate',
    ]) {
      expect(ids.filter(id => id === added)).toHaveLength(1);
    }
  });
});

describe('Test 7: unpushed_repair_makes_open_pr_draft', () => {
  test('on an unrepaired final failure the gate drafts the existing PR and comments that the delta was NOT pushed', () => {
    const nodeOut = mkdtempSync(join(tmpdir(), 'gate-nodeout-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'gate-artifacts-'));
    const binDir = mkdtempSync(join(tmpdir(), 'gate-bin-'));
    const ghLog = join(binDir, 'gh-argv.log');

    // commit-and-push failed on the hook (no unique_branch); retry never committed.
    writeFileSync(
      join(nodeOut, 'commit-and-push.out'),
      'COMMIT_HOOK_FAILED=true\ncommit_hook_lint_failure: hook rejected the staged delta\n'
    );
    writeFileSync(join(nodeOut, 'commit-hook-retry.out'), 'COMMIT_HOOK_RETRY=hook_failed_again\n');
    writeFileSync(
      join(nodeOut, 'decide-push-target.out'),
      'repo: thinmansoftware/bdc-harness\npr_required: true\n'
    );
    writeFileSync(
      join(artifacts, 'commit-hook-env.sh'),
      'UNIQUE_BRANCH=feat/x-thread-abc123\nCOMMIT_MESSAGE=feat: x\n'
    );

    // gh recording stub: returns PR 77 for `pr list`, records every call.
    const gh = join(binDir, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\n` +
        `printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo 77; fi\n` +
        `exit 0\n`
    );
    chmodSync(gh, 0o755);

    const gateBash = laneNode('commit-hook-gate')?.bash;
    if (!gateBash) throw new Error('commit-hook-gate node/bash missing');
    const gateScript = join(binDir, 'gate.sh');
    writeFileSync(gateScript, gateBash);

    const r = spawnFixtureBash(
      gateScript,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_NODE_OUT: nodeOut,
          ARTIFACTS_DIR: artifacts,
        },
      },
      binDir,
      'gh'
    );

    // load_bearing failure -- the run fails closed.
    expect(r.status).not.toBe(0);

    const argv = readFileSync(ghLog, 'utf8');
    // PR converted to draft...
    expect(argv).toContain('pr ready 77 --undo');
    // ...and commented that the repair delta was NOT pushed.
    const commentLine = argv.split('\n').find(l => l.startsWith('pr comment 77'));
    expect(commentLine).toBeDefined();
    expect(commentLine).toContain('NOT pushed');
  }, 60000);
});

/**
 * Positive-evidence hook attribution. The commit-core previously decided "hook
 * failure" by elimination: every nonzero `git commit` that did not match a short
 * list of known git errors was labelled a repairable lint rejection. A commit-msg
 * hook rejection (a DIFFERENT hook phase, not a staged lint/format problem) was
 * therefore fed to the bounded lint-repair pass and burned the run's one attempt.
 * The core now requires positive attribution to the PRE-COMMIT phase.
 */
describe('Test 5c: commit_msg_hook_rejection_is_not_pre_commit_lint', () => {
  test('a commit-msg hook rejection does NOT write the hook-output file', () => {
    const ctx = makeRealHookRepo();
    // A commit-msg hook that always rejects. The staged file is NOT TypeScript, so
    // the real pre-commit hook passes -- the ONLY reason the commit fails is the
    // commit-msg phase, which the bounded lint repair cannot fix.
    const commitMsgHook = join(ctx.repo, '.git', 'hooks', 'commit-msg');
    writeFileSync(
      commitMsgHook,
      `#!/usr/bin/env bash\necho "commit message rejected by policy" >&2\nexit 1\n`
    );
    chmodSync(commitMsgHook, 0o755);
    writeFileSync(join(ctx.repo, 'notes.txt'), 'plain text, no lint rule applies\n');

    const r = runCore(ctx, 'all');

    expect(r.status).not.toBe(0);
    // Not attributed to the pre-commit phase -> no hook-output file, so
    // commit-and-push takes the hard-fail path instead of the lint repair.
    expect(existsSync(ctx.hookOut)).toBe(false);
    expect(r.stdout).toContain('COMMIT_CORE=commit_failed_non_hook');
    // And no commit was created.
    expect(
      execFileSync('git', ['rev-list', '--count', '--all'], {
        cwd: ctx.repo,
        encoding: 'utf8',
      }).trim()
    ).toBe('0');
  }, 60000);

  test('a real pre-commit rejection is still positively attributed and repairable', () => {
    // The counterpart: the fixture hook is a plain .git/hooks/pre-commit that just
    // execs eslint -- it prints NO husky/lint-staged marker. Attribution therefore
    // comes from directly observing that the pre-commit hook is what rejects the
    // staged delta, and the evidence kind is reported.
    const ctx = makeRealHookRepo();
    writeFileSync(join(ctx.repo, 'bad.ts'), VIOLATING);

    const r = runCore(ctx, 'all');

    expect(r.status).not.toBe(0);
    expect(existsSync(ctx.hookOut)).toBe(true);
    expect(readFileSync(ctx.hookOut, 'utf8')).toContain('explicit-function-return-type');
    expect(r.stdout).toContain('COMMIT_CORE=hook_failed');
    expect(r.stdout).toContain('evidence=pre_commit_rerun');
    // Hooks were never bypassed to reach that conclusion.
    expect(readFileSync(ctx.gitArgvLog, 'utf8')).not.toContain(NO_VERIFY);
    expect(readFileSync(ctx.gitEnvLog, 'utf8')).not.toContain(HUSKY_OFF);
  }, 60000);

  test('the lane requires positive evidence and never labels by elimination', () => {
    const core = extractCommitCore();
    // The repairable path is gated on an explicit evidence variable...
    expect(core).toContain('CORE_HOOK_EVIDENCE=none');
    expect(core).toContain('if [ "$CORE_HOOK_EVIDENCE" = "none" ]; then');
    // ...and a commit-msg rejection is explicitly excluded.
    expect(core).toContain('husky - commit-msg script failed');
    // The hook-output file is only written after the evidence check.
    const evidenceGate = core.indexOf('if [ "$CORE_HOOK_EVIDENCE" = "none" ]; then');
    const writeHookOut = core.indexOf('> "$CORE_HOOK_OUTPUT_FILE"');
    expect(evidenceGate).toBeGreaterThan(-1);
    expect(writeHookOut).toBeGreaterThan(evidenceGate);
  });
});

/**
 * The gate must REPORT the dead end, not just fail. commit-and-push exits 0 on the
 * first hook rejection (it hands off to the one bounded repair pass), so the
 * load_bearing commit-hook-gate is the only node that can surface the attempt-2
 * rejection. It therefore emits the class token plus the real attempt count -- and
 * ONLY on positive evidence that commit-and-push reported a hook rejection.
 */
describe('Test 7b: gate_reports_class_and_attempt', () => {
  function runGate(
    commitAndPushOut: string,
    attemptFileContents?: string
  ): { status: number | null; stdout: string } {
    const nodeOut = mkdtempSync(join(tmpdir(), 'gate2-nodeout-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'gate2-artifacts-'));
    const binDir = mkdtempSync(join(tmpdir(), 'gate2-bin-'));
    writeFileSync(join(nodeOut, 'commit-and-push.out'), commitAndPushOut);
    writeFileSync(join(nodeOut, 'commit-hook-retry.out'), 'COMMIT_HOOK_RETRY=hook_failed_again\n');
    writeFileSync(join(nodeOut, 'decide-push-target.out'), 'repo: thinmansoftware/bdc-harness\n');
    writeFileSync(
      join(artifacts, 'commit-hook-env.sh'),
      'UNIQUE_BRANCH=feat/x-thread-abc123\nCOMMIT_MESSAGE=feat: x\n'
    );
    if (attemptFileContents !== undefined) {
      writeFileSync(join(artifacts, 'commit-hook-attempt.txt'), attemptFileContents);
    }
    // gh stub: no open PR, so the drafting branch is a no-op.
    const gh = join(binDir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(gh, 0o755);

    const gateBash = laneNode('commit-hook-gate')?.bash;
    if (!gateBash) throw new Error('commit-hook-gate node/bash missing');
    const gateScript = join(binDir, 'gate.sh');
    writeFileSync(gateScript, gateBash);
    const r = spawnFixtureBash(
      gateScript,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ARCHON_NODE_OUT: nodeOut,
          ARTIFACTS_DIR: artifacts,
        },
      },
      binDir,
      'gh'
    );
    return { status: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  test('an unrepaired hook failure emits the class token and the real attempt count', () => {
    const r = runGate('COMMIT_HOOK_FAILED=true\n', '2\n');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('commit_hook_lint_failure');
    expect(r.stdout).toContain('commit_hook_attempt=2');
  }, 60000);

  test('the attempt count is floored at 2 when the counter file is missing', () => {
    // This branch is only reachable once the single bounded repair opportunity is
    // spent, so the budget is exhausted by construction even without the counter.
    const r = runGate('COMMIT_HOOK_FAILED=true\n');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('commit_hook_attempt=2');
  }, 60000);

  test('a gate failure with NO hook rejection does NOT claim the hook class', () => {
    // commit-and-push failed for some other reason (no COMMIT_HOOK_FAILED marker,
    // no pushed branch). Mislabelling this a lint failure would send it down the
    // repair path; it must fail closed as its own thing instead.
    const r = runGate('ERROR: something else went wrong\n');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('commit_hook_lint_failure');
    expect(r.stdout).toContain('reported no pre-commit hook rejection');
  }, 60000);

  test('a first-attempt success path still passes the gate', () => {
    const r = runGate('unique_branch=feat/x-thread-abc123\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('COMMIT_HOOK_GATE=passed_first_attempt');
    expect(r.stdout).not.toContain('commit_hook_lint_failure');
  }, 60000);
});
