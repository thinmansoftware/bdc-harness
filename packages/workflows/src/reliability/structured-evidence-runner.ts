/**
 * Shared argv evidence runner for lane test and assertion commands.
 * Tokenize once, validate the decoded argv, and spawn that argv with shell:false.
 * Never eval, never bash -c, and never re-run a rejected command through a fallback.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from '@hono/zod-openapi';

export const evidenceStatusSchema = z.enum([
  'PASSED',
  'FAILED',
  'INCOMPLETE',
  'NEVER_RAN',
  'COUNTS_UNPARSED',
  'NOT_APPLICABLE',
  'OTHER_STAGE',
]);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

const chainStepSchema = z.object({
  argv: z.array(z.string()),
  resolvedArgv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  passed: z.number().int().nullable(),
  total: z.number().int().nullable(),
  status: evidenceStatusSchema,
  reason: z.string(),
});

export const attemptMemberSchema = z.object({
  rawCommand: z.string(),
  argv: z.array(z.string()),
  resolvedArgv: z.array(z.string()),
  resolvedExecutable: z.string(),
  declaredExecutable: z.string(),
  cwd: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  status: evidenceStatusSchema,
  reason: z.string(),
  logPath: z.string(),
  passed: z.number().int().nullable(),
  total: z.number().int().nullable(),
  scope: z.enum(['selected', 'other_stage', 'unresolved']),
  chain: z.array(chainStepSchema),
});

export type AttemptMember = z.infer<typeof attemptMemberSchema>;

export const treeIdentitySchema = z.object({
  method: z.string(),
  headSha: z.string(),
  paths: z.array(z.object({ path: z.string(), sha256: z.string() })),
  contentDigest: z.string(),
});

export type TreeIdentity = z.infer<typeof treeIdentitySchema>;

export const authoritySchema = z.object({
  repo: z.string(),
  stageId: z.string().nullable(),
  targetBranch: z.string().nullable(),
  worktree: z.string(),
  baseSha: z.string(),
});

export type EvidenceAuthority = z.infer<typeof authoritySchema>;

export const evidenceAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  attemptId: z.string(),
  kind: z.enum(['tests', 'greps', 'assertions']),
  source: z.string(),
  span: z.string(),
  runId: z.string(),
  authority: authoritySchema,
  tree: treeIdentitySchema,
  members: z.array(attemptMemberSchema),
  aggregate: evidenceStatusSchema,
  grepExecuted: z.number().int().nonnegative().optional(),
  grepDropped: z.number().int().nonnegative().optional(),
  grepUnparsed: z.number().int().nonnegative().optional(),
  grepMismatch: z.number().int().nonnegative().optional(),
});

export type EvidenceAttempt = z.infer<typeof evidenceAttemptSchema>;

const SCRUB_PREFIXES = [
  'OVERSEER_',
  'MERGE_MANAGER_',
  'ARCHON_',
  'DUTY_OFFICER_',
  'TASKMASTER_',
  'DISPATCH_',
  'SMART_CAULDRON_',
  'BOARD_',
  'GITHUB_APP_',
  'TELEGRAM_',
];

const SCRUB_EXACT = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_AUTH_TOKEN_INTERNAL']);

const TEST_CHARSET = /^[A-Za-z0-9@%+=:,./_-]+$/;
const ASSERT_CHARSET = /^[A-Za-z0-9@%+=:,./_*?~^-]+$/;
const INLINE_FLAGS = new Set([
  '-c',
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '-i',
  '-m',
]);
const GIT_SUBS = new Set(['diff', 'log', 'show']);
const GIT_OPTS = new Set([
  '--stat',
  '--numstat',
  '--shortstat',
  '--name-only',
  '--name-status',
  '--oneline',
  '--no-merges',
  '--cached',
  '--staged',
  '--summary',
]);
const ASSERT_SIMPLE = new Set([
  'wc',
  'head',
  'tail',
  'cut',
  'tr',
  'uniq',
  'cat',
  'ls',
  'test',
  '[',
]);
const GREP_RUNNERS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
const RUNNER_REL = 'packages/workflows/src/reliability/structured-evidence-runner.ts';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly missing: boolean;
}

function commandTimeoutMs(): number {
  const raw = process.env.SER_COMMAND_TIMEOUT_MS;
  if (raw && /^[0-9]+$/.test(raw)) return Number(raw);
  return 1_500_000;
}

export function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (key.includes('_TEST_')) {
      out[key] = value;
      continue;
    }
    if (SCRUB_EXACT.has(key)) continue;
    if (SCRUB_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

function commandExists(name: string, env: NodeJS.ProcessEnv): boolean {
  if (name.length === 0 || name.includes('/')) return false;
  const pathEnv = env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      // missing directory entry
    }
  }
  return false;
}

function runArgv(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: Buffer
): CommandResult {
  if (argv.length === 0) {
    return {
      stdout: '',
      stderr: 'empty argv',
      code: 127,
      signal: null,
      timedOut: false,
      missing: true,
    };
  }
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    shell: false,
    input: input ?? Buffer.alloc(0),
    timeout: commandTimeoutMs(),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = result.stdout ? Buffer.from(result.stdout).toString('utf8') : '';
  const stderr = result.stderr ? Buffer.from(result.stderr).toString('utf8') : '';
  const err = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = err?.code === 'ETIMEDOUT';
  if (timedOut) {
    return {
      stdout,
      stderr,
      code: 124,
      signal: result.signal ?? 'SIGTERM',
      timedOut: true,
      missing: false,
    };
  }
  if (err?.code === 'ENOENT') {
    return { stdout, stderr, code: 127, signal: null, timedOut: false, missing: true };
  }
  return {
    stdout,
    stderr,
    code: result.status === null || result.status === undefined ? 1 : result.status,
    signal: result.signal,
    timedOut: false,
    missing: false,
  };
}

function gitCapture(cwd: string, args: readonly string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager', ...args],
    {
      cwd,
      env: scrubEnv(process.env),
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  if (result.error || result.status !== 0) return { ok: false, stdout: result.stdout ?? '' };
  return { ok: true, stdout: result.stdout ?? '' };
}

function isHarnessOrigin(url: string): boolean {
  return /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)thinmansoftware\/bdc-harness(?:\.git)?\/?$/i.test(
    url.trim()
  );
}

export function isHarnessRoot(root: string): boolean {
  const runner = join(root, RUNNER_REL);
  const pkgPath = join(root, 'packages/workflows/package.json');
  if (!existsSync(runner) || !existsSync(pkgPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown };
    return parsed.name === '@archon/workflows';
  } catch {
    return false;
  }
}

function gitOrigin(cwd: string): string {
  const result = gitCapture(cwd, ['remote', 'get-url', 'origin']);
  return result.ok ? result.stdout.trim() : '';
}

function gitTop(cwd: string): string | null {
  const result = gitCapture(cwd, ['rev-parse', '--show-toplevel']);
  if (!result.ok) return null;
  const top = result.stdout.trim();
  return top.length > 0 ? top : null;
}

export function productWorktreeTop(cwd: string): string | null {
  const top = gitTop(cwd);
  if (!top) return null;
  const origin = gitOrigin(top);
  if (origin && isHarnessOrigin(origin)) return null;
  return top;
}

function pathUnder(file: string, top: string): boolean {
  try {
    const realFile = realpathSync(file);
    const realTop = realpathSync(top);
    return (
      realFile === realTop || realFile.startsWith(realTop.endsWith(sep) ? realTop : realTop + sep)
    );
  } catch {
    return false;
  }
}

export function resolveTrustedRunnerFile(cwd: string): string | null {
  const candidates: string[] = [];
  // Unit tests need to exercise the real CLI before it has been installed at a
  // production path. This fixture is deliberately separate from
  // HARNESS_ROOT_OVERRIDE, which is workflow-user-controlled and is never a
  // source of trust.
  const testRoot = process.env.SER_TEST_TRUSTED_ROOT;
  if (process.env.NODE_ENV === 'test' && testRoot) {
    candidates.push(testRoot);
  }
  // Installed copies only. ARCHON_HOME, HOME, and HARNESS_ROOT_OVERRIDE are
  // caller-controlled and are never production candidates.
  candidates.push('/app');
  candidates.push('/.archon/workspaces/thinmansoftware/bdc-harness/source');
  const product = productWorktreeTop(cwd);
  for (const root of candidates) {
    if (!root || !isHarnessRoot(root)) continue;
    const file = join(root, RUNNER_REL);
    if (product && pathUnder(file, product)) continue;
    return file;
  }
  return null;
}

export function trustedSelfMatches(cwd: string): boolean {
  const trusted = resolveTrustedRunnerFile(cwd);
  if (!trusted) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    return realpathSync(trusted) === self;
  } catch {
    return false;
  }
}

const generatedIdentityPaths = new Set<string>();

function artifactRootReal(): string | null {
  const base = process.env.ARTIFACTS_DIR;
  if (!base || base.length === 0) return null;
  try {
    return realpathSync(base);
  } catch {
    return null;
  }
}

function insideRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function pathLeaf(abs: string): string | null {
  const leaf = abs.slice(Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')) + 1);
  if (leaf.length === 0 || leaf === '.' || leaf === '..') return null;
  return leaf;
}

// Persisted attempt records are untrusted. Only a real attempt tree or a log
// file under the artifact root may be left out of tree identity.
function verifiedGeneratedTarget(path: string): { real: string; directory: boolean } | null {
  const root = artifactRootReal();
  if (!root) return null;
  const directory = /[\\/]$/.test(path);
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return null;
  const abs = resolve(trimmed);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    let parent: string;
    try {
      parent = realpathSync(dirname(abs));
    } catch {
      return null;
    }
    if (parent !== root && insideRelative(root, parent) === null) return null;
    const leaf = pathLeaf(abs);
    if (!leaf) return null;
    real = join(parent, leaf);
  }
  const rel = insideRelative(root, real);
  if (!rel) return null;
  const attempts = 'evidence/attempts';
  const isAttempt = rel === attempts || rel.startsWith(`${attempts}/`);
  const isLog = !directory && rel.endsWith('.log');
  if (directory) {
    if (!isAttempt) return null;
  } else if (!isAttempt && !isLog) {
    return null;
  }
  return { real, directory };
}

function registerGeneratedPath(cwd: string, path: string): void {
  const verified = verifiedGeneratedTarget(path);
  if (!verified) return;
  const rel = insideRelative(cwd, verified.real);
  if (!rel) return;
  generatedIdentityPaths.add(verified.directory ? `${rel}/` : rel);
}

function excludedIdentityPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  if (norm === '.ser-attempts' || norm.startsWith('.ser-attempts/')) return true;
  if (generatedIdentityPaths.has(norm)) return true;
  for (const generated of generatedIdentityPaths) {
    if (generated.endsWith('/') && norm.startsWith(generated)) return true;
  }
  return false;
}

function hashFailedIdentity(headSha: string): TreeIdentity {
  return { method: 'hash-failed', headSha, paths: [], contentDigest: '' };
}

function notAGitWorktree(): TreeIdentity {
  return {
    method: 'not-a-git-worktree',
    headSha: '',
    paths: [],
    contentDigest: '',
  };
}

function identityFromStatus(cwd: string, headSha: string): TreeIdentity {
  const status = gitCapture(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  if (!status.ok) return hashFailedIdentity(headSha);
  const parsed = parsePorcelainZ(status.stdout);
  if (!parsed.ok) return hashFailedIdentity(headSha);
  const paths: { path: string; sha256: string }[] = [];
  for (const entry of parsed.entries) {
    if (excludedIdentityPath(entry.path)) continue;
    const sha256 = hashWorktreeBytes(cwd, entry.status, entry.path);
    if (sha256 === null) return hashFailedIdentity(headSha);
    paths.push({ path: entry.path, sha256 });
  }
  paths.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const contentDigest = createHash('sha256').update(JSON.stringify(paths)).digest('hex');
  return {
    method: 'sha256-worktree-bytes-v1',
    headSha,
    paths,
    contentDigest,
  };
}

// git status -z records are "XY path\0". Renames and copies are "XY dest\0source\0".
function parsePorcelainZ(
  stdout: string
): { ok: true; entries: { status: string; path: string }[] } | { ok: false } {
  const entries: { status: string; path: string }[] = [];
  let index = 0;
  while (index < stdout.length) {
    const end = stdout.indexOf('\0', index);
    if (end < 0) return { ok: false };
    const header = stdout.slice(index, end);
    index = end + 1;
    if (header.length === 0) continue;
    if (header.length < 4 || header[2] !== ' ') return { ok: false };
    const status = header.slice(0, 2);
    const path = header.slice(3);
    if (status.includes('R') || status.includes('C')) {
      const sourceEnd = stdout.indexOf('\0', index);
      if (sourceEnd < 0) return { ok: false };
      index = sourceEnd + 1;
    }
    entries.push({ status, path });
  }
  return { ok: true, entries };
}

function hashWorktreeBytes(cwd: string, status: string, path: string): string | null {
  const abs = join(cwd, path);
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    if (status.includes('D') && !existsSync(abs)) return 'missing';
    return null;
  }
}

export function testedTreeIdentity(cwd: string): TreeIdentity {
  const head = gitCapture(cwd, ['rev-parse', 'HEAD']);
  if (head.ok) return identityFromStatus(cwd, head.stdout.trim());
  const inside = gitCapture(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return notAGitWorktree();
  // Unborn repository: HEAD does not resolve before the first commit.
  // Hash status paths so a later byte change cannot match an empty identity.
  return identityFromStatus(cwd, '');
}

function attemptsDirectory(cwd: string): string {
  const base = process.env.ARTIFACTS_DIR;
  if (base && base.length > 0) {
    const directory = join(base, 'evidence', 'attempts');
    registerGeneratedPath(cwd, `${directory}/`);
    return directory;
  }
  return join(
    tmpdir(),
    'ser-attempts',
    createHash('sha256').update(cwd).digest('hex').slice(0, 12)
  );
}

function authorityFromEnv(cwd: string): EvidenceAuthority {
  return {
    repo: process.env.SER_REPO ?? '',
    stageId: process.env.SER_STAGE_ID ?? process.env.STAGE_ID ?? null,
    targetBranch: process.env.SER_TARGET_BRANCH ?? null,
    worktree: process.env.SER_WORKTREE ?? gitTop(cwd) ?? cwd,
    baseSha: process.env.SER_BASE_SHA ?? '',
  };
}

function newAttemptId(kind: EvidenceAttempt['kind']): string {
  const pinned = process.env.SER_ATTEMPT_ID ?? '';
  if (pinned.length > 0) {
    // A shared pin must not let greps overwrite the test attempt file.
    if (kind === 'tests') return pinned;
    return `${pinned}-${kind}`;
  }
  return `ser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function kindPointer(kind: EvidenceAttempt['kind']): string {
  if (kind === 'tests') return 'current-tests';
  if (kind === 'greps') return 'current-greps';
  return 'current-assertions';
}

function safeAttemptId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export function persistAttempt(cwd: string, attempt: EvidenceAttempt): string {
  const dir = attemptsDirectory(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${attempt.attemptId}.json`);
  writeAtomic(file, `${JSON.stringify(attempt, null, 2)}\n`);
  writeAtomic(join(dir, kindPointer(attempt.kind)), `${attempt.attemptId}\n`);
  // `current` stays the last writer. The manifest gate must not use it alone.
  writeAtomic(join(dir, 'current'), `${attempt.attemptId}\n`);
  return file;
}

function otherStagePlanPath(cwd: string): string {
  return join(attemptsDirectory(cwd), 'other-stage.json');
}

function recordOtherStagePlan(cwd: string, commands: readonly string[]): void {
  writeAtomic(otherStagePlanPath(cwd), `${JSON.stringify([...commands])}\n`);
}

function readOtherStagePlan(cwd: string): string[] {
  const path = otherStagePlanPath(cwd);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('malformed other-stage inventory');
  }
  if (!Array.isArray(parsed)) throw new Error('malformed other-stage inventory');
  const commands: string[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'string') throw new Error('malformed other-stage inventory');
    commands.push(item);
  }
  return commands;
}

export function persistOtherStageInventory(
  cwd: string,
  commands: readonly string[]
): EvidenceAttempt {
  const members = commands.map(command => otherStageMember(command, cwd, ''));
  const attempt = shellAttempt(cwd, 'tests', 'other-stage', members);
  attempt.aggregate = aggregateOf(members);
  if (!attempt.attemptId.endsWith('-other-stage')) {
    attempt.attemptId = `${attempt.attemptId}-other-stage`;
  }
  const dir = attemptsDirectory(cwd);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, `${attempt.attemptId}.json`), `${JSON.stringify(attempt, null, 2)}\n`);
  writeAtomic(join(dir, 'inventory-other-stage'), `${attempt.attemptId}\n`);
  recordOtherStagePlan(cwd, commands);
  return attempt;
}

function blankMember(raw: string, cwd: string, logPath: string): AttemptMember {
  return {
    rawCommand: raw,
    argv: [],
    resolvedArgv: [],
    resolvedExecutable: '',
    declaredExecutable: '',
    cwd,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    signal: null,
    status: 'INCOMPLETE',
    reason: 'planned',
    logPath,
    passed: null,
    total: null,
    scope: 'selected',
    chain: [],
  };
}

function otherStageMember(raw: string, cwd: string, logPath: string): AttemptMember {
  const member = blankMember(raw, cwd, logPath);
  member.status = 'OTHER_STAGE';
  member.reason = 'other-stage';
  member.scope = 'other_stage';
  return member;
}

function appendOtherStageMembers(
  members: AttemptMember[],
  commands: readonly string[],
  cwd: string,
  logPath: string
): void {
  const seen = new Set(members.map(member => member.rawCommand));
  for (const command of commands) {
    const trimmed = command.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    members.push(otherStageMember(trimmed, cwd, logPath));
  }
}

function stagedOtherStageCommands(cwd: string, explicit: readonly string[]): string[] {
  if (explicit.length > 0) return [...explicit];
  return readOtherStagePlan(cwd);
}

function aggregateOf(members: readonly AttemptMember[]): EvidenceStatus {
  if (members.length === 0) return 'INCOMPLETE';
  const statuses = members
    .filter(member => member.scope === 'selected')
    .map(member => member.status);
  if (statuses.length === 0) return 'NOT_APPLICABLE';
  if (statuses.every(status => status === 'PASSED')) return 'PASSED';
  if (statuses.some(status => status === 'FAILED')) return 'FAILED';
  if (
    statuses.some(status => status === 'NEVER_RAN') ||
    statuses.some(status => status === 'INCOMPLETE')
  ) {
    return 'INCOMPLETE';
  }
  if (statuses.some(status => status === 'COUNTS_UNPARSED')) return 'COUNTS_UNPARSED';
  return 'INCOMPLETE';
}

function recordedSource(source: string): string {
  const sha = process.env.SER_MAP_SHA ?? '';
  if (source === 'project-map' && sha.length > 0) return `project-map:${sha}`;
  return source;
}

function shellAttempt(
  cwd: string,
  kind: EvidenceAttempt['kind'],
  source: string,
  members: AttemptMember[]
): EvidenceAttempt {
  return {
    schemaVersion: 1,
    attemptId: newAttemptId(kind),
    kind,
    source: recordedSource(source),
    span: process.env.SER_SPAN ?? kind,
    runId: process.env.SER_RUN_ID ?? process.env.WORKFLOW_RUN_ID ?? 'local',
    authority: authorityFromEnv(cwd),
    tree: testedTreeIdentity(cwd),
    members,
    aggregate: 'INCOMPLETE',
  };
}

export function readAttemptById(cwd: string, attemptId: string): EvidenceAttempt | null {
  if (!safeAttemptId(attemptId)) return null;
  const file = join(attemptsDirectory(cwd), `${attemptId}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = evidenceAttemptSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readPointerAttempt(cwd: string, pointerName: string): EvidenceAttempt | null {
  const pointer = join(attemptsDirectory(cwd), pointerName);
  if (!existsSync(pointer)) return null;
  const id = readFileSync(pointer, 'utf8').trim();
  if (!safeAttemptId(id)) return null;
  return readAttemptById(cwd, id);
}

export function readCurrentAttempt(cwd: string): EvidenceAttempt | null {
  return readPointerAttempt(cwd, 'current');
}

export function readKindAttempt(
  cwd: string,
  kind: EvidenceAttempt['kind']
): EvidenceAttempt | null {
  return readPointerAttempt(cwd, kindPointer(kind));
}

function liveBoundRunId(): string | null {
  const ser = process.env.SER_RUN_ID ?? '';
  if (ser.length > 0) return ser;
  const workflow = process.env.WORKFLOW_RUN_ID ?? '';
  if (workflow.length > 0) return workflow;
  return null;
}

export function checkBoundAttempts(
  cwd: string,
  liveAuthority: EvidenceAuthority,
  binding: { testAttemptId: string | null; grepAttemptId: string | null }
): { ok: true } | { ok: false; reason: string } {
  if (!binding.testAttemptId && !binding.grepAttemptId) {
    return { ok: false, reason: 'missing-attempt' };
  }
  // Fresh grep evidence must not satisfy the gate without its test attempt.
  if (binding.grepAttemptId && !binding.testAttemptId) {
    return { ok: false, reason: 'missing-test-attempt' };
  }
  let testAttempt: EvidenceAttempt | null = null;
  let grepAttempt: EvidenceAttempt | null = null;
  if (binding.testAttemptId) {
    testAttempt = readAttemptById(cwd, binding.testAttemptId);
    if (!testAttempt) return { ok: false, reason: 'missing-test-attempt' };
    if (testAttempt.kind !== 'tests' || testAttempt.source === 'other-stage') {
      return { ok: false, reason: 'test-attempt-kind' };
    }
    const verdict = checkAttemptRecord(testAttempt, cwd, liveAuthority);
    if (!verdict.ok) return { ok: false, reason: `tests:${verdict.reason}` };
  }
  if (binding.grepAttemptId) {
    grepAttempt = readAttemptById(cwd, binding.grepAttemptId);
    if (!grepAttempt) return { ok: false, reason: 'missing-grep-attempt' };
    if (grepAttempt.kind !== 'greps') return { ok: false, reason: 'grep-attempt-kind' };
    const verdict = checkAttemptRecord(grepAttempt, cwd, liveAuthority);
    if (!verdict.ok) return { ok: false, reason: `greps:${verdict.reason}` };
  }
  if (testAttempt && grepAttempt && testAttempt.runId !== grepAttempt.runId) {
    return { ok: false, reason: 'run-id-mismatch' };
  }
  const liveRun = liveBoundRunId();
  if (liveRun) {
    if (testAttempt && testAttempt.runId !== liveRun) {
      return { ok: false, reason: 'tests:run-id' };
    }
    if (grepAttempt && grepAttempt.runId !== liveRun) {
      return { ok: false, reason: 'greps:run-id' };
    }
  }
  return { ok: true };
}

function samePathSet(a: TreeIdentity, b: TreeIdentity): boolean {
  if (a.paths.length !== b.paths.length) return false;
  for (let i = 0; i < a.paths.length; i += 1) {
    if (a.paths[i]?.path !== b.paths[i]?.path || a.paths[i]?.sha256 !== b.paths[i]?.sha256)
      return false;
  }
  return true;
}

function fileHash(cwd: string, path: string): string {
  try {
    return createHash('sha256')
      .update(readFileSync(join(cwd, path)))
      .digest('hex');
  } catch {
    return 'missing';
  }
}

function attemptCompletionVerdict(
  recorded: EvidenceAttempt
): { ok: true } | { ok: false; reason: string } {
  const selected = recorded.members.filter(member => member.scope === 'selected');
  if (recorded.aggregate === 'NOT_APPLICABLE' && selected.length === 0) return { ok: true };
  for (const member of selected) {
    if (member.status !== 'PASSED') {
      return { ok: false, reason: `member-not-passed:${member.rawCommand}` };
    }
  }
  // Legacy FP-4: passing assertions plus unparsed prose, with nothing dropped
  // or mismatched, stay admissible without labeling the aggregate PASSED.
  const executed = recorded.grepExecuted;
  const dropped = recorded.grepDropped;
  const unparsed = recorded.grepUnparsed;
  const mismatch = recorded.grepMismatch;
  if (
    recorded.kind === 'greps' &&
    recorded.aggregate === 'INCOMPLETE' &&
    executed !== undefined &&
    dropped !== undefined &&
    unparsed !== undefined &&
    mismatch !== undefined &&
    executed > 0 &&
    dropped === 0 &&
    mismatch === 0 &&
    unparsed > 0
  ) {
    return { ok: true };
  }
  if (recorded.aggregate !== 'PASSED') {
    return { ok: false, reason: `aggregate-${recorded.aggregate}` };
  }
  return { ok: true };
}

export function checkAttemptRecord(
  recorded: EvidenceAttempt,
  cwd: string,
  liveAuthority: EvidenceAuthority
): { ok: true } | { ok: false; reason: string } {
  attemptsDirectory(cwd);
  const parsed = evidenceAttemptSchema.safeParse(recorded);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  if (recorded.schemaVersion !== 1) return { ok: false, reason: 'schema' };
  if (liveAuthority.repo) {
    if (liveAuthority.repo.toLowerCase() !== recorded.authority.repo?.toLowerCase()) {
      return { ok: false, reason: 'authority-repo' };
    }
  }
  if (liveAuthority.stageId) {
    if (!recorded.authority.stageId || liveAuthority.stageId !== recorded.authority.stageId) {
      return { ok: false, reason: 'authority-stage' };
    }
  }
  if (liveAuthority.targetBranch) {
    if (
      !recorded.authority.targetBranch ||
      liveAuthority.targetBranch !== recorded.authority.targetBranch
    ) {
      return { ok: false, reason: 'authority-branch' };
    }
  }
  if (liveAuthority.baseSha) {
    if (!recorded.authority.baseSha || liveAuthority.baseSha !== recorded.authority.baseSha) {
      return { ok: false, reason: 'authority-base' };
    }
  }
  if (liveAuthority.worktree) {
    if (
      !recorded.authority.worktree ||
      resolve(liveAuthority.worktree) !== resolve(recorded.authority.worktree)
    ) {
      return { ok: false, reason: 'authority-worktree' };
    }
  }
  for (const member of parsed.data.members) {
    if (member.logPath) registerGeneratedPath(cwd, member.logPath);
  }
  const live = testedTreeIdentity(cwd);
  if (live.method === 'hash-failed' || recorded.tree.method === 'hash-failed') {
    return { ok: false, reason: 'hash-failed' };
  }
  if (live.method === 'not-a-git-worktree' || recorded.tree.method === 'not-a-git-worktree') {
    return recorded.tree.contentDigest === live.contentDigest &&
      recorded.tree.headSha === live.headSha
      ? attemptCompletionVerdict(recorded)
      : { ok: false, reason: 'tree' };
  }
  if (live.headSha === recorded.tree.headSha) {
    return samePathSet(live, recorded.tree)
      ? attemptCompletionVerdict(recorded)
      : { ok: false, reason: 'dirty-bytes' };
  }
  const ancestor = gitCapture(cwd, [
    'merge-base',
    '--is-ancestor',
    recorded.tree.headSha,
    live.headSha,
  ]);
  if (!ancestor.ok) return { ok: false, reason: 'ancestry' };
  const diff = gitCapture(cwd, [
    'diff',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--name-only',
    recorded.tree.headSha,
    live.headSha,
  ]);
  if (!diff.ok) return { ok: false, reason: 'diff' };
  const changed = new Set<string>();
  for (const path of diff.stdout.split('\0')) {
    if (path.length === 0) continue;
    changed.add(path);
  }
  const recordedPaths = new Set(recorded.tree.paths.map(item => item.path));
  for (const path of changed) {
    if (excludedIdentityPath(path)) continue;
    if (!recordedPaths.has(path)) return { ok: false, reason: 'clean-file-changed' };
    const previous = recorded.tree.paths.find(item => item.path === path);
    if (fileHash(cwd, path) !== previous?.sha256) return { ok: false, reason: 'committed-bytes' };
  }
  for (const item of recorded.tree.paths) {
    if (fileHash(cwd, item.path) !== item.sha256) return { ok: false, reason: 'worktree-bytes' };
  }
  for (const item of live.paths) {
    const previous = recorded.tree.paths.find(row => row.path === item.path);
    if (previous?.sha256 !== item.sha256) return { ok: false, reason: 'new-dirty' };
  }
  return attemptCompletionVerdict(recorded);
}

function rejectControls(command: string): string | null {
  for (let i = 0; i < command.length; i += 1) {
    const code = command.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return code < 0x20 ? 'control' : 'non-ascii';
  }
  return null;
}

function splitUnquotedPipes(
  command: string
): { ok: true; parts: string[] } | { ok: false; reason: string } {
  const bad = rejectControls(command);
  if (bad) return { ok: false, reason: bad };
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? '';
    if (ch === "'") {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && ch === '|') {
      if (command[i + 1] === '|') return { ok: false, reason: 'double-pipe' };
      if (current.trim().length === 0) return { ok: false, reason: 'empty-pipe' };
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quoted) return { ok: false, reason: 'unbalanced-quote' };
  if (current.trim().length === 0)
    return { ok: false, reason: parts.length === 0 ? 'empty' : 'empty-pipe' };
  parts.push(current);
  return { ok: true, parts };
}

function tokenizeSegment(
  segment: string
): { ok: true; decoded: string[] } | { ok: false; reason: string } {
  const decoded: string[] = [];
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"') return { ok: false, reason: 'double-quote' };
    if (ch === "'") {
      i += 1;
      let inner = '';
      let closed = false;
      while (i < segment.length) {
        const innerCh = segment[i] ?? '';
        if (innerCh === "'") {
          closed = true;
          i += 1;
          break;
        }
        inner += innerCh;
        i += 1;
      }
      if (!closed) return { ok: false, reason: 'unbalanced-quote' };
      if (inner.length === 0) return { ok: false, reason: 'empty-quote' };
      if (i < segment.length && segment[i] !== ' ' && segment[i] !== '\t') {
        return { ok: false, reason: 'adjacent-quote' };
      }
      if (
        inner.includes(';') ||
        inner.includes('`') ||
        inner.includes('$(') ||
        inner.includes('=>')
      ) {
        return { ok: false, reason: 'quoted-substitution' };
      }
      decoded.push(inner);
      continue;
    }
    let raw = '';
    while (i < segment.length && segment[i] !== ' ' && segment[i] !== '\t') {
      const bare = segment[i] ?? '';
      if (bare === '"') return { ok: false, reason: 'double-quote' };
      if (bare === "'") return { ok: false, reason: 'embedded-quote' };
      if (bare === '\\') return { ok: false, reason: 'bare-backslash' };
      if (bare === '$') return { ok: false, reason: 'bare-dollar' };
      if (bare === ';' || bare === '&' || bare === '`' || bare === '<' || bare === '>') {
        return { ok: false, reason: 'metacharacter' };
      }
      raw += bare;
      i += 1;
    }
    if (!bareTokenOk(raw)) return { ok: false, reason: 'bare-charset' };
    if (raw.includes('$(') || raw.includes('=>')) return { ok: false, reason: 'substitution' };
    decoded.push(raw);
  }
  if (decoded.length === 0) return { ok: false, reason: 'empty-segment' };
  return { ok: true, decoded };
}

function bareTokenOk(token: string): boolean {
  return token === '[' || token === ']' || ASSERT_CHARSET.test(token);
}

function peelLocale(decoded: readonly string[]): { env: Record<string, string>; argv: string[] } {
  const env: Record<string, string> = {};
  const argv: string[] = [];
  let i = 0;
  while (i < decoded.length) {
    const token = decoded[i] ?? '';
    const match = /^(LC_ALL|LANG)=(.*)$/.exec(token);
    if (!match) break;
    env[match[1] ?? ''] = match[2] ?? '';
    i += 1;
  }
  while (i < decoded.length) {
    argv.push(decoded[i] ?? '');
    i += 1;
  }
  return { env, argv };
}

function flagForms(token: string): string[] {
  const stripped = token.replace(/\\/g, '');
  return stripped === token ? [token] : [token, stripped];
}

function forbiddenGrepFlag(token: string): boolean {
  return flagForms(token).some(form => {
    if (form.startsWith('-f')) return true;
    if (form === '--file' || form.startsWith('--file=')) return true;
    if (form === '--pre' || form.startsWith('--pre=')) return true;
    if (form === '--preprocessor' || form.startsWith('--preprocessor=')) return true;
    return false;
  });
}

function forbiddenFindFlag(token: string): boolean {
  return flagForms(token).some(form => {
    if (
      form === '-exec' ||
      form === '-execdir' ||
      form === '-ok' ||
      form === '-okdir' ||
      form === '-delete'
    ) {
      return true;
    }
    if (form.startsWith('-fprint') || form.startsWith('-fls')) return true;
    return false;
  });
}

function forbiddenSortFlag(token: string): boolean {
  return flagForms(token).some(form => {
    if (form.startsWith('-o') && !form.startsWith('--')) return true;
    if (form === '--output' || form.startsWith('--output=')) return true;
    if (form === '--compress-program' || form.startsWith('--compress-program=')) return true;
    const decoded = form.replace(/\\/g, '');
    if (decoded === '--output' || decoded.startsWith('--output=')) return true;
    return false;
  });
}

function optionTokens(argv: readonly string[]): string[] {
  const out: string[] = [];
  let paths = false;
  for (const token of argv.slice(1)) {
    if (token === '--') {
      paths = true;
      continue;
    }
    if (!paths) out.push(token);
  }
  return out;
}

// find keeps interpreting expression predicates after `--`. Every decoded
// token after the runner name is an expression, including -delete/-exec/-fprint.
function findExpressionTokens(argv: readonly string[]): string[] {
  return argv.slice(1);
}

function allowGitArgv(
  argv: readonly string[]
): { ok: true; wrapped: string[] } | { ok: false; reason: string } {
  if (argv.length < 2) return { ok: false, reason: 'git-missing-subcommand' };
  const sub = argv[1] ?? '';
  if (!GIT_SUBS.has(sub)) return { ok: false, reason: 'git-subcommand' };
  const rest: string[] = [];
  let paths = false;
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (paths) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      paths = true;
      rest.push(token);
      continue;
    }
    if (
      GIT_OPTS.has(token) ||
      /^-n[0-9]+$/.test(token) ||
      /^-U[0-9]+$/.test(token) ||
      /^--unified=[0-9]+$/.test(token)
    ) {
      rest.push(token);
      continue;
    }
    if (token === '-n' || token === '-U') {
      const next = argv[i + 1];
      if (!next || !/^[0-9]+$/.test(next)) return { ok: false, reason: 'git-option' };
      rest.push(token, next);
      i += 1;
      continue;
    }
    if (token.startsWith('-')) return { ok: false, reason: 'git-option' };
    rest.push(token);
  }
  return {
    ok: true,
    wrapped: [
      'git',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.pager=cat',
      '--no-pager',
      sub,
      '--no-ext-diff',
      '--no-textconv',
      ...rest,
    ],
  };
}

export interface PlannedSegment {
  readonly argv: string[];
  readonly locale: Record<string, string>;
}

export function allowAssertion(
  command: string
): { ok: true; segments: PlannedSegment[] } | { ok: false; reason: string } {
  const split = splitUnquotedPipes(command);
  if (!split.ok) return split;
  const segments: PlannedSegment[] = [];
  for (const part of split.parts) {
    const tokens = tokenizeSegment(part);
    if (!tokens.ok) return tokens;
    const peeled = peelLocale(tokens.decoded);
    if (peeled.argv.length === 0) return { ok: false, reason: 'empty-segment' };
    const runner = peeled.argv[0] ?? '';
    if (runner === 'git') {
      const git = allowGitArgv(peeled.argv);
      if (!git.ok) return git;
      segments.push({ argv: git.wrapped, locale: peeled.env });
      continue;
    }
    if (GREP_RUNNERS.has(runner)) {
      if (optionTokens(peeled.argv).some(forbiddenGrepFlag))
        return { ok: false, reason: 'grep-flag' };
    } else if (runner === 'find') {
      if (findExpressionTokens(peeled.argv).some(forbiddenFindFlag)) {
        return { ok: false, reason: 'find-flag' };
      }
    } else if (runner === 'sort') {
      if (optionTokens(peeled.argv).some(forbiddenSortFlag))
        return { ok: false, reason: 'sort-flag' };
    } else if (!ASSERT_SIMPLE.has(runner)) {
      return { ok: false, reason: 'runner' };
    }
    segments.push({ argv: peeled.argv, locale: peeled.env });
  }
  return { ok: true, segments };
}

export interface AssertionStep {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly signal: string | null;
}

export interface AssertionExec {
  readonly stdout: string;
  readonly code: number;
  readonly upstreamError: boolean;
  readonly reason: string;
  readonly segments: PlannedSegment[];
  readonly steps: readonly AssertionStep[];
}

export function execAssertion(command: string, cwd: string): AssertionExec {
  const allowed = allowAssertion(command);
  if (!allowed.ok) {
    return {
      stdout: '',
      code: 127,
      upstreamError: true,
      reason: allowed.reason,
      segments: [],
      steps: [],
    };
  }
  const baseEnv = scrubEnv(process.env);
  let input = Buffer.alloc(0);
  let code = 0;
  let upstreamError = false;
  const steps: AssertionStep[] = [];
  for (const segment of allowed.segments) {
    const env = { ...baseEnv, ...segment.locale };
    const result = runArgv(segment.argv, cwd, env, input);
    steps.push({ argv: segment.argv, exitCode: result.code, signal: result.signal });
    const runner = segment.argv[0] ?? '';
    const benignGrep =
      GREP_RUNNERS.has(runner) && result.code === 1 && !result.timedOut && !result.missing;
    input = Buffer.from(result.stdout);
    if (result.missing || result.timedOut || (result.code !== 0 && !benignGrep)) {
      upstreamError = true;
      code = result.code;
      break;
    }
    code = result.code;
  }
  if (upstreamError) {
    return {
      stdout: '',
      code,
      upstreamError: true,
      reason: 'upstream-error',
      segments: allowed.segments,
      steps,
    };
  }
  return {
    stdout: input.toString('utf8'),
    code,
    upstreamError: false,
    reason: 'executed',
    segments: allowed.segments,
    steps,
  };
}

function assertionCount(result: AssertionExec): string {
  if (result.upstreamError) return 'ERR';
  const trimmed = result.stdout.replace(/\s/g, '');
  if (/^[0-9]+$/.test(trimmed)) return trimmed;
  if (trimmed.length === 0) return result.code <= 1 ? '0' : 'ERR';
  const lines = result.stdout.split('\n').filter(line => line.length > 0);
  return String(lines.length);
}

export function observeAssertion(command: string, cwd: string): string {
  const result = execAssertion(command, cwd);
  if (!allowAssertion(command).ok || result.upstreamError) return 'ERR';
  return assertionCount(result);
}

function isInlineFlag(token: string): boolean {
  if (INLINE_FLAGS.has(token)) return true;
  return [...INLINE_FLAGS].some(flag => token === flag || token.startsWith(`${flag}=`));
}

function isRepoScript(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('-')) return false;
  if (!/\.(js|mjs|cjs|ts|tsx|py|sh)$/.test(path)) return false;
  return !path.split('/').includes('..');
}

function tokensSafeTest(tokens: readonly string[]): boolean {
  return tokens.every(token => TEST_CHARSET.test(token));
}

function allowNodeTest(argv: readonly string[], cwd: string, checkLinks: boolean): boolean {
  if (argv[0] !== 'node' || !argv.includes('--test')) return false;
  const paths: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (token === '--test' || token === '--test-force-exit') continue;
    if (/^--test-concurrency=[0-9]+$/.test(token)) continue;
    if (/^--test-timeout=[0-9]+$/.test(token)) continue;
    if (/^--test-reporter=[A-Za-z]+$/.test(token)) continue;
    if (token.startsWith('-')) return false;
    paths.push(token);
  }
  if (paths.length === 0) return false;
  if (!paths.every(isRepoScript)) return false;
  if (!checkLinks) return true;
  const top = gitTop(cwd) ?? resolve(cwd);
  for (const path of paths) {
    const abs = resolve(cwd, path);
    if (isAbsolute(path)) return false;
    const rel = relative(top, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    try {
      const real = realpathSync(abs);
      const realRel = relative(realpathSync(top), real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface NormalizedTest {
  readonly ok: true;
  readonly cd: string | null;
  readonly segments: string[][];
}

export function normalizeTestCommand(
  command: string
): NormalizedTest | { ok: false; reason: string } {
  if (
    command.includes('{{') ||
    command.includes(';') ||
    command.includes('`') ||
    command.includes('$(')
  ) {
    return { ok: false, reason: 'metacharacter' };
  }
  if (command.includes('>') || command.includes('<') || command.includes('|')) {
    return { ok: false, reason: 'metacharacter' };
  }
  if (command.replace(/&&/g, '').includes('&')) return { ok: false, reason: 'background' };
  const parts = command
    .split('&&')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  if (parts.length === 0) return { ok: false, reason: 'empty' };
  const cds: string[] = [];
  const segments: string[][] = [];
  let firstCd = -1;
  let firstCmd = -1;
  parts.forEach((part, index) => {
    const cd = /^cd[ ]+([A-Za-z0-9_./-]+)$/.exec(part);
    if (cd) {
      if (firstCd < 0) firstCd = index;
      cds.push(cd[1] ?? '');
      return;
    }
    if (firstCmd < 0) firstCmd = index;
  });
  const unique = [...new Set(cds)];
  if (unique.length > 1) return { ok: false, reason: 'cd-mismatch' };
  if (firstCd >= 0 && firstCmd >= 0 && firstCmd < firstCd)
    return { ok: false, reason: 'cd-not-leading' };
  for (const part of parts) {
    if (/^cd[ ]+/.test(part)) continue;
    if (/(^|[ ;])(npm|npm\.cmd|pnpm|yarn|bun)[ ]+(ci|install|i|add)([ ]|$)/.test(part)) {
      return { ok: false, reason: 'install' };
    }
    const argv = part
      .trim()
      .split(/[ \t]+/)
      .filter(Boolean);
    if (argv.length < 2) return { ok: false, reason: 'bare-runner' };
    if (!tokensSafeTest(argv)) return { ok: false, reason: 'charset' };
    if (!allowTestArgv(argv)) return { ok: false, reason: 'argv' };
    segments.push(argv);
  }
  if (segments.length === 0) return { ok: false, reason: 'no-command' };
  return { ok: true, cd: unique[0] ?? null, segments };
}

function allowTestArgv(argv: readonly string[]): boolean {
  const runner = argv[0] ?? '';
  const rest = argv.slice(1);
  if (runner === 'node' && argv.includes('--test'))
    return allowNodeTest(argv, process.cwd(), false);
  switch (runner) {
    case 'python':
    case 'python3':
      if (rest[0] === '-m' && (rest[1] === 'pytest' || rest[1] === 'unittest')) {
        return !rest.slice(2).some(isInlineFlag);
      }
      return isRepoScript(rest[0] ?? '') && !rest.some(isInlineFlag);
    case 'node':
    case 'bash':
    case 'sh':
      return isRepoScript(rest[0] ?? '') && !rest.some(isInlineFlag);
    case 'bun':
      if (rest[0] === 'test' || rest[0] === 'run') {
        if (rest[0] === 'run' && !/^[A-Za-z0-9:_.-]+$/.test(rest[1] ?? '')) return false;
        return !rest.some(isInlineFlag);
      }
      return isRepoScript(rest[0] ?? '') && !rest.some(isInlineFlag);
    case 'npm':
      if (rest[0] !== 'test' && rest[0] !== 'run') return false;
      if (rest[0] === 'run' && !/^[A-Za-z0-9:_.-]+$/.test(rest[1] ?? '')) return false;
      return !rest.some(isInlineFlag);
    case 'npx':
    case 'bunx':
      return /^[A-Za-z0-9@/._-]+$/.test(rest[0] ?? '') && !rest.some(isInlineFlag);
    case 'pytest':
    case 'go':
    case 'cargo':
    case 'make':
      return !rest.some(isInlineFlag);
    default:
      return false;
  }
}

export function allowTestCommand(command: string): boolean {
  return normalizeTestCommand(command).ok;
}

function rewriteTestArgv(
  argv: string[],
  env: NodeJS.ProcessEnv
): { argv: string[]; note: string | null } {
  const npxName = process.env.RST_NPX_BIN ?? 'npx';
  const npmName = process.env.RST_NPM_BIN ?? 'npm';
  if (argv[0] === 'npx' && !commandExists(npxName, env)) {
    if (commandExists('bunx', env)) {
      const next = ['bunx', ...argv.slice(1)];
      return { argv: next, note: `rst_run_commands: npx not found, running as: ${next.join(' ')}` };
    }
    if (commandExists('bun', env)) {
      const next = ['bun', 'x', ...argv.slice(1)];
      return { argv: next, note: `rst_run_commands: npx not found, running as: ${next.join(' ')}` };
    }
  }
  if (argv[0] === 'npm' && !commandExists(npmName, env) && commandExists('bun', env)) {
    if (argv[1] === 'test') {
      const next = ['bun', 'run', 'test', ...argv.slice(2)];
      return { argv: next, note: `rst_run_commands: npm not found, running as: ${next.join(' ')}` };
    }
    if (argv[1] === 'run' && argv[2]) {
      const next = ['bun', 'run', ...argv.slice(2)];
      return { argv: next, note: `rst_run_commands: npm not found, running as: ${next.join(' ')}` };
    }
  }
  if (argv[0] === 'python') {
    return { argv: ['python3', ...argv.slice(1)], note: null };
  }
  return { argv, note: null };
}

function stripAnsi(raw: string): string {
  return raw.replace(new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, 'g'), '');
}

export function parseCounts(raw: string): { passed: number; total: number } | null {
  const esc = stripAnsi(raw);
  let passed = 0;
  let total = 0;
  let hit = false;
  for (const original of esc.split('\n')) {
    const line = original.replace(
      /^(@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*:test[ \t]+\|[ \t]*/,
      ''
    );
    const fields = line
      .trim()
      .split(/[ \t]+/)
      .filter(Boolean);
    if (/^[ \t]*Passed: [0-9]+[ \t]+Failed: [0-9]+[ \t]+Total: [0-9]+/.test(line)) {
      passed += Number(fields[1] ?? 0);
      total += Number(fields[5] ?? 0);
      hit = true;
      continue;
    }
    if (/^[ \t]*Tests: [0-9]+\/[0-9]+[ \t]*$/.test(line)) {
      const pair = (fields[1] ?? '0/0').split('/');
      passed += Number(pair[0] ?? 0);
      total += Number(pair[1] ?? 0);
      hit = true;
      continue;
    }
    if (/^[ \t]*Tests:.*[0-9]+ total/.test(line)) {
      for (let i = 0; i < fields.length - 1; i += 1) {
        const next = fields[i + 1];
        if (next === 'passed,' || next === 'passed') passed += Number(fields[i] ?? 0);
        if (next === 'total') total += Number(fields[i] ?? 0);
      }
      hit = true;
      continue;
    }
    if (/^[ \t]*Tests[ \t]+.*[0-9]+ passed.*\([0-9]+\)[ \t]*$/.test(line)) {
      for (let i = 0; i < fields.length - 1; i += 1) {
        if (fields[i + 1] === 'passed') passed += Number(fields[i] ?? 0);
      }
      const last = (fields[fields.length - 1] ?? '0').replace(/[()]/g, '');
      total += Number(last);
      hit = true;
      continue;
    }
    if (/^[ \t]*[0-9]+ pass[ \t]*$/.test(line)) {
      const n = Number(fields[0] ?? 0);
      passed += n;
      total += n;
      hit = true;
      continue;
    }
    if (/^[ \t]*[0-9]+ fail[ \t]*$/.test(line)) {
      total += Number(fields[0] ?? 0);
      hit = true;
      continue;
    }
    if (/(^|[^A-Za-z0-9])pass [0-9]+[ \t]*$/.test(line)) {
      const n = Number(fields[fields.length - 1] ?? 0);
      passed += n;
      total += n;
      hit = true;
      continue;
    }
    if (/(^|[^A-Za-z0-9])fail [0-9]+[ \t]*$/.test(line)) {
      total += Number(fields[fields.length - 1] ?? 0);
      hit = true;
      continue;
    }
    if (/^[ \t]*[0-9]+ passing/.test(line)) {
      const n = Number(fields[0] ?? 0);
      passed += n;
      total += n;
      hit = true;
      continue;
    }
    if (/^[ \t]*[0-9]+ failing/.test(line)) {
      total += Number(fields[0] ?? 0);
      hit = true;
      continue;
    }
    if (/^=+ .*[0-9]+ (passed|failed).* in [0-9.]+s/.test(line)) {
      for (let i = 0; i < fields.length - 1; i += 1) {
        const word = (fields[i + 1] ?? '').replace(/,/g, '');
        if (word === 'passed') {
          passed += Number(fields[i] ?? 0);
          total += Number(fields[i] ?? 0);
        } else if (word === 'failed' || word === 'error' || word === 'errors') {
          total += Number(fields[i] ?? 0);
        }
      }
      hit = true;
    }
  }
  if (!hit) {
    const pass = esc.split('\n').filter(line => /^(PASS|ok)([: ]|$)/.test(line)).length;
    const fail = esc.split('\n').filter(line => /^(FAIL|not ok)([: ]|$)/.test(line)).length;
    if (pass > 0 || fail > 0) return { passed: pass, total: pass + fail };
    return null;
  }
  return { passed, total };
}

