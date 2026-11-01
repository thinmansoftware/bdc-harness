import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

const LANE_FILES = [
  'bdc-feature-development.yaml',
  'bdc-feature-development-astra.yaml',
  'bdc-feature-development-codex.yaml',
  'bdc-feature-development-codex-only.yaml',
  'bdc-feature-development-cursor.yaml',
  'bdc-feature-development-fable.yaml',
  'bdc-feature-development-fusion-cx-kimi.yaml',
  'bdc-feature-development-fusion-cx-qwen.yaml',
  'bdc-feature-development-grok.yaml',
  'bdc-feature-development-kimi-k3.yaml',
  'bdc-feature-development-zero.yaml',
  'bdc-feature-development-zero-claude.yaml',
  'bdc-feature-development-zero-open.yaml',
] as const;

const DEFAULTS_DIR = join(import.meta.dir, '../../../../.archon/workflows/defaults');
const BUNDLE_PATH = join(import.meta.dir, '../defaults/bundled-defaults.generated.ts');
const GUARD_BEGIN = '# existing-pr-base-guard: begin';
const GUARD_END = '# existing-pr-base-guard: end';

/** Fixed head SHA S used by every same-head scenario. */
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const UNIQUE_BRANCH = 'feat/wo-x-thread-abc';
const PR_URL_10 = 'https://github.com/acme/widgets/pull/10';
const PR_URL_11 = 'https://github.com/acme/widgets/pull/11';

