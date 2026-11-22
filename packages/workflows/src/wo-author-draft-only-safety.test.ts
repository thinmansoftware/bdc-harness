/**
 * WO-HARNESS-WO-AUTHOR-DRAFT-ONLY-SAFETY-01: a contextual issue reference never redirects
 * bdc-wo-author, and a run whose spec already exists ends existing_spec_unchanged with no
 * revision, commit, branch or push.
 *
 * Offline fixtures. The node bash under test is the real bash of bdc-wo-author.yaml, read
 * with parseWorkflow and rendered with the engine's own substitution functions
 * (substituteWorkflowVariables, then substituteNodeOutputRefs with bash escaping). Model
 * nodes are the only controlled boundary: their outputs (normalize-intake, author-loop) are
 * given as fixture text. GitHub is a fake `gh` that logs every call; the remote is a local
 * bare repository whose pre-receive hook counts push attempts. No network, no credentials.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRegistry, registerBuiltinProviders } from '@archon/providers';
import { parseWorkflow } from './loader';
import { evaluateCondition } from './condition-evaluator';
import { substituteWorkflowVariables } from './executor-shared';
import { substituteNodeOutputRefs } from './dag-executor';
import type { NodeOutput, WorkflowDefinition } from './schemas';

const root = join(import.meta.dir, '../../..');
const filename = 'bdc-wo-author.yaml';
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';

function workflow(): WorkflowDefinition {
  const text = readFileSync(join(root, '.archon/workflows/defaults', filename), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
  const parsed = parseWorkflow(text, filename);
  if (!parsed.workflow) throw new Error(`bdc-wo-author failed to load: ${parsed.error?.error}`);
  return parsed.workflow;
}

type AnyNode = Record<string, unknown> & { id: string };

function node(id: string): AnyNode {
  const found = (workflow().nodes as unknown as AnyNode[]).find(n => n.id === id);
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

function outputMap(outputs: Record<string, string>): Map<string, NodeOutput> {
  return new Map<string, NodeOutput>(
    Object.entries(outputs).map(([id, output]) => [id, { state: 'completed', output }])
  );
}

/** The node's bash exactly as the engine renders it for a run. */
function render(id: string, userMessage: string, outputs: Record<string, string>): string {
  const bash = node(id).bash;
  if (typeof bash !== 'string') throw new Error(`node ${id} has no bash`);
  const { prompt } = substituteWorkflowVariables(
    bash,
    'run-fixture-0001',
    userMessage,
    fx.artifacts,
    'main',
    'docs/'
  );
  return substituteNodeOutputRefs(prompt, outputMap(outputs), true);
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function sh(script: string, cwd: string, env: Record<string, string> = {}): Result {
  const file = join(fx.dir, `script-${Math.random().toString(36).slice(2)}.sh`);
  // The fake gh and curl go first on PATH; the script resolves the directory itself so
  // the same line works in Git Bash and on Linux.
  writeFileSync(file, 'export PATH="$(cd "$FAKE_BIN" && pwd):$PATH"\n' + script);
  const r = Bun.spawnSync([BASH, file], {
    cwd,
    env: {
      ...process.env,
      FAKE_BIN: fx.bin,
      FAKE_GH_DIR: fx.ghDir,
      FAKE_GH_LOG: fx.ghLog,
      ARTIFACTS_DIR: fx.artifacts,
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function git(cmd: string, cwd = fx.work): string {
  const r = sh(`git ${cmd}`, cwd);
  if (r.code !== 0) throw new Error(`git ${cmd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function kv(text: string, key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m ? m[1] : '';
}

function lastJson(text: string): Record<string, string> {
  const line = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('{'))
    .pop();
  return line ? (JSON.parse(line) as Record<string, string>) : {};
}

interface Fixture {
  dir: string;
  work: string;
  origin: string;
  bin: string;
  ghDir: string;
  ghLog: string;
  pushLog: string;
  artifacts: string;
}

let fx: Fixture;

const EXISTING_ID = 'WO-FIXTURE-EXISTING-01';
const EXISTING_PATH = `docs/work-orders/${EXISTING_ID}.md`;
const EXISTING_TEXT = `# ${EXISTING_ID}\n\nWO Class: CODE\nCommitted fixture spec.\n`;

function fakeIssue(ownerRepo: string, n: number, text: string): void {
  writeFileSync(join(fx.ghDir, `${ownerRepo.replace('/', '_')}_issues_${n}.txt`), text);
}

function ghCalls(): string[] {
  return existsSync(fx.ghLog)
    ? readFileSync(fx.ghLog, 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
    : [];
}

function pushCount(): number {
  return existsSync(fx.pushLog)
    ? readFileSync(fx.pushLog, 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '').length
    : 0;
}

beforeEach(() => {
  clearRegistry();
  registerBuiltinProviders();
  const dir = mkdtempSync(join(tmpdir(), 'wo-author-safety-'));
  fx = {
    dir,
    work: join(dir, 'work'),
    origin: join(dir, 'origin.git'),
    bin: join(dir, 'bin'),
    ghDir: join(dir, 'gh'),
    ghLog: join(dir, 'gh.log'),
    pushLog: join(dir, 'push.log'),
    artifacts: join(dir, 'artifacts'),
  };
  for (const d of [fx.bin, fx.ghDir, fx.artifacts]) mkdirSync(d, { recursive: true });
  // Fake gh: logs the call, answers `gh api repos/<owner>/<repo>/issues/<n>` from a
  // fixture file (already formatted as the node's --jq would print it), fails otherwise.
  writeFileSync(
    join(fx.bin, 'gh'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"',
      'for a in "$@"; do',
      '  case "$a" in repos/*) key=$(printf \'%s\' "${a#repos/}" | sed \'s/[?].*//; s#/#_#g\') ;; esac',
      'done',
      'if [ -n "${key:-}" ] && [ -f "$FAKE_GH_DIR/$key.txt" ]; then cat "$FAKE_GH_DIR/$key.txt"; exit 0; fi',
      'echo "gh: fixture has no answer for: $*" >&2',
      'exit 1',
      '',
    ].join('\n')
  );
  // Fake curl: the network is not part of these fixtures.
  writeFileSync(join(fx.bin, 'curl'), '#!/bin/sh\nexit 7\n');
  const setup = sh(
    [
      'set -e',
      `chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/curl"`,
      'git init -q --bare -b main origin.git',
      // Push counter: every push attempt that reaches the remote appends one line.
      `printf '#!/bin/sh\\necho push >> "%s"\\ncat >/dev/null\\nexit 0\\n' "$PUSH_LOG_POSIX" > origin.git/hooks/pre-receive`,
      'chmod +x origin.git/hooks/pre-receive',
      'git clone -q origin.git work 2>/dev/null',
      'cd work',
      'git config user.name fixture && git config user.email fixture@example.invalid',
      'git checkout -q -b main 2>/dev/null || true',
      'mkdir -p docs/work-orders',
      `printf '%s' "$EXISTING_TEXT" > ${EXISTING_PATH}`,
      `git add ${EXISTING_PATH} && git commit -q -m 'fixture: committed spec'`,
      'git push -q origin main',
      'git fetch -q origin',
      'rm -f "$PUSH_LOG_FILE"',
    ].join('\n'),
    fx.dir,
    {
      EXISTING_TEXT,
      PUSH_LOG_FILE: fx.pushLog,
      PUSH_LOG_POSIX: fx.pushLog
        .replace(/\\/g, '/')
        .replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`),
    }
  );
  if (setup.code !== 0) throw new Error(`fixture setup failed: ${setup.stderr}`);
});

afterEach(() => {
  clearRegistry();
  rmSync(fx.dir, { recursive: true, force: true });
});

function classify(message: string, env: Record<string, string> = {}): Result {
  return sh(render('classify-intake', message, {}), fx.work, env);
}

function authorFooter(woId: string, mode = '--draft-only', extra = ''): string {
  return [
    extra,
    '=== AUTHOR-LOOP RESULT ===',
    `wo_id=${woId}`,
    `spec_path=docs/work-orders/${woId}.md`,
    'target_repo=thinmansoftware/bdc-harness',
    `mode=${mode}`,
    'auto_approve=false',
  ].join('\n');
}

function disposition(classifyOut: string, authorOut: string): Result {
  return sh(
    render('spec-disposition', 'unused', {
      'classify-intake': classifyOut,
      'author-loop': authorOut,
    }),
    fx.work
  );
}

function preview(classifyOut: string, authorOut: string, dispositionOut: string): Result {
  return sh(
    render('dry-run-preview', 'unused', {
      'classify-intake': classifyOut,
      'author-loop': authorOut,
      'spec-disposition': dispositionOut,
    }),
    fx.work
  );
}

const PASS_JSON =
  '{"GATE":"pass","GATE_ALLOW":"yes","GATE_REASONS":"","GATE_BASE_SHA":"' +
  'a'.repeat(40) +
  '","GATE_OVERRIDES":""}';
const FAIL_JSON =
  '{"GATE":"fail","GATE_ALLOW":"no","GATE_REASONS":"1:green_failed:bash tests/bad.sh","GATE_BASE_SHA":"","GATE_OVERRIDES":""}';

function commitSpec(classifyOut: string, previewOut: string): Result {
  return sh(
    render('commit-spec', 'unused', {
      'classify-intake': classifyOut,
      'dry-run-preview': previewOut,
      'stop-command-gate-final': PASS_JSON,
    }),
    fx.work
  );
}

interface Snapshot {
  head: string;
  index: string;
  count: string;
  refs: string;
  remote: string;
  bytes: string;
}

function snapshot(): Snapshot {
  return {
    head: git('rev-parse HEAD'),
    index: git('ls-files -s'),
    count: git('rev-list --count HEAD'),
    refs: git('for-each-ref refs/heads'),
    remote: git(`ls-remote --heads "${fx.origin.replace(/\\/g, '/')}"`),
    bytes: readFileSync(join(fx.work, EXISTING_PATH), 'utf8'),
  };
}

function when(id: string): string {
  const w = node(id).when;
  if (typeof w !== 'string') throw new Error(`node ${id} has no when:`);
  return w;
}

function runs(id: string, outputs: Record<string, string>): boolean {
  const r = evaluateCondition(when(id), outputMap(outputs));
  expect(r.parsed, `${id} when: parses`).toBe(true);
  return r.result;
}

describe('WO-HARNESS-WO-AUTHOR-DRAFT-ONLY-SAFETY-01', () => {
  test('Test 1: contextual_issue_remains_chat_and_drafts_the_requested_new_id', () => {
    fakeIssue(
      'bluedevilcollectibles/bdc-xo',
      4242,
      'Old issue\n\nThis issue is about WO-FIXTURE-OTHER-01.\n'
    );
    const message =
      '--project bdc-xo --draft-only Author a new work order WO-FIXTURE-NEW-01 that adds a widget. ' +
      'Context only: bdc-xo#4242 describes the background.';

    const first = classify(message);
    const second = classify(message);
    expect(first.code, first.stderr).toBe(0);
    // Deterministic: the same message classifies byte-identically twice.
    expect(second.stdout).toBe(first.stdout);
    expect(kv(first.stdout, 'intake_source')).toBe('chat_message');
    expect(kv(first.stdout, 'mode')).toBe('--draft-only');
    expect(kv(first.stdout, 'requested_wo_id')).toBe('WO-FIXTURE-NEW-01');
    expect(kv(first.stdout, 'wo_id_hint')).toBe('WO-FIXTURE-NEW-01');
    expect(kv(first.stdout, 'existing_spec')).toBe('no');
    expect(first.stdout).not.toContain('WO-FIXTURE-OTHER-01');
    // The context issue is never fetched.
    expect(ghCalls()).toEqual([]);

    // Draft boundary: the controlled author writes only the requested spec.
    mkdirSync(join(fx.work, 'docs/work-orders'), { recursive: true });
    writeFileSync(join(fx.work, 'docs/work-orders/WO-FIXTURE-NEW-01.md'), '# WO-FIXTURE-NEW-01\n');
    const d = disposition(first.stdout, authorFooter('WO-FIXTURE-NEW-01'));
    expect(d.code, d.stderr).toBe(0);
    const dj = lastJson(d.stdout);
    expect(dj.result).toBe('new');
    expect(dj.wo_id).toBe('WO-FIXTURE-NEW-01');
    expect(dj.requested_wo_id).toBe('WO-FIXTURE-NEW-01');
    expect(dj.spec_path).toBe('docs/work-orders/WO-FIXTURE-NEW-01.md');
    expect(existsSync(join(fx.work, 'docs/work-orders/WO-FIXTURE-OTHER-01.md'))).toBe(false);

    // Auto-generated variant: no ID in the message, the same context reference.
    const auto = classify(
      'Author a work order that adds a widget export. See bdc-xo#4242 for context.'
    );
    expect(auto.code, auto.stderr).toBe(0);
    expect(kv(auto.stdout, 'intake_source')).toBe('chat_message');
    expect(kv(auto.stdout, 'requested_wo_id')).toBe('auto-generate');
    expect(kv(auto.stdout, 'wo_id_hint')).toBe('auto-generate');
    expect(kv(auto.stdout, 'existing_spec')).toBe('no');
    expect(
      classify('Author a work order that adds a widget export. See bdc-xo#4242 for context.').stdout
    ).toBe(auto.stdout);
    expect(ghCalls()).toEqual([]);
    const da = lastJson(
      disposition(auto.stdout, authorFooter('WO-HARNESS-WIDGET-EXPORT-01')).stdout
    );
    expect(da.result).toBe('new');
    expect(da.requested_wo_id).toBe('auto-generate');

    // A footer naming a different ID ends wo_id_mismatch before any gate or commit.
    const before = snapshot();
    const mm = disposition(first.stdout, authorFooter('WO-FIXTURE-OTHER-01'));
    expect(mm.code).not.toBe(0);
    expect(lastJson(mm.stdout).result).toBe('wo_id_mismatch');
    expect(mm.stdout + mm.stderr).toContain('WO-FIXTURE-NEW-01');
    expect(mm.stdout + mm.stderr).toContain('WO-FIXTURE-OTHER-01');
    expect(node('spec-disposition').abort_run_on_failure).toBe(true);
    const mmOut = { 'spec-disposition': mm.stdout.trim().split('\n').pop() ?? '' };
    expect(runs('stop-command-gate', mmOut)).toBe(false);
    expect(runs('commit-spec', { ...mmOut, 'stop-command-gate-final': PASS_JSON })).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(pushCount()).toBe(0);
  });

  test('Test 1b: the model normalize step cannot change the deterministic classification', () => {
    const c = classify('--draft-only Author WO-FIXTURE-NEW-01. Context: bdc-xo#4242.');
    expect(c.code, c.stderr).toBe(0);
    const normalized = (source: string, hint: string): string =>
      [
        '=== NORMALIZE-INTAKE OUTPUT ===',
        `intake_source=${source}`,
        'mode=--draft-only',
        'auto_approve=false',
        'target_repo_hint=bdc-harness',
        `wo_id_hint=${hint}`,
        '',
        '=== DESCRIPTION ===',
        'Author WO-FIXTURE-NEW-01.',
      ].join('\n');
    const ok = sh(
      render('read-context', 'unused', {
        'classify-intake': c.stdout,
        'normalize-intake': normalized('chat_message', 'WO-FIXTURE-NEW-01'),
      }),
      fx.work
    );
    expect(ok.code, ok.stderr).toBe(0);
    for (const [source, hint] of [
      ['github_issue', 'WO-FIXTURE-NEW-01'],
      ['chat_message', 'WO-FIXTURE-OTHER-01'],
    ]) {
      const bad = sh(
        render('read-context', 'unused', {
          'classify-intake': c.stdout,
          'normalize-intake': normalized(source, hint),
        }),
        fx.work
      );
      expect(bad.code, `${source}/${hint}`).not.toBe(0);
      expect(bad.stdout + bad.stderr).toContain('normalize_overrode_classification');
    }
  });

  test('Test 2: bare_and_explicit_issue_intake_retain_expected_behavior', () => {
    fakeIssue(
      'bluedevilcollectibles/bdc-harness',
      12,
      'Harness issue title\n\nBody naming WO-FIXTURE-ISSUE-01.\n'
    );
    fakeIssue('thinmansoftware/bdc-xo', 77, 'XO issue title\n\nBody with no work order id.\n');

    const bare = classify('bdc-harness#12');
    expect(bare.code, bare.stderr).toBe(0);
    expect(kv(bare.stdout, 'intake_source')).toBe('github_issue');
    expect(kv(bare.stdout, 'issue_ref')).toBe('bluedevilcollectibles/bdc-harness#12');
    expect(kv(bare.stdout, 'requested_wo_id')).toBe('auto-generate');
    expect(kv(bare.stdout, 'wo_id_hint')).toBe('WO-FIXTURE-ISSUE-01');
    expect(bare.stdout).toContain('Harness issue title');
    expect(kv(bare.stdout, 'mode')).toBe('--queue');
    expect(ghCalls()).toHaveLength(1);
    expect(ghCalls()[0]).toContain('repos/bluedevilcollectibles/bdc-harness/issues/12');

    const owner = classify('  @thinmansoftware/bdc-xo#77   --draft-only  ');
    expect(owner.code, owner.stderr).toBe(0);
    expect(kv(owner.stdout, 'intake_source')).toBe('github_issue');
    expect(kv(owner.stdout, 'issue_ref')).toBe('thinmansoftware/bdc-xo#77');
    expect(kv(owner.stdout, 'mode')).toBe('--draft-only');
    expect(kv(owner.stdout, 'wo_id_hint')).toBe('auto-generate');
    expect(owner.stdout).toContain('XO issue title');

    // Mode precedence: last flag in the message wins; then INPUT_MODE; then --queue.
    expect(kv(classify('--queue bdc-harness#12 --draft-only').stdout, 'mode')).toBe('--draft-only');
    expect(kv(classify('bdc-harness#12', { INPUT_MODE: '--draft-only' }).stdout, 'mode')).toBe(
      '--draft-only'
    );
    expect(
      kv(classify('bdc-harness#12 --fire', { INPUT_MODE: '--draft-only' }).stdout, 'mode')
    ).toBe('--fire');
    expect(kv(classify('bdc-harness#12 --auto-approve').stdout, 'auto_approve')).toBe('true');
    expect(kv(classify('bdc-harness#12').stdout, 'auto_approve')).toBe('false');

    const explicit = classify(
      '--issue thinmansoftware/bdc-xo#77 draft the work order from this issue'
    );
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(kv(explicit.stdout, 'intake_source')).toBe('github_issue');
    expect(kv(explicit.stdout, 'issue_ref')).toBe('thinmansoftware/bdc-xo#77');
    expect(explicit.stdout).toContain('XO issue title');

    // Malformed explicit intake fails closed, with no fetch.
    const callsBefore = ghCalls().length;
    for (const bad of ['--issue not-a-reference draft it', 'draft it --issue']) {
      const r = classify(bad);
      expect(r.code, bad).not.toBe(0);
      expect(r.stdout, bad).toContain('INTAKE_FAILURE');
      expect(kv(r.stdout, 'intake_source'), bad).not.toBe('chat_message');
    }
    expect(ghCalls().length).toBe(callsBefore);
    expect(node('classify-intake').abort_run_on_failure).toBe(true);

    // A bare reference whose fetch fails does not fall back to chat.
    const missing = classify('bdc-harness#999');
    expect(missing.code).not.toBe(0);
    expect(missing.stdout).toContain('INTAKE_FAILURE');
  });

  test('Test 3: existing_spec_exits_unchanged_across_real_node_conditions_and_git_boundaries', () => {
    const before = snapshot();
    const skipFooter = (id: string, mode: string): string =>
      authorFooter(id, mode, `IDEMPOTENT_SKIP: ${id} already exists on disk`);

    // The committed spec, in --draft-only, in --queue (the default MODE) and through --spec.
    const runsToCheck: [string, Record<string, string>][] = [
      [`--draft-only Revise ${EXISTING_ID} to add a note`, {}],
      [`Revise ${EXISTING_ID} to add a note`, {}],
      [`--spec ${EXISTING_PATH}`, {}],
    ];
    for (const [message, env] of runsToCheck) {
      const c = classify(message, env);
      expect(c.code, `${message}: ${c.stderr}`).toBe(0);
      expect(kv(c.stdout, 'existing_spec'), message).toBe('yes');
      expect(kv(c.stdout, 'existing_spec_path'), message).toBe(EXISTING_PATH);
      const mode = kv(c.stdout, 'mode');
      const authorOut = skipFooter(EXISTING_ID, mode);
      const d = disposition(c.stdout, authorOut);
      expect(d.code, d.stderr).toBe(0);
      const dj = lastJson(d.stdout);
      expect(dj.result, message).toBe('existing_spec_unchanged');
      const p = preview(c.stdout, authorOut, d.stdout);
      expect(p.code, p.stderr).toBe(0);
      expect(p.stdout).toContain('disposition=existing_spec_unchanged');
      const disp = { 'spec-disposition': d.stdout.trim().split('\n').pop() ?? '' };
      // Normal path: gate, revise, final gate and commit are skipped; the fail node is
      // skipped too, so the run ends successfully on the unchanged result.
      expect(runs('stop-command-gate', disp)).toBe(false);
      expect(runs('stop-command-revise', disp)).toBe(false);
      expect(runs('stop-command-gate-final', disp)).toBe(false);
      expect(runs('stop-command-gate-fail', disp)).toBe(false);
      expect(runs('commit-spec', disp)).toBe(false);
      // Adversarial stale gate outputs cannot re-enable a mutation.
      expect(runs('stop-command-revise', { ...disp, 'stop-command-gate': FAIL_JSON })).toBe(false);
      expect(runs('commit-spec', { ...disp, 'stop-command-gate-final': PASS_JSON })).toBe(false);
      expect(
        runs('stop-command-gate-fail', { ...disp, 'stop-command-gate-final': FAIL_JSON })
      ).toBe(false);
    }
    expect(snapshot()).toEqual(before);

    // An unmerged spec that exists only on disk is also existing.
    writeFileSync(
      join(fx.work, 'docs/work-orders/WO-FIXTURE-LOCAL-01.md'),
      '# WO-FIXTURE-LOCAL-01\n'
    );
    const local = classify('--draft-only Revise WO-FIXTURE-LOCAL-01');
    expect(kv(local.stdout, 'existing_spec')).toBe('yes');
    expect(
      lastJson(disposition(local.stdout, skipFooter('WO-FIXTURE-LOCAL-01', '--draft-only')).stdout)
        .result
    ).toBe('existing_spec_unchanged');
    rmSync(join(fx.work, 'docs/work-orders/WO-FIXTURE-LOCAL-01.md'));

    // Malformed or missing dispositions fail closed: no gate, no commit, the fail node runs.
    for (const bad of ['', 'not json', '{"result":"something-else"}']) {
      const o = { 'spec-disposition': bad };
      expect(runs('stop-command-gate', o), bad).toBe(false);
      expect(runs('commit-spec', { ...o, 'stop-command-gate-final': PASS_JSON }), bad).toBe(false);
      expect(runs('stop-command-gate-fail', o), bad).toBe(true);
    }
    const noClassify = disposition('', authorFooter(EXISTING_ID));
    expect(lastJson(noClassify.stdout).result).not.toBe('new');

    // Adversarial (i): the author edits the existing spec and prints a PASS footer with no
    // IDEMPOTENT_SKIP. The disposition still comes from the pre-author check.
    const c = classify(`--draft-only Revise ${EXISTING_ID}`);
    writeFileSync(
      join(fx.work, EXISTING_PATH),
      EXISTING_TEXT + 'Edited by the controlled author.\n'
    );
    const d1 = disposition(c.stdout, authorFooter(EXISTING_ID));
    expect(lastJson(d1.stdout).result).toBe('existing_spec_unchanged');
    const p1 = preview(c.stdout, authorFooter(EXISTING_ID), d1.stdout);
    const commit1 = commitSpec(c.stdout, p1.stdout);
    expect(commit1.code).toBe(1);
    expect(commit1.stdout).toContain(`commit-spec: refused existing_spec_unchanged ${EXISTING_ID}`);
    // Adversarial (ii): direct invocation with stale GATE_ALLOW yes after the edit.
    const commit2 = commitSpec(c.stdout, p1.stdout);
    expect(commit2.code).toBe(1);
    expect(commit2.stdout).toContain(`commit-spec: refused existing_spec_unchanged ${EXISTING_ID}`);
    const after = snapshot();
    expect({ ...after, bytes: before.bytes }).toEqual(before);
    expect(after.bytes).toBe(EXISTING_TEXT + 'Edited by the controlled author.\n');
    expect(pushCount()).toBe(0);
    git(`checkout -- ${EXISTING_PATH}`);

    // An auto-generate run whose derived ID names the committed spec: the pre-author check
    // cannot know the ID, so commit-spec refuses on the footer's spec_path.
    const auto = classify('--draft-only Author a work order for the existing fixture behavior');
    expect(kv(auto.stdout, 'existing_spec')).toBe('no');
    writeFileSync(join(fx.work, EXISTING_PATH), '# overwritten by a template copy\n');
    const da = disposition(auto.stdout, authorFooter(EXISTING_ID));
    const pa = preview(auto.stdout, authorFooter(EXISTING_ID), da.stdout);
    const ca = commitSpec(auto.stdout, pa.stdout);
    expect(ca.code).toBe(1);
    expect(ca.stdout).toContain(`commit-spec: refused existing_spec_unchanged ${EXISTING_ID}`);
    expect(git('for-each-ref refs/heads')).toBe(before.refs);
    expect(git(`ls-remote --heads "${fx.origin.replace(/\\/g, '/')}"`)).toBe(before.remote);
    expect(pushCount()).toBe(0);
    git(`checkout -- ${EXISTING_PATH}`);

    // A spec present on origin/main but not at the local HEAD is refused too.
    const other = join(fx.dir, 'other');
    sh(
      [
        'set -e',
        'git clone -q origin.git other',
        'cd other && git config user.name fixture && git config user.email fixture@example.invalid',
        'printf "# WO-FIXTURE-REMOTE-01\\n" > docs/work-orders/WO-FIXTURE-REMOTE-01.md',
        'git add docs/work-orders && git commit -q -m remote && git push -q origin main',
      ].join('\n'),
      fx.dir
    );
    expect(existsSync(join(other, 'docs/work-orders/WO-FIXTURE-REMOTE-01.md'))).toBe(true);
    const pushesBefore = pushCount();
    const autoRemote = classify('--draft-only Author a work order for the remote fixture');
    writeFileSync(join(fx.work, 'docs/work-orders/WO-FIXTURE-REMOTE-01.md'), '# local copy\n');
    const dr = disposition(autoRemote.stdout, authorFooter('WO-FIXTURE-REMOTE-01'));
    const cr = commitSpec(
      autoRemote.stdout,
      preview(autoRemote.stdout, authorFooter('WO-FIXTURE-REMOTE-01'), dr.stdout).stdout
    );
    expect(cr.code).toBe(1);
    expect(cr.stdout).toContain(
      'commit-spec: refused existing_spec_unchanged WO-FIXTURE-REMOTE-01'
    );
    expect(pushCount()).toBe(pushesBefore);
    rmSync(join(fx.work, 'docs/work-orders/WO-FIXTURE-REMOTE-01.md'));
    git('reset -q --hard origin/main');

    // A genuinely new spec still reaches its gate and, with GATE_ALLOW yes, commits and
    // pushes exactly one new wo/author branch.
    const refsBefore = git('for-each-ref refs/heads');
    const remoteBefore = git(`ls-remote --heads "${fx.origin.replace(/\\/g, '/')}"`);
    const pushesBeforeNew = pushCount();
    const n = classify('--draft-only Author WO-FIXTURE-BRAND-NEW-01 for a new export');
    expect(kv(n.stdout, 'existing_spec')).toBe('no');
    writeFileSync(
      join(fx.work, 'docs/work-orders/WO-FIXTURE-BRAND-NEW-01.md'),
      '# WO-FIXTURE-BRAND-NEW-01\n'
    );
    const dn = disposition(n.stdout, authorFooter('WO-FIXTURE-BRAND-NEW-01'));
    expect(lastJson(dn.stdout).result).toBe('new');
    const nOut = { 'spec-disposition': dn.stdout.trim().split('\n').pop() ?? '' };
    expect(runs('stop-command-gate', nOut)).toBe(true);
    expect(runs('stop-command-revise', { ...nOut, 'stop-command-gate': FAIL_JSON })).toBe(true);
    expect(runs('stop-command-gate-final', nOut)).toBe(true);
    expect(runs('commit-spec', { ...nOut, 'stop-command-gate-final': PASS_JSON })).toBe(true);
    expect(runs('stop-command-gate-fail', { ...nOut, 'stop-command-gate-final': PASS_JSON })).toBe(
      false
    );
    expect(runs('stop-command-gate-fail', { ...nOut, 'stop-command-gate-final': FAIL_JSON })).toBe(
      true
    );
    expect(runs('stop-command-gate-fail', nOut)).toBe(true);
    const pn = preview(n.stdout, authorFooter('WO-FIXTURE-BRAND-NEW-01'), dn.stdout);
    expect(pn.stdout).toContain('disposition=new');
    const cn = commitSpec(n.stdout, pn.stdout);
    expect(cn.code, cn.stderr + cn.stdout).toBe(0);
    expect(cn.stdout).not.toContain('refused');
    const newRemote = git(`ls-remote --heads "${fx.origin.replace(/\\/g, '/')}"`)
      .split('\n')
      .filter(l => !remoteBefore.split('\n').includes(l));
    expect(newRemote).toHaveLength(1);
    expect(newRemote[0]).toMatch(/refs\/heads\/wo\/author-WO-FIXTURE-BRAND-NEW-01-\d{14}$/);
    expect(pushCount()).toBe(pushesBeforeNew + 1);
    expect(git('for-each-ref refs/heads')).not.toBe(refsBefore);
  });

  test('Test 3b: the manifest and description report the unchanged path', () => {
    const manifest = node('build-manifest').prompt as string;
    expect(manifest).toContain('$spec-disposition.output');
    expect(manifest).toContain('$classify-intake.output');
    expect(manifest).toContain('existing_spec_unchanged');
    expect(manifest).toContain('requested_wo_id');
    const description = workflow().description ?? '';
    const line = description.split('\n').find(l => l.includes('has no republish path')) ?? '';
    expect(line).toContain(
      'An existing spec on bdc-xo main is never revised or republished by this intake, in any mode, and --spec has no republish path; change an existing spec only by a pull request on that spec file in bdc-xo, opened with merge-hold, with an amendment row, read by the Board desk or the General as the change requires.'
    );
  });
});