export function displayCommands(commands: readonly string[]): string {
  const lines = commands.map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const prefixRe = /^cd[ ]+[A-Za-z0-9_./-]+[ ]+&&[ ]+/;
  const prefixes = lines.map(line => prefixRe.exec(line)?.[0] ?? '');
  if (lines.length > 1 && prefixes.every(prefix => prefix.length > 0 && prefix === prefixes[0])) {
    const prefix = prefixes[0] ?? '';
    const collapsed = lines.map((line, index) => (index === 0 ? line : line.slice(prefix.length)));
    return collapsed.join('; ');
  }
  return lines.join('; ');
}

export interface TestRunSummary {
  readonly line: string;
  readonly exitCode: number;
  readonly passed: number | null;
  readonly total: number | null;
  readonly failStep: string | null;
  readonly failDir: string | null;
  readonly attempt: EvidenceAttempt;
}

function publishTestSummary(
  members: readonly AttemptMember[],
  aggregate: EvidenceStatus,
  exitCode: number,
  hit: boolean,
  passed: number,
  total: number
): { line: string; exitCode: number; passed: number | null; total: number | null } {
  const selected = members.filter(member => member.scope === 'selected');
  const allPassed =
    exitCode === 0 &&
    aggregate === 'PASSED' &&
    selected.length > 0 &&
    selected.every(member => member.status === 'PASSED') &&
    hit &&
    passed === total &&
    total > 0;
  if (allPassed) {
    return { line: `${exitCode} ${passed} ${total}`, exitCode, passed, total };
  }
  const impossible = selected.some(
    member =>
      member.passed !== null &&
      member.total !== null &&
      (member.passed > member.total || member.passed < 0 || member.total < 0)
  );
  if (impossible) {
    const publishedExit = exitCode === 0 ? 1 : exitCode;
    return { line: `${publishedExit}  `, exitCode: publishedExit, passed: null, total: null };
  }
  const passedMember = selected.some(member => member.status === 'PASSED');
  const zeroCount = selected.some(member => member.reason === 'zero-count');
  if (passedMember && zeroCount && exitCode === 0) {
    return { line: '0 0 0', exitCode: 0, passed: 0, total: 0 };
  }
  const unparsed = selected.some(member => member.status === 'COUNTS_UNPARSED');
  if (passedMember && unparsed && exitCode === 0) {
    return { line: `${exitCode}  `, exitCode, passed: null, total: null };
  }
  // A passing segment must not hide a later zero-count or unparsed segment
  // in the same && chain. Member status alone misses that when counts were summed.
  const chainUnparsed =
    exitCode === 0 &&
    selected.some(member => member.chain.some(step => step.status === 'COUNTS_UNPARSED'));
  if (chainUnparsed) {
    return { line: `${exitCode}  `, exitCode, passed: null, total: null };
  }
  const chainZero =
    exitCode === 0 &&
    selected.some(member => member.chain.some(step => step.reason === 'zero-count'));
  if (chainZero) {
    return { line: '0 0 0', exitCode: 0, passed: 0, total: 0 };
  }
  if (hit) {
    // Counts summed across a chain can look like a pass (exit 0, passed == total > 0)
    // even when a later step is zero-count, unparsed, or otherwise not PASSED.
    const looksPassed = exitCode === 0 && passed === total && total > 0;
    if (looksPassed) {
      const steps = selected.flatMap(member => member.chain);
      const nonPassing =
        selected.some(member => member.status !== 'PASSED') ||
        steps.some(step => step.status !== 'PASSED');
      if (nonPassing) {
        const stepZeroCount =
          selected.some(member => member.reason === 'zero-count') ||
          steps.some(step => step.reason === 'zero-count');
        if (stepZeroCount) {
          return { line: '0 0 0', exitCode: 0, passed: 0, total: 0 };
        }
        return { line: `${exitCode}  `, exitCode, passed: null, total: null };
      }
    }
    return { line: `${exitCode} ${passed} ${total}`, exitCode, passed, total };
  }
  return { line: `${exitCode}  `, exitCode, passed: null, total: null };
}