interface OpenPr {
  number: number;
  title: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

function openPr(input: OpenPr): OpenPr {
  return input;
}

/** REST shape returned by `gh api --paginate --slurp repos/.../pulls`. */
interface RestPull {
  number: number;
  title: string;
  html_url: string;
  head: { sha: string; ref: string };
  base: { ref: string };
}

function restPull(input: {
  number: number;
  title: string;
  sha: string;
  ref: string;
  base: string;
  url: string;
}): RestPull {
  return {
    number: input.number,
    title: input.title,
    html_url: input.url,
    head: { sha: input.sha, ref: input.ref },
    base: { ref: input.base },
  };
}

function fillerPull(n: number): RestPull {
  return restPull({
    number: 1000 + n,
    title: `Other ${n}`,
    sha: OTHER_SHA,
    ref: `other-${n}`,
    base: 'dev',
    url: `https://github.com/acme/widgets/pull/${1000 + n}`,
  });
}

const PR_URL_4 = 'https://github.com/acme/widgets/pull/4';
const PR_URL_900 = 'https://github.com/acme/widgets/pull/900';

/**
 * YAML block-scalar dedent of the shipped existing-PR guard, matching
 * run-branch-identity.test.ts. The bytes executed are the workflow's, not a retype.
 */
function existingPrGuard(yaml: string): string {
  const text = yaml.replace(/\r\n/g, '\n');
  const at = text.indexOf(GUARD_BEGIN);
  const end = text.indexOf(GUARD_END);
  if (at < 0 || end < at) {
    throw new Error('existing-pr-base-guard markers missing');
  }
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const endLine = text.lastIndexOf('\n', end);
  const chunk = text.slice(lineStart, endLine);
  const lines = chunk.split('\n');
  const widths = lines
    .filter(line => line.trim().length > 0)
    .map(line => line.length - line.trimStart().length);
  const min = Math.min(...widths);
  return lines.map(line => (line.startsWith(' '.repeat(min)) ? line.slice(min) : line)).join('\n');
}

function laneGuard(file: string): string {
  return existingPrGuard(readFileSync(join(DEFAULTS_DIR, file), 'utf8'));
}

/**
 * Git Bash form of a Windows directory. `C:\foo` and `C:/foo` both become `/c/foo`.
 */
function toGitBashDir(dir: string): string {
  return dir
    .replace(/\\/g, '/')
    .replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
}

interface GuardRun {
  code: number;
  stdout: string;
  stderr: string;
  args: string;
  createArgs: string;
  creates: number;
}

function runOpenPrGuard(guard: string, sameHeadJson: string, sameHeadRc: number): GuardRun {
  const dir = mkdtempSync(join(tmpdir(), 'same-head-adopt-'));
  try {
    const sameHeadPath = join(dir, 'same-head.json');
    const argsLog = join(dir, 'args.log');
    const createArgs = join(dir, 'create.args');
    const createCount = join(dir, 'create.count');
    writeFileSync(sameHeadPath, sameHeadJson);
    writeFileSync(argsLog, '');
    writeFileSync(createArgs, '');
    writeFileSync(createCount, '0');
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/bash',
        'printf \'%s\\n\' "$*" >> "$GH_ARGS_LOG"',
        'if [ "$1" = "api" ]; then',
        '  case "$*" in',
        '    *--paginate*--slurp*|*--slurp*--paginate*)',
        '      if [ "$GH_SAME_HEAD_RC" -ne 0 ]; then',
        '        exit "$GH_SAME_HEAD_RC"',
        '      fi',
        '      python3 - "$GH_SAME_HEAD_JSON" <<\'PY\'',
        'import json, sys',
        'with open(sys.argv[1], encoding="utf-8") as fh:',
        '    data = json.load(fh)',
        'if not isinstance(data, list):',
        '    data = []',
        'pages = [data[i:i + 100] for i in range(0, len(data), 100)]',
        'json.dump(pages, sys.stdout)',
        'sys.stdout.write("\\n")',
        'PY',
        '      exit $?',
        '      ;;',
        '  esac',
        '  echo "unexpected gh api: $*" >&2',
        '  exit 97',
        'fi',
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
        '  case "$*" in',
        '    *headRefOid*)',
        '      if [ "$GH_SAME_HEAD_RC" -ne 0 ]; then',
        '        exit "$GH_SAME_HEAD_RC"',
        '      fi',
        '      python3 - "$GH_SAME_HEAD_JSON" <<\'PY\'',
        'import json, sys',
        'with open(sys.argv[1], encoding="utf-8") as fh:',
        '    data = json.load(fh)',
        'if not isinstance(data, list):',
        '    data = []',
        'json.dump(data[:200], sys.stdout)',
        'sys.stdout.write("\\n")',
        'PY',
        '      exit $?',
        '      ;;',
        '  esac',
        "  printf '%s\\n' '[]'",
        '  exit 0',
        'fi',
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
        '  n=$(cat "$GH_CREATE_COUNT")',
        '  n=$((n + 1))',
        '  printf \'%s\' "$n" > "$GH_CREATE_COUNT"',
        '  printf \'%s\\n\' "$*" >> "$GH_CREATE_ARGS"',
        "  printf '%s\\n' 'https://github.com/acme/widgets/pull/created'",
        '  exit 0',
        'fi',
        'echo "unexpected gh: $*" >&2',
        'exit 96',
        '',
      ].join('\n')
    );
    chmodSync(gh, 0o755);
    const sleep = join(dir, 'sleep');
    writeFileSync(sleep, '#!/bin/bash\nexit 0\n');
    chmodSync(sleep, 0o755);
    const bashDir = process.platform === 'win32' ? toGitBashDir(dir) : dir;
    const script = join(dir, 'guard.sh');
    writeFileSync(
      script,
      ['set -euo pipefail', `export PATH='${bashDir}':"$PATH"`, guard, ''].join('\n')
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      GH_ARGS_LOG: argsLog,
      GH_CREATE_ARGS: createArgs,
      GH_CREATE_COUNT: createCount,
      GH_SAME_HEAD_JSON: sameHeadPath,
      GH_SAME_HEAD_RC: String(sameHeadRc),
      REPO: 'acme/widgets',
      TITLE: 't',
      BODY_FILE: '/dev/null',
      BASE_BRANCH: 'dev',
      RECORDED_BASE_BRANCH: 'dev',
      UNIQUE_BRANCH,
      LOCAL_HEAD: HEAD_SHA,
    };
    if (process.platform === 'win32') {
      for (const key of Object.keys(env)) {
        if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
      }
    }
    const result = Bun.spawnSync(['bash', script], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      code: result.exitCode ?? -1,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      args: readFileSync(argsLog, 'utf8'),
      createArgs: readFileSync(createArgs, 'utf8'),
      creates: Number(readFileSync(createCount, 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('open-pr same-head adopt', () => {
  const guard = laneGuard('bdc-feature-development-cursor.yaml');

  test('Test 1: same-head PR on another branch is adopted', () => {
    const result = runOpenPrGuard(
      guard,
      JSON.stringify([
        openPr({
          number: 10,
          title: 'Already open',
          headRefOid: HEAD_SHA,
          headRefName: 'archon/task-web-worker-x',
          baseRefName: 'dev',
          url: PR_URL_10,
        }),
      ]),
      0
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(0);
    expect(result.args).not.toContain('pr create');
    expect(result.stdout).toContain(`PR_URL=${PR_URL_10}`);
    expect(result.stdout).toContain(
      `open-pr: adopted existing PR ${PR_URL_10} at head ${HEAD_SHA}`
    );
    expect(result.stdout).toContain('open-pr: adopted PR title: Already open');
    expect(result.stdout).toContain('PR already exists (no create needed).');
  });

  test('Test 2: no same-head PR creates one PR as today', () => {
    const result = runOpenPrGuard(
      guard,
      JSON.stringify([
        openPr({
          number: 10,
          title: 'Other work',
          headRefOid: OTHER_SHA,
          headRefName: 'archon/task-web-worker-x',
          baseRefName: 'dev',
          url: PR_URL_10,
        }),
      ]),
      0
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(1);
    expect(result.createArgs).toContain(`--head ${UNIQUE_BRANCH}`);
    expect(result.createArgs).toContain('--base dev');
    expect(result.stdout).not.toContain('open-pr: adopted');
  });

  test('Test 3: same head but different base is not adopted', () => {
    const result = runOpenPrGuard(
      guard,
      JSON.stringify([
        openPr({
          number: 10,
          title: 'Wrong base',
          headRefOid: HEAD_SHA,
          headRefName: 'archon/task-web-worker-x',
          baseRefName: 'main',
          url: PR_URL_10,
        }),
      ]),
      0
    );
    expect(result.code, result.stderr).toBe(1);
    expect(result.creates).toBe(0);
    expect(result.args).not.toContain('pr create');
    expect(result.stderr).toContain('ERROR: base_branch_mismatch: recorded=dev attempted=main');
    expect(result.stdout).not.toContain('open-pr: adopted');
    expect(result.stdout).not.toContain('PR_URL=');
  });

  test('Test 4: multiple same-head PRs adopt the lowest number, create none', () => {
    const result = runOpenPrGuard(
      guard,
      JSON.stringify([
        openPr({
          number: 11,
          title: 'Later duplicate',
          headRefOid: HEAD_SHA,
          headRefName: 'feat/wo-x-thread-abc',
          baseRefName: 'dev',
          url: PR_URL_11,
        }),
        openPr({
          number: 10,
          title: 'First duplicate',
          headRefOid: HEAD_SHA,
          headRefName: 'archon/task-web-worker-x',
          baseRefName: 'dev',
          url: PR_URL_10,
        }),
      ]),
      0
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(0);
    expect(result.args).not.toContain('pr create');
    expect(result.stdout).toContain(`PR_URL=${PR_URL_10}`);
    expect(result.stdout).not.toContain(`PR_URL=${PR_URL_11}`);
    expect(result.stderr).toContain('WARN: open-pr: same-head duplicates not adopted:');
    expect(result.stderr).toContain(`#11 ${PR_URL_11}`);
  });

  test('same-head PR past the first 200 open PRs is adopted', () => {
    const pulls: RestPull[] = [];
    for (let n = 0; n < 200; n++) {
      pulls.push(fillerPull(n));
    }
    pulls.push(
      restPull({
        number: 4,
        title: 'Past the cap',
        sha: HEAD_SHA,
        ref: 'archon/task-web-worker-late',
        base: 'dev',
        url: PR_URL_4,
      })
    );
    expect(pulls).toHaveLength(201);
    const result = runOpenPrGuard(guard, JSON.stringify(pulls), 0);
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(0);
    expect(result.args).toContain('--paginate');
    expect(result.args).toContain('--slurp');
    expect(result.args).not.toContain('pr create');
    expect(result.stdout).toContain(`PR_URL=${PR_URL_4}`);
    expect(result.stdout).toContain(`open-pr: adopted existing PR ${PR_URL_4} at head ${HEAD_SHA}`);
    expect(result.stdout).toContain('open-pr: adopted PR title: Past the cap');
  });

  test('lowest same-head PR past the first 200 wins over an earlier higher number', () => {
    const pulls: RestPull[] = [
      restPull({
        number: 900,
        title: 'Visible duplicate',
        sha: HEAD_SHA,
        ref: 'archon/task-web-worker-early',
        base: 'dev',
        url: PR_URL_900,
      }),
    ];
    for (let n = 1; n < 200; n++) {
      pulls.push(fillerPull(n));
    }
    pulls.push(
      restPull({
        number: 4,
        title: 'True lowest past page',
        sha: HEAD_SHA,
        ref: 'archon/task-web-worker-late',
        base: 'dev',
        url: PR_URL_4,
      })
    );
    expect(pulls).toHaveLength(201);
    const result = runOpenPrGuard(guard, JSON.stringify(pulls), 0);
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(0);
    expect(result.args).toContain('--paginate');
    expect(result.args).toContain('--slurp');
    expect(result.args).not.toContain('pr create');
    expect(result.stdout).toContain(`PR_URL=${PR_URL_4}`);
    expect(result.stdout).not.toContain(`PR_URL=${PR_URL_900}`);
    expect(result.stdout).toContain('open-pr: adopted PR title: True lowest past page');
    expect(result.stderr).toContain('WARN: open-pr: same-head duplicates not adopted:');
    expect(result.stderr).toContain(`#900 ${PR_URL_900}`);
  });

  test('Test 5: all lanes carry the guard and the bundle is regenerated', () => {
    expect(LANE_FILES.length).toBe(13);
    const guards = LANE_FILES.map(file => laneGuard(file));
    for (const fileGuard of guards) {
      expect(fileGuard).toBe(guards[0]);
      expect(fileGuard.split('# same-head-adopt: begin').length - 1).toBe(1);
      expect(fileGuard.split('# same-head-adopt: end').length - 1).toBe(1);
      expect(fileGuard.split(GUARD_BEGIN).length - 1).toBe(1);
      expect(fileGuard).toContain('gh api --paginate --slurp');
      expect(fileGuard).not.toContain('--limit 200');
      expect(fileGuard).not.toContain('SAME_HEAD_RAW');
    }

    const yamlNames = readdirSync(DEFAULTS_DIR)
      .filter(name => name.endsWith('.yaml'))
      .sort();
    const withGuard = yamlNames.filter(name =>
      readFileSync(join(DEFAULTS_DIR, name), 'utf8').includes('existing-pr-base-guard: begin')
    );
    const withAdopt = yamlNames.filter(name =>
      readFileSync(join(DEFAULTS_DIR, name), 'utf8').includes('same-head-adopt')
    );
    expect(withGuard).toEqual([...LANE_FILES].sort());
    expect(withAdopt).toEqual([...LANE_FILES].sort());

    const bundle = readFileSync(BUNDLE_PATH, 'utf8');
    expect(bundle.split('same-head-adopt').length - 1).toBeGreaterThan(0);
    expect(bundle).toContain('# same-head-adopt: begin');
  });

  test('gh list failure fails open to the create path', () => {
    const result = runOpenPrGuard(guard, 'not-json', 1);
    expect(result.code, result.stderr).toBe(0);
    expect(result.creates).toBe(1);
    expect(result.createArgs).toContain(`--head ${UNIQUE_BRANCH}`);
    expect(result.createArgs).toContain('--base dev');
    expect(result.stdout).not.toContain('open-pr: adopted');
  });
});