export function runTestCommands(
  commands: readonly string[],
  cwd: string,
  logPath: string,
  otherStage: readonly string[] = []
): TestRunSummary {
  registerGeneratedPath(cwd, logPath);
  if (!trustedSelfMatches(cwd) && !trustedSelfMatches(process.cwd())) {
    mkdirSync(dirname(logPath), { recursive: true });
    const members = commands.map(command => {
      const member = blankMember(command, cwd, logPath);
      member.status = 'NEVER_RAN';
      member.reason = 'missing-trusted-runner';
      return member;
    });
    appendOtherStageMembers(members, stagedOtherStageCommands(cwd, otherStage), cwd, logPath);
    const attempt = shellAttempt(cwd, 'tests', process.env.SER_SOURCE ?? 'tests', members);
    attempt.aggregate = 'INCOMPLETE';
    try {
      persistAttempt(cwd, attempt);
    } catch {
      // evidence dir may be unwritable in a hostile cwd; the status is still NEVER_RAN
    }
    appendFileSync(logPath, 'rst_run_commands: NEVER_RAN missing trusted runner\n');
    return {
      line: '127  ',
      exitCode: 127,
      passed: null,
      total: null,
      failStep: null,
      failDir: null,
      attempt,
    };
  }
  const members = commands
    .filter(command => command.trim().length > 0)
    .map(command => blankMember(command.trim(), cwd, logPath));
  appendOtherStageMembers(members, stagedOtherStageCommands(cwd, otherStage), cwd, logPath);
  const attempt = shellAttempt(cwd, 'tests', process.env.SER_SOURCE ?? 'tests', members);
  persistAttempt(cwd, attempt);
  const env = scrubEnv(process.env);
  let exitCode = 0;
  let passed = 0;
  let total = 0;
  let hit = false;
  let anyStarted = false;
  let cdFailed: string | null = null;
  let testFailed = false;
  mkdirSync(dirname(logPath), { recursive: true });
  for (const member of members) {
    if (member.scope !== 'selected') continue;
    const output: string[] = [];
    appendFileSync(logPath, `### run-stop-tests: ${member.rawCommand}\n`);
    member.startedAt = new Date().toISOString();
    const normalized = normalizeTestCommand(member.rawCommand);
    if (!normalized.ok) {
      output.push('rst_run_commands: refusing non-runnable command\n');
      member.status = 'NEVER_RAN';
      member.reason = normalized.reason;
      member.exitCode = 1;
      member.endedAt = new Date().toISOString();
      if (exitCode === 0) exitCode = 1;
      appendFileSync(logPath, output.join(''));
      appendFileSync(logPath, '### exit 1\n');
      attempt.aggregate = aggregateOf(members);
      persistAttempt(cwd, attempt);
      continue;
    }
    member.argv = normalized.segments[0] ?? [];
    member.declaredExecutable = member.argv[0] ?? '';
    let workCwd = cwd;
    if (normalized.cd) {
      const target = resolve(cwd, normalized.cd);
      if (!existsSync(target)) {
        output.push(`rst_run_commands: cd ${normalized.cd} failed\n`);
        member.status = 'NEVER_RAN';
        member.reason = 'cd_failed';
        member.exitCode = 1;
        member.endedAt = new Date().toISOString();
        cdFailed = normalized.cd;
        if (exitCode === 0) exitCode = 1;
        appendFileSync(logPath, output.join(''));
        appendFileSync(logPath, '### exit 1\n');
        attempt.aggregate = aggregateOf(members);
        persistAttempt(cwd, attempt);
        continue;
      }
      workCwd = target;
    }
    member.cwd = workCwd;
    let rc = 0;
    let signal: string | null = null;
    let segmentEvidenceInvalid = false;
    for (const segment of normalized.segments) {
      if (
        segment[0] === 'node' &&
        segment.includes('--test') &&
        !allowNodeTest(segment, workCwd, true)
      ) {
        output.push('rst_run_commands: refusing non-runnable command\n');
        rc = 1;
        member.status = 'NEVER_RAN';
        member.reason = 'node-test-path';
        member.chain.push({
          argv: segment,
          resolvedArgv: segment,
          exitCode: 1,
          signal: null,
          passed: null,
          total: null,
          status: 'NEVER_RAN',
          reason: 'node-test-path',
        });
        break;
      }
      if (segment[0] === 'python' && !commandExists('python3', env)) {
        output.push('rst_run_commands: python3 unavailable\n');
        rc = 127;
        member.status = 'NEVER_RAN';
        member.reason = 'python3-unavailable';
        member.declaredExecutable = 'python';
        member.resolvedExecutable = 'python3';
        member.resolvedArgv = ['python3', ...segment.slice(1)];
        member.chain.push({
          argv: segment,
          resolvedArgv: member.resolvedArgv,
          exitCode: 127,
          signal: null,
          passed: null,
          total: null,
          status: 'NEVER_RAN',
          reason: 'python3-unavailable',
        });
        break;
      }
      const rewritten = rewriteTestArgv([...segment], env);
      if (rewritten.note) output.push(`${rewritten.note}\n`);
      member.resolvedArgv = rewritten.argv;
      member.resolvedExecutable = rewritten.argv[0] ?? '';
      if (member.declaredExecutable.length === 0) member.declaredExecutable = segment[0] ?? '';
      const result = runArgv(rewritten.argv, workCwd, env);
      output.push(result.stdout);
      if (result.stderr.length > 0) output.push(result.stderr);
      rc = result.code;
      signal = result.signal;
      const segmentCounts = parseCounts(`${result.stdout}${result.stderr}`);
      let segmentStatus: EvidenceStatus = 'PASSED';
      let segmentReason = 'passed';
      if (result.missing) {
        segmentStatus = 'NEVER_RAN';
        segmentReason = 'unavailable';
      } else if (result.timedOut || result.code !== 0 || result.signal) {
        segmentStatus = 'FAILED';
        segmentReason = result.timedOut ? 'timeout' : result.signal ? 'signal' : 'nonzero';
      } else if (!segmentCounts) {
        segmentStatus = 'COUNTS_UNPARSED';
        segmentReason = 'counts_unparsed';
      } else if (
        segmentCounts.total <= 0 ||
        segmentCounts.passed < 0 ||
        segmentCounts.passed !== segmentCounts.total
      ) {
        segmentStatus = 'FAILED';
        segmentReason = segmentCounts.total <= 0 ? 'zero-count' : 'count-mismatch';
      }
      if (segmentStatus !== 'PASSED') segmentEvidenceInvalid = true;
      member.chain.push({
        argv: segment,
        resolvedArgv: rewritten.argv,
        exitCode: result.code,
        signal: result.signal,
        passed: segmentCounts?.passed ?? null,
        total: segmentCounts?.total ?? null,
        status: segmentStatus,
        reason: segmentReason,
      });
      if (result.missing) {
        member.status = 'NEVER_RAN';
        member.reason = 'unavailable';
        break;
      }
      anyStarted = true;
      if (result.timedOut) {
        member.reason = 'timeout';
        member.status = 'FAILED';
        testFailed = true;
        break;
      }
      if (rc !== 0) break;
    }
    member.exitCode = rc;
    member.signal = signal;
    member.endedAt = new Date().toISOString();
    const counts = parseCounts(output.join(''));
    if (counts) {
      member.passed = counts.passed;
      member.total = counts.total;
      passed += counts.passed;
      total += counts.total;
      hit = true;
    }
    if (member.status === 'INCOMPLETE') {
      if (member.reason === 'timeout') {
        member.status = 'FAILED';
      } else if (rc !== 0 || signal) {
        member.status = 'FAILED';
        if (member.reason === 'planned') member.reason = signal ? 'signal' : 'nonzero';
        testFailed = true;
      } else if (segmentEvidenceInvalid) {
        const bad = member.chain.find(step => step.status !== 'PASSED');
        member.status = bad?.status ?? 'INCOMPLETE';
        member.reason = bad?.reason ?? 'incomplete-segment';
      } else if (!counts) {
        member.status = 'COUNTS_UNPARSED';
        member.reason = 'counts_unparsed';
      } else if (counts.total <= 0 || counts.passed !== counts.total || counts.passed < 0) {
        member.status = 'FAILED';
        member.reason = counts.total <= 0 ? 'zero-count' : 'count-mismatch';
      } else {
        member.status = 'PASSED';
        member.reason = 'passed';
      }
    }
    if (rc !== 0 && exitCode === 0) exitCode = rc;
    appendFileSync(logPath, output.join(''));
    appendFileSync(logPath, `### exit ${rc}\n`);
    attempt.aggregate = aggregateOf(members);
    persistAttempt(cwd, attempt);
  }
  let failStep: string | null = null;
  let failDir: string | null = null;
  if (cdFailed && !anyStarted) {
    failStep = 'cd_failed';
    failDir = cdFailed;
    appendFileSync(logPath, 'SER_FAIL_STEP=cd_failed\n');
    appendFileSync(logPath, `SER_FAIL_DIR=${cdFailed}\n`);
  } else if (testFailed) {
    failStep = 'test_failed';
    appendFileSync(logPath, 'SER_FAIL_STEP=test_failed\n');
  }
  attempt.aggregate = aggregateOf(members);
  persistAttempt(cwd, attempt);
  const published = publishTestSummary(members, attempt.aggregate, exitCode, hit, passed, total);
  return {
    line: published.line,
    exitCode: published.exitCode,
    passed: published.passed,
    total: published.total,
    failStep,
    failDir,
    attempt,
  };
}

function cleanExtract(value: string): string {
  return value
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]+$/, '')
    .replace(/`/g, '')
    .replace(/^\$ /, '');
}

const TEST_RUNNER_RE =
  /(^|[ /&|;(])(node|bun|bunx|npm|npm[.]cmd|npx|pnpm|yarn|vitest|jest|mocha|pytest|python3?|go|cargo|bash|sh|make|deno|dotnet|mvn|gradle|tap)( |$)/;

function isTestStopHeader(line: string): boolean {
  const match = /^[ \t]*[*]*[Ss]top [0-9A-Za-z.]+[ \t]*\(([^)]*)\)/.exec(line);
  if (!match) return false;
  const inner = (match[1] ?? '').toLowerCase();
  if (/(^|[^a-z])(grep|assert|ascii)([^a-z]|$)/.test(inner)) return false;
  return /(^|[^a-z])(tests|test|suites|suite|unit)([^a-z]|$)/.test(inner);
}

export function extractTestCommands(spec: string): string[] {
  const lines = spec.split(/\r?\n/);
  const seen = new Set<string>();
  const out: string[] = [];
  const emit = (value: string): void => {
    const cleaned = cleanExtract(value);
    if (cleaned.length > 0 && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  };
  let state = 0;
  let command = '';
  let inSection = false;
  for (const raw of lines) {
    if (state === 2) {
      if (/^[ \t]*```/.test(raw)) continue;
      const pending = cleanExtract(raw);
      if (pending.length === 0) continue;
      if (/^[*]*[Ss]top [0-9A-Za-z.]+/.test(pending)) {
        state = 0;
      } else if (TEST_RUNNER_RE.test(pending)) {
        command = pending.replace(/[ \t]*\\$/, '');
        state = 1;
        continue;
      } else if (/^[Ee]xpected:/.test(pending)) {
        emit('MALFORMED:expected-without-command');
        continue;
      } else {
        state = 0;
      }
    }
    if (state === 1) {
      if (/^[ \t]*```/.test(raw)) continue;
      const line = cleanExtract(raw);
      if (line.length === 0) continue;
      if (/^[Ee]xpected:/.test(line)) {
        if (command.length > 0) emit(command);
        else emit('MALFORMED:expected-without-command');
        command = '';
        state = 2;
        continue;
      }
      if (/^[*]*[Ss]top [0-9A-Za-z.]+/.test(line)) {
        if (command.length > 0) emit(command);
        command = '';
        state = 0;
      } else {
        command = command.length === 0 ? line : `${command} ${line}`;
        command = command.replace(/[ \t]*\\$/, '');
        continue;
      }
    }
    if (state === 0 && isTestStopHeader(raw)) {
      state = 1;
      command = '';
      continue;
    }
    if (/^#+ /.test(raw)) {
      inSection =
        /[Ss]top [Cc]ondition|[Ss]top [Pp]oint|[Tt]est [Ss]cenario|[Tt]est [Pp]lan|[Vv]erification/.test(
          raw
        );
    }
    if (inSection || /^[ \t]*-?[ \t]*[*]*[Ww]hen[*]*:/.test(raw)) {
      const ticks = raw.match(/`[^`]+`/g) ?? [];
      for (const tick of ticks) {
        const body = tick.slice(1, -1);
        if (TEST_RUNNER_RE.test(body)) emit(body);
      }
    }
    if (/^[ \t]*Tests:[ \t]/.test(raw)) {
      const groups = raw.match(/\([^)]*\)/g) ?? [];
      for (const group of groups) {
        const body = group.slice(1, -1);
        if (TEST_RUNNER_RE.test(body)) emit(body);
      }
    }
  }
  if (state === 1 && command.length > 0) emit(command);
  return out.slice(0, 8);
}

function expectOp(text: string): string {
  const low = text.toLowerCase();
  let op = 'eq';
  if (/at least|>=|or more|or greater|minimum|no fewer/.test(low)) op = 'ge';
  else if (/at most|<=|or fewer|or less|maximum|no more/.test(low)) op = 'le';
  let n = '';
  if (/no output|nothing|none|empty|no match/.test(low)) n = '0';
  else {
    const match = /[0-9]+/.exec(text);
    if (match) n = match[0];
  }
  if (!n) return '';
  return `${op}\t${n}`;
}

export function extractGrepAssertions(spec: string): string[] {
  const lines = spec.split(/\r?\n/);
  const rows: string[] = [];
  let declared = 0;
  let parsed = 0;
  const unparsed: string[] = [];
  let state = 0;
  let command = '';
  let label = '';
  let inSection = false;
  let baseline = false;
  const note = (name: string): void => {
    unparsed.push(name.length > 0 ? name : 'unnamed grep stop condition');
  };
  for (const raw of lines) {
    if (state === 1) {
      if (/^[ \t]*```/.test(raw)) continue;
      const line = cleanExtract(raw);
      if (line.length === 0) continue;
      if (/^[Ee]xpected:/.test(line)) {
        const ex = line.replace(/^[Ee]xpected:[ \t]*/, '');
        const expected = expectOp(ex);
        if (command.length > 0 && expected.length > 0) {
          rows.push(`${command}\t${expected}`);
          parsed += 1;
        } else note(command.length > 0 ? command : label);
        state = 0;
        command = '';
        continue;
      }
      if (/^[*]*[Ss]top [0-9A-Za-z.]+/.test(line)) {
        note(command.length > 0 ? command : label);
        state = 0;
        command = '';
      } else {
        command = command.length === 0 ? line : `${command} ${line}`;
        command = command.replace(/[ \t]*\\$/, '');
        continue;
      }
    }
    if (/^[ \t]*[*]*[Ss]top [0-9A-Za-z.]+[ \t]*\(([Gg]rep|[Aa]ssert)/.test(raw)) {
      state = 1;
      command = '';
      label = cleanExtract(raw);
      declared += 1;
      continue;
    }
    if (/^#+ /.test(raw)) {
      inSection = /[Ss]top [Cc]ondition/.test(raw);
      baseline = false;
      continue;
    }
    if (inSection && /^[ \t]*[*_]*[Bb]aseline/.test(raw)) baseline = true;
    if (
      inSection &&
      baseline &&
      (/^[ \t]*$/.test(raw) || /^[ \t]*([0-9]+[.)]|[-*])[ \t]/.test(raw))
    ) {
      baseline = false;
    }
    if (
      inSection &&
      !baseline &&
      /`(LC_ALL=C |LANG=C )?(grep|egrep|fgrep|rg|find|wc|test|cat|head|tail)( |`)/.test(raw)
    ) {
      if (/baseline|untouched tree|before the fix|before this wo/.test(raw.toLowerCase())) continue;
      const match =
        /`(LC_ALL=C |LANG=C )?(grep|egrep|fgrep|rg|find|wc|test|cat|head|tail)[^`]*`/.exec(raw);
      if (!match) continue;
      const body = match[0].slice(1, -1);
      const rest = raw.slice((match.index ?? 0) + match[0].length);
      declared += 1;
      const expected = expectOp(rest);
      if (expected.length > 0) {
        rows.push(`${body}\t${expected}`);
        parsed += 1;
      } else note(body);
    }
  }
  if (state === 1) note(command.length > 0 ? command : label);
  if (unparsed.length > 0) rows.push(`UNPARSED\t${declared - parsed}\t${unparsed.join('; ')}`);
  else rows.push(`UNPARSED\t${declared - parsed}`);
  rows.push(`DECLARED\t${declared}`);
  return rows;
}

const STAGE_MARKERS: { readonly source: string; readonly re: RegExp }[] = [
  { source: String.raw`^\s*##+\s+Canonical\s+stages\b`, re: /^\s*##+\s+Canonical\s+stages\b/im },
  { source: String.raw`^\s*##+\s+Stages\b`, re: /^\s*##+\s+Stages\b/im },
  { source: String.raw`<!--\s*canonical-stages\s*-->`, re: /<!--\s*canonical-stages\s*-->/i },
  { source: String.raw`<!--\s*stages:\s*canonical\s*-->`, re: /<!--\s*stages:\s*canonical\s*-->/i },
];

export interface SelectedStagesBlock {
  readonly body: string;
  readonly reason: string;
  readonly candidates: number;
}

export function selectStagesBlock(
  spec: string
): SelectedStagesBlock | { ok: false; message: string } {
  const fence = /```ya?ml\s*\n([\s\S]*?)\n```/g;
  const candidates: { offset: number; body: string }[] = [];
  for (const match of spec.matchAll(fence)) {
    const body = match[1] ?? '';
    if (body.split('\n').some(line => line.startsWith('stages:'))) {
      candidates.push({ offset: match.index ?? 0, body });
    }
  }
  if (candidates.length === 0) {
    const lines = spec.split('\n');
    const out: string[] = [];
    let capturing = false;
    for (const line of lines) {
      if (!capturing) {
        if (line.startsWith('stages:')) {
          capturing = true;
          out.push(line);
        }
        continue;
      }
      if (line === '') {
        out.push(line);
        continue;
      }
      if (!(line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-'))) break;
      out.push(line);
    }
    if (out.length > 0) candidates.push({ offset: 0, body: out.join('\n') });
  }
  if (candidates.length === 0) {
    return { ok: false, message: 'FAIL: no `stages:` declaration found in spec.\n' };
  }
  for (const marker of STAGE_MARKERS) {
    for (const candidate of candidates) {
      const window = spec.slice(Math.max(0, candidate.offset - 600), candidate.offset);
      if (marker.re.test(window)) {
        marker.re.lastIndex = 0;
        return {
          body: candidate.body,
          reason: `explicit-marker:${marker.source}`,
          candidates: candidates.length,
        };
      }
      marker.re.lastIndex = 0;
    }
  }
  if (candidates.length === 1) {
    return { body: candidates[0]?.body ?? '', reason: 'single-stages-block', candidates: 1 };
  }
  return {
    ok: false,
    message:
      `FAIL: ${candidates.length} \`stages:\` blocks found but none is marked canonical. ` +
      "Add '<!-- canonical-stages -->' immediately before the declared executable block.\n",
  };
}

const YAML_TO_JSON = `
import json, os, sys

# Drop empty sys.path entries (python -c searches cwd) and the parser cwd
# before import. A product-worktree yaml.py must not satisfy "import yaml".
# python3 -I already omits the user site. Never put it back: user-site
# packages are user-writable, so importing yaml from there executes
# untrusted code. Fail closed when the trusted interpreter has no PyYAML.
_cwd = os.path.abspath(os.getcwd())
_kept = []
for _entry in sys.path:
    if _entry in ("", None):
        continue
    if os.path.abspath(_entry) == _cwd:
        continue
    _kept.append(_entry)
sys.path[:] = _kept
try:
    import yaml
except ImportError:
    sys.stderr.write("FAIL: python yaml module unavailable; cannot parse stages.\\n")
    sys.exit(1)
text = open(sys.argv[1], encoding="utf-8").read()
try:
    data = yaml.safe_load(text)
except yaml.YAMLError as exc:
    sys.stderr.write("FAIL: stages YAML parse error: %s\\n" % exc)
    sys.exit(1)
json.dump(data, sys.stdout)
`;

export interface StageContract {
  readonly id: string;
  readonly repo: string;
  readonly target_branch: string;
  readonly verify_commands: string[];
  readonly raw: Record<string, unknown>;
}

function validateStages(
  data: unknown
): { ok: true; stages: StageContract[] } | { ok: false; message: string } {
  const stages =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as { stages?: unknown }).stages
      : data;
  const list = Array.isArray(stages) ? stages : null;
  if (!list || list.length === 0)
    return { ok: false, message: 'FAIL: parsed `stages` is not a non-empty list.\n' };
  const required = [
    'id',
    'repo',
    'target_branch',
    'in_scope_files',
    'verify_commands',
    'readiness_bar',
  ];
  const readinessKeys = ['pr_open', 'ci_green', 'diff_review_clean', 'mergeable'];
  const out: StageContract[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const stage = list[i];
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      return { ok: false, message: `FAIL: stage ${i} is not a mapping.\n` };
    }
    const row = stage as Record<string, unknown>;
    for (const key of required) {
      if (!(key in row))
        return { ok: false, message: `FAIL: stage ${i} missing required key '${key}'.\n` };
    }
    const commands = row.verify_commands;
    if (!Array.isArray(commands) || commands.length === 0) {
      return {
        ok: false,
        message: `FAIL: stage ${i} 'verify_commands' must be a non-empty list.\n`,
      };
    }
    const bar = row.readiness_bar;
    if (!bar || typeof bar !== 'object' || Array.isArray(bar)) {
      return { ok: false, message: `FAIL: stage ${i} 'readiness_bar' must be a mapping.\n` };
    }
    const readiness = bar as Record<string, unknown>;
    for (const key of readinessKeys) {
      if (!(key in readiness)) {
        return { ok: false, message: `FAIL: stage ${i} 'readiness_bar' missing key '${key}'.\n` };
      }
      if (readiness[key] !== true) {
        return {
          ok: false,
          message: `FAIL: stage ${i} 'readiness_bar.${key}' must be true (no soft gates).\n`,
        };
      }
    }
    out.push({
      id: String(row.id),
      repo: String(row.repo),
      target_branch: String(row.target_branch),
      verify_commands: commands.map(item => String(item)),
      raw: row,
    });
  }
  return { ok: true, stages: out };
}

function parserChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (source.PATH !== undefined) out.PATH = source.PATH;
  if (source.LANG !== undefined) out.LANG = source.LANG;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.startsWith('LC_')) out[key] = value;
  }
  return out;
}

export function parseStagesYaml(
  yamlText: string
): { ok: true; stages: StageContract[] } | { ok: false; message: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ser-stages-'));
  try {
    const file = join(dir, 'stages.yaml');
    writeFileSync(file, yamlText);
    const result = spawnSync('python3', ['-I', '-c', YAML_TO_JSON, file], {
      cwd: dir,
      shell: false,
      encoding: 'utf8',
      timeout: 30_000,
      env: parserChildEnv(process.env),
    });
    if (result.status !== 0) {
      return { ok: false, message: result.stderr || 'FAIL: stages YAML parse error\n' };
    }
    try {
      return validateStages(JSON.parse(result.stdout || 'null'));
    } catch (error) {
      return {
        ok: false,
        message: `FAIL: stages YAML parse error: ${(error as Error).message}\n`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repoSlug(value: string): string {
  const match =
    /(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      value.trim()
    );
  return match?.[1]?.toLowerCase() ?? value.trim().toLowerCase();
}

export interface EvidenceScope {
  readonly mode: 'document' | 'stage';
  readonly stageId: string | null;
  readonly commands: string[];
  readonly otherStage: string[];
  readonly unresolved: boolean;
}

export function scopeEvidence(
  spec: string,
  authority: {
    stageId?: string | null;
    repo?: string | null;
    targetBranch?: string | null;
    baseSha?: string | null;
  }
): { ok: true; scope: EvidenceScope } | { ok: false; message: string } {
  const selected = selectStagesBlock(spec);
  if ('ok' in selected && !selected.ok) {
    if (selected.message.includes('no `stages:`')) {
      return {
        ok: true,
        scope: { mode: 'document', stageId: null, commands: [], otherStage: [], unresolved: false },
      };
    }
    return { ok: false, message: selected.message };
  }
  const block = selected as SelectedStagesBlock;
  const parsed = parseStagesYaml(block.body);
  if (!parsed.ok) return parsed;
  const stages = parsed.stages;
  const ids = stages.map(stage => stage.id);
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'FAIL: duplicate stage id\n' };
  if (stages.some(stage => stage.repo.trim().length === 0)) {
    return { ok: false, message: 'FAIL: stage repo is absent\n' };
  }
  const repos = stages.map(stage => repoSlug(stage.repo));
  if (new Set(repos).size !== repos.length)
    return { ok: false, message: 'FAIL: two stages share a repo\n' };
  let chosen: StageContract | undefined;
  if (authority.stageId) {
    const matches = stages.filter(stage => stage.id === authority.stageId);
    if (matches.length !== 1) return { ok: false, message: 'FAIL: stage id is not unique\n' };
    const match = matches[0];
    if (!match) return { ok: false, message: 'FAIL: stage id is not unique\n' };
    if (authority.repo && repoSlug(authority.repo) !== repoSlug(match.repo)) {
      return { ok: false, message: 'FAIL: authority repo does not match stage id\n' };
    }
    chosen = match;
  } else if (authority.repo) {
    const want = repoSlug(authority.repo);
    const matches = stages.filter(stage => repoSlug(stage.repo) === want);
    if (matches.length !== 1)
      return { ok: false, message: 'FAIL: ambiguous origin-only stage selection\n' };
    chosen = matches[0];
  } else {
    return { ok: false, message: 'FAIL: stage authority is missing\n' };
  }
  if (!chosen) return { ok: false, message: 'FAIL: stage was not selected\n' };
  if (authority.targetBranch && authority.targetBranch !== chosen.target_branch) {
    return { ok: false, message: 'FAIL: authority target branch mismatch\n' };
  }
  const declaredGlobalAssertions = extractGrepAssertions(spec).some(row => {
    const match = /^DECLARED\t(\d+)$/.exec(row);
    return match ? Number(match[1]) > 0 : false;
  });
  return {
    ok: true,
    scope: {
      mode: 'stage',
      stageId: chosen.id,
      commands: chosen.verify_commands,
      otherStage: stages
        .filter(stage => stage.id !== chosen?.id)
        .flatMap(stage => stage.verify_commands),
      unresolved: stages.length > 1 && declaredGlobalAssertions,
    },
  };
}

export function loadStageWorktreeAuthority(
  path: string,
  stageId: string
): EvidenceAuthority | null {
  if (!existsSync(path)) return null;
  const rows = JSON.parse(readFileSync(path, 'utf8')) as {
    stageId?: string;
    repo?: string;
    targetBranch?: string;
    worktreePath?: string;
    baseSha?: string;
  }[];
  const row = rows.find(item => item.stageId === stageId);
  if (!row) return null;
  return {
    repo: row.repo ?? '',
    stageId: row.stageId ?? stageId,
    targetBranch: row.targetBranch ?? null,
    worktree: row.worktreePath ?? '',
    baseSha: row.baseSha ?? '',
  };
}

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

function oneCommand(args: readonly string[]): string {
  const idx = args.indexOf('--');
  const parts = idx >= 0 ? args.slice(idx + 1) : args;
  if (parts.length !== 1) throw new Error('expected one raw command argument');
  return parts[0] ?? '';
}

function flagValue(args: readonly string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

function explicitAttemptId(args: readonly string[], flag: string, envName: string): string | null {
  const flagged = flagValue(args, flag);
  if (flagged && flagged.length > 0 && !flagged.startsWith('--')) return flagged;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

function requireTrustedCli(): boolean {
  if (trustedSelfMatches(process.cwd())) return true;
  process.stderr.write('NEVER_RAN missing trusted structured-evidence-runner\n');
  return false;
}

function runCli(): number {
  const args = process.argv.slice(2);
  const command = args[0] ?? '';
  try {
    if (command === 'allow-assertion') {
      if (!requireTrustedCli()) return 1;
      const allowed = allowAssertion(oneCommand(args.slice(1)));
      return allowed.ok ? 0 : 1;
    }
    if (command === 'allow-test') {
      if (!requireTrustedCli()) return 1;
      return allowTestCommand(oneCommand(args.slice(1))) ? 0 : 1;
    }
    if (command === 'exec-assertion') {
      if (!requireTrustedCli()) return 127;
      const result = execAssertion(oneCommand(args.slice(1)), process.cwd());
      process.stdout.write(result.stdout);
      return result.upstreamError ? result.code || 2 : result.code;
    }
    if (command === 'observe-assertion') {
      if (!requireTrustedCli()) {
        process.stdout.write('ERR');
        return 0;
      }
      process.stdout.write(observeAssertion(oneCommand(args.slice(1)), process.cwd()));
      return 0;
    }
    if (command === 'tokens-safe') {
      if (!requireTrustedCli()) return 1;
      const idx = args.indexOf('--');
      const tokens = idx >= 0 ? args.slice(idx + 1) : args.slice(1);
      return tokens.every(token => bareTokenOk(token)) ? 0 : 1;
    }
    if (command === 'argv-readonly') {
      if (!requireTrustedCli()) return 1;
      return allowAssertion(oneCommand(args.slice(1))).ok ? 0 : 1;
    }
    if (command === 'extract-tests') {
      if (!requireTrustedCli()) return 127;
      const spec = readStdin();
      const scope = scopeEvidence(spec, {
        stageId: process.env.SER_STAGE_ID ?? process.env.STAGE_ID ?? null,
        repo: process.env.SER_REPO ?? gitOrigin(process.cwd()),
        targetBranch: process.env.SER_TARGET_BRANCH ?? null,
      });
      if (!scope.ok) {
        process.stderr.write(scope.message);
        return 3;
      }
      if (scope.scope.mode === 'stage') {
        for (const line of scope.scope.commands) process.stdout.write(`${line}\n`);
        return 0;
      }
      for (const line of extractTestCommands(spec)) process.stdout.write(`${line}\n`);
      return 0;
    }
    if (command === 'extract-greps') {
      if (!requireTrustedCli()) return 127;
      const rows = extractGrepAssertions(readStdin());
      for (const row of rows) process.stdout.write(`${row}\n`);
      return 0;
    }
    if (command === 'run-tests') {
      const commandsPath = flagValue(args, '--commands');
      const logPath = flagValue(args, '--log');
      if (!commandsPath || !logPath)
        throw new Error('usage: run-tests --commands <file> --log <file>');
      if (!requireTrustedCli()) {
        appendFileSync(logPath, 'rst_run_commands: NEVER_RAN missing trusted runner\n');
        process.stdout.write('127  ');
        return 0;
      }
      const commands = readFileSync(commandsPath, 'utf8').split('\n');
      const summary = runTestCommands(commands, process.cwd(), resolve(logPath));
      process.stderr.write(`SER_TEST_ATTEMPT_ID=${summary.attempt.attemptId}\n`);
      process.stdout.write(summary.line);
      return 0;
    }
    if (command === 'run-greps') {
      if (!requireTrustedCli()) return 127;
      const priorTests = readKindAttempt(process.cwd(), 'tests');
      for (const member of priorTests?.members ?? []) {
        if (member.logPath) registerGeneratedPath(process.cwd(), member.logPath);
      }
      const lines = readStdin().split('\n');
      let declared = 0;
      let executed = 0;
      let dropped = 0;
      let unparsed = 0;
      let unparsedNames = '';
      let mismatch = 0;
      const details: string[] = [];
      const shown: string[] = [];
      const members: AttemptMember[] = [];
      const attempt = shellAttempt(process.cwd(), 'greps', 'greps', members);
      persistAttempt(process.cwd(), attempt);
      for (const line of lines) {
        if (line.length === 0) continue;
        if (line.startsWith('DECLARED\t')) {
          declared = Number(line.split('\t')[1] ?? 0);
          continue;
        }
        if (line.startsWith('UNPARSED\t')) {
          const parts = line.split('\t');
          unparsed = Number(parts[1] ?? 0);
          unparsedNames = parts.slice(2).join('\t');
          continue;
        }
        if (line.startsWith('UNRESOLVED_SCOPE\t')) continue;
        const [cmd, op, n] = line.split('\t');
        if (!cmd || !op || !n) continue;
        const member = blankMember(cmd, process.cwd(), '');
        members.push(member);
        attempt.members = members;
        persistAttempt(process.cwd(), attempt);
        const allowed = allowAssertion(cmd);
        if (!allowed.ok) {
          dropped += 1;
          member.status = 'NEVER_RAN';
          member.reason = allowed.reason;
          details.push(
            `DROPPED (not on read-only allowlist; not executed): ${cmd} => expected ${op} ${n}`
          );
          shown.push(`UNVERIFIED (dropped): ${cmd}`);
          continue;
        }
        member.argv = allowed.segments[0]?.argv ?? [];
        member.declaredExecutable = member.argv[0] ?? '';
        member.startedAt = new Date().toISOString();
        const ran = execAssertion(cmd, process.cwd());
        member.endedAt = new Date().toISOString();
        member.chain = ran.steps.map(step => ({
          argv: [...step.argv],
          resolvedArgv: [...step.argv],
          exitCode: step.exitCode,
          signal: step.signal,
          passed: null,
          total: null,
          status: step.exitCode === 0 && !step.signal ? 'PASSED' : 'FAILED',
          reason: step.exitCode === 0 && !step.signal ? 'passed' : 'assertion-error',
        }));
        const last = member.chain[member.chain.length - 1];
        member.resolvedArgv = last ? [...last.resolvedArgv] : [];
        member.resolvedExecutable = member.resolvedArgv[0] ?? '';
        if (last) {
          member.exitCode = last.exitCode;
          member.signal = last.signal;
        }
        const observed = assertionCount(ran);
        if (observed === 'ERR') {
          dropped += 1;
          member.status = 'FAILED';
          member.reason = 'error';
          details.push(`DROPPED (command errored): ${cmd} => expected ${op} ${n}`);
          shown.push(`UNVERIFIED (errored): ${cmd}`);
          continue;
        }
        executed += 1;
        const obs = Number(observed);
        const expected = Number(n);
        const holds =
          op === 'ge' ? obs >= expected : op === 'le' ? obs <= expected : obs === expected;
        if (holds) {
          member.status = 'PASSED';
          member.reason = 'passed';
          details.push(`OK: ${cmd} => ${observed} (expected ${op} ${n})`);
        } else {
          mismatch += 1;
          member.status = 'FAILED';
          member.reason = 'mismatch';
          details.push(`MISMATCH: ${cmd} => ${observed} (expected ${op} ${n})`);
        }
        shown.push(`${cmd} => ${observed}`);
        persistAttempt(process.cwd(), attempt);
      }
      let status = 'passed';
      let out = shown.join('; ');
      if (declared === 0) {
        status = 'none_declared';
        out = 'N/A (spec declares no grep stop conditions)';
      } else if (executed === 0) {
        status = 'all_dropped';
        out = `N/A (${declared} declared grep stop condition(s) but none executable under the read-only allowlist)`;
        if (unparsed > 0)
          out += `; UNVERIFIED (unparsed): ${unparsedNames || `${unparsed} unnamed assertion(s)`}`;
      } else if (mismatch > 0) {
        status = 'mismatch';
      } else if (executed !== declared || dropped > 0 || unparsed > 0) {
        status = 'incomplete';
        if (unparsed > 0) {
          out = `${out}${out ? '; ' : ''}UNVERIFIED (unparsed): ${unparsedNames || `${unparsed} unnamed assertion(s)`}`;
        }
      }
      attempt.aggregate =
        status === 'passed'
          ? 'PASSED'
          : status === 'none_declared'
            ? 'NOT_APPLICABLE'
            : 'INCOMPLETE';
      if (mismatch > 0 || (executed === 0 && declared > 0))
        attempt.aggregate = mismatch > 0 ? 'FAILED' : 'INCOMPLETE';
      attempt.grepExecuted = executed;
      attempt.grepDropped = dropped;
      attempt.grepUnparsed = unparsed;
      attempt.grepMismatch = mismatch;
      persistAttempt(process.cwd(), attempt);
      process.stderr.write(`SER_GREP_ATTEMPT_ID=${attempt.attemptId}\n`);
      process.stdout.write(
        `GREP_DECLARED=${declared}\nGREP_EXECUTED=${executed}\nGREP_DROPPED=${dropped}\nGREP_UNPARSED=${unparsed}\nGREP_MISMATCH=${mismatch}\nGREP_STATUS=${status}\nGREP_LINE=${out}\n`
      );
      if (details.length > 0)
        process.stdout.write(`--- per-assertion detail ---\n${details.join('\n')}\n`);
      return 0;
    }
    if (command === 'display-commands') {
      const lines = readStdin().split('\n');
      process.stdout.write(displayCommands(lines));
      return 0;
    }
    if (command === 'parse-stages') {
      if (!requireTrustedCli()) return 1;
      const specPath = args[1];
      const yamlOut = args[2];
      const jsonOut = args[3];
      if (!specPath || !yamlOut || !jsonOut)
        throw new Error('usage: parse-stages <spec> <yaml-out> <json-out>');
      const spec = readFileSync(specPath, 'utf8');
      const selected = selectStagesBlock(spec);
      if ('ok' in selected && !selected.ok) {
        process.stderr.write(selected.message);
        return 1;
      }
      const block = selected as SelectedStagesBlock;
      process.stderr.write(`stages-block-selected reason=${block.reason}\n`);
      process.stderr.write(`stages-block-candidates=${block.candidates}\n`);
      writeFileSync(yamlOut, block.body);
      process.stdout.write(`stages-yaml-extracted=${yamlOut}\n`);
      process.stdout.write(`stages-block-selection=${block.reason}\n`);
      const parsed = parseStagesYaml(block.body);
      if (!parsed.ok) {
        process.stderr.write(parsed.message);
        return 1;
      }
      writeFileSync(
        jsonOut,
        `${JSON.stringify(
          parsed.stages.map(stage => stage.raw),
          null,
          2
        )}\n`
      );
      process.stdout.write(`STAGE_COUNT=${parsed.stages.length}\n`);
      process.stdout.write(`STAGE_IDS=${parsed.stages.map(stage => stage.id).join(',')}\n`);
      process.stdout.write(`STAGES_ARTIFACT=${jsonOut}\n`);
      process.stdout.write('parse-stages PASS\n');
      return 0;
    }
    if (command === 'scope-evidence') {
      if (!requireTrustedCli()) return 127;
      const specPath = flagValue(args, '--spec');
      if (!specPath) throw new Error('usage: scope-evidence --spec <file>');
      const spec = readFileSync(specPath, 'utf8');
      const stageId = process.env.SER_STAGE_ID ?? process.env.STAGE_ID ?? null;
      let repo = process.env.SER_REPO ?? null;
      let targetBranch = process.env.SER_TARGET_BRANCH ?? null;
      let baseSha = process.env.SER_BASE_SHA ?? null;
      const worktrees = process.env.ARTIFACTS_DIR
        ? join(process.env.ARTIFACTS_DIR, 'stage-worktrees.json')
        : '';
      if (stageId && worktrees && existsSync(worktrees)) {
        const loaded = loadStageWorktreeAuthority(worktrees, stageId);
        if (loaded) {
          repo = repo ?? loaded.repo;
          targetBranch = targetBranch ?? loaded.targetBranch;
          baseSha = baseSha ?? loaded.baseSha;
        }
      }
      if (!repo) repo = gitOrigin(process.cwd()) || null;
      const scope = scopeEvidence(spec, { stageId, repo, targetBranch, baseSha });
      if (!scope.ok) {
        process.stderr.write(scope.message);
        return 3;
      }
      if (scope.scope.mode === 'stage') {
        if (scope.scope.otherStage.length > 0) {
          persistOtherStageInventory(process.cwd(), scope.scope.otherStage);
        } else {
          recordOtherStagePlan(process.cwd(), []);
        }
      }
      process.stdout.write(`MODE=${scope.scope.mode}\n`);
      if (scope.scope.stageId) process.stdout.write(`STAGE_ID=${scope.scope.stageId}\n`);
      for (const line of scope.scope.commands) process.stdout.write(`COMMAND=${line}\n`);
      for (const line of scope.scope.otherStage) process.stdout.write(`OTHER_STAGE=${line}\n`);
      if (scope.scope.unresolved) process.stdout.write('UNRESOLVED_GLOBAL=1\n');
      return 0;
    }
    if (command === 'check-attempt') {
      if (!requireTrustedCli()) return 1;
      const cwd = process.cwd();
      const explicitTests = explicitAttemptId(args, '--tests', 'SER_TEST_ATTEMPT_ID');
      const explicitGreps = explicitAttemptId(args, '--greps', 'SER_GREP_ATTEMPT_ID');
      const testAttemptId = explicitTests ?? readKindAttempt(cwd, 'tests')?.attemptId ?? null;
      const grepAttemptId = explicitGreps ?? readKindAttempt(cwd, 'greps')?.attemptId ?? null;
      const verdict = checkBoundAttempts(cwd, authorityFromEnv(cwd), {
        testAttemptId,
        grepAttemptId,
      });
      if (!verdict.ok) {
        process.stderr.write(`REFUSED ${verdict.reason}\n`);
        return 1;
      }
      process.stdout.write('OK\n');
      return 0;
    }
    process.stderr.write(
      'usage: structured-evidence-runner.ts <parse-stages|extract-tests|extract-greps|run-tests|run-greps|allow-assertion|exec-assertion|check-attempt>\n'
    );
    return 2;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(runCli());
}
