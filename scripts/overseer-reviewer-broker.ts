import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import {
  FABLE_MODEL,
  FABLE_POLICY,
  FABLE_CONFIG_ERROR,
  closedData,
  fableToken,
  parseFablePermits,
  readFableOperatorFile,
  type FablePermit,
} from '../packages/overseer/src/judge-transport';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { CODEX_JUDGE_CLI_VERSION as CODEX_VERSION } from '../packages/overseer/src/judge-transport';

const SPOOL = process.env.OVERSEER_REVIEW_SPOOL ?? '/var/lib/overseer-review';
const FORBIDDEN_ENV = /^(?:GITHUB_|GH_|ARCHON_)|(?:_TOKEN|_KEY|_SECRET)$/;

interface BrokerJob {
  version: 1;
  id: string;
  checkout: string;
  expectedHead: string;
  argv: string[];
  prompt?: string;
  /** Model jobs only: the trusted parent's configured model wall clock. */
  timeoutMs?: number;
  fablePermit?: FablePermit;
}

interface BrokerResult {
  id: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  uid: number;
  reason?: string;
  outputTruncated?: boolean;
  timedOut?: boolean;
  fableEvidence?: FableBrokerEvidence;
  checkPolicy?: typeof FABLE_POLICY;
}

const OUTPUT_LIMIT = 128 * 1024;
const EXECUTION_TIMEOUT_MS = 60_000;
/** A model job streams `codex exec --json` events, far larger than check output. */
const MODEL_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MODEL_TIMEOUT_MAX_MS = 30 * 60_000;

export interface FableBrokerEvidence {
  readonly policy: typeof FABLE_POLICY;
  readonly provider: 'claude';
  readonly model: typeof FABLE_MODEL;
  readonly executableSha256: string;
  readonly version: string;
  readonly accountBindingId: string;
  readonly invocationId: string;
  readonly requestId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly headSha: string;
  readonly permitId: string;
  readonly credentialEgressPassed: true;
}
export interface FableBrokerConfig {
  readonly version: 1;
  readonly modelBinding: {
    readonly executablePath: string;
    readonly executableSha256: string;
    readonly version: string;
    readonly catalogModelId: typeof FABLE_MODEL;
    readonly cliModelToken: string;
  };
  readonly accountBindings: readonly {
    readonly bindingId: string;
    readonly accountClass: 'ultra';
    readonly oauthSourceFile: string;
    readonly bindMode: 'read_only';
  }[];
}
export function parseFableBrokerConfig(text: string): FableBrokerConfig {
  try {
    if (Buffer.byteLength(text) > 65536) throw new Error();
    const root: unknown = JSON.parse(text);
    if (
      !closedData(root, ['version', 'modelBinding', 'accountBindings']) ||
      root.version !== 1 ||
      !Array.isArray(root.accountBindings) ||
      root.accountBindings.length > 100
    )
      throw new Error();
    const model = root.modelBinding;
    if (
      !closedData(model, [
        'executablePath',
        'executableSha256',
        'version',
        'catalogModelId',
        'cliModelToken',
      ]) ||
      typeof model.executablePath !== 'string' ||
      !isAbsolute(model.executablePath) ||
      typeof model.executableSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(model.executableSha256) ||
      typeof model.version !== 'string' ||
      !/^[\x20-\x7e]{1,160}$/.test(model.version) ||
      model.catalogModelId !== FABLE_MODEL ||
      !fableToken(model.cliModelToken)
    )
      throw new Error();
    const seen = new Set<string>();
    const bindings = root.accountBindings.map((entry: unknown) => {
      if (
        !closedData(entry, ['bindingId', 'accountClass', 'oauthSourceFile', 'bindMode']) ||
        !fableToken(entry.bindingId) ||
        entry.accountClass !== 'ultra' ||
        entry.bindMode !== 'read_only' ||
        typeof entry.oauthSourceFile !== 'string' ||
        !isAbsolute(entry.oauthSourceFile) ||
        seen.has(entry.bindingId)
      )
        throw new Error();
      seen.add(entry.bindingId);
      return Object.freeze({ ...entry });
    });
    return Object.freeze({
      version: 1,
      modelBinding: Object.freeze({ ...model }),
      accountBindings: Object.freeze(bindings),
    }) as unknown as FableBrokerConfig;
  } catch {
    throw new Error(FABLE_CONFIG_ERROR);
  }
}
export function loadFableBrokerConfig(
  env: Record<string, string | undefined> = process.env
): FableBrokerConfig | undefined {
  const path = env.OVERSEER_FABLE_BROKER_CONFIG_PATH;
  return path === undefined ? undefined : parseFableBrokerConfig(readFableOperatorFile(path));
}
/** Exact grammar. Neither work/model text nor the permit supplies CLI arguments. */
export function fableModelArgv(modelToken: string): string[] {
  if (!fableToken(modelToken)) throw new Error(FABLE_CONFIG_ERROR);
  return [
    '/model/cli',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--model',
    modelToken,
  ];
}
/** Fresh mount/PID/IPC/UTS namespace; check jobs alone also unshare network. */
export function fableNamespaceArgv(input: {
  scratch: string;
  executable?: string;
  account?: string;
  checkout?: string;
  argv: readonly string[];
}): string[] {
  const args = [
    'bwrap',
    '--die-with-parent',
    '--new-session',
    // The pinned Docker binary is explicitly non-setuid; mounts require this namespace.
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/usr/lib',
    '/usr/lib',
  ];
  if (lstatSync('/lib64', { throwIfNoEntry: false })) args.push('--ro-bind', '/lib64', '/lib64');
  args.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home',
    '--dir',
    '/home/model',
    '--dir',
    '/home/model/.claude',
    '--dir',
    '/empty-codex',
    '--bind',
    input.scratch,
    '/scratch',
    '--chdir',
    '/scratch',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/home/model',
    '--setenv',
    'CLAUDE_CONFIG_DIR',
    '/home/model/.claude',
    '--setenv',
    'CODEX_HOME',
    '/empty-codex',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8'
  );
  if (input.checkout)
    args.push(
      '--unshare-net',
      '--ro-bind',
      '/usr/bin',
      '/usr/bin',
      '--ro-bind',
      '/usr/local/bin',
      '/usr/local/bin',
      '--ro-bind',
      '/bin',
      '/bin',
      '--ro-bind',
      input.checkout,
      '/repo',
      '--chdir',
      '/repo'
    );
  else {
    if (!input.executable || !input.account) throw new Error('fable_binding_unavailable');
    args.push(
      '--dir',
      '/model',
      '--ro-bind',
      input.executable,
      '/model/cli',
      '--ro-bind',
      input.account,
      '/home/model/.claude/.credentials.json',
      '--ro-bind',
      '/etc/ssl/certs',
      '/etc/ssl/certs',
      '--ro-bind',
      '/etc/resolv.conf',
      '/etc/resolv.conf',
      '--ro-bind',
      '/etc/hosts',
      '/etc/hosts'
    );
  }
  return [...args, '--', ...input.argv];
}
/** Only init + one successful terminal result. Tool/assistant/additional frames refuse. */
export function decodeFableProtocol(
  text: string,
  expectedModel: string
): { text: string; observedModel: string } {
  try {
    const frames = text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    if (frames.length < 2 || frames.length > 64) throw new Error();
    const init = frames[0];
    const result = frames[frames.length - 1];
    const texts = frames.slice(1, -1);
    if (
      texts.some(
        frame =>
          frame.type !== 'assistant' ||
          frame.session_id !== init.session_id ||
          !frame.message ||
          typeof frame.message !== 'object' ||
          !Array.isArray((frame.message as { content?: unknown }).content) ||
          (frame.message as { content: unknown[] }).content.some(
            block =>
              !closedData(block, ['type', 'text']) ||
              block.type !== 'text' ||
              typeof block.text !== 'string'
          )
      )
    )
      throw new Error();
    if (
      init.type !== 'system' ||
      init.subtype !== 'init' ||
      init.model !== expectedModel ||
      !Array.isArray(init.tools) ||
      init.tools.length !== 0 ||
      !Array.isArray(init.mcp_servers) ||
      init.mcp_servers.length !== 0 ||
      result.type !== 'result' ||
      result.subtype !== 'success' ||
      result.is_error !== false ||
      typeof result.result !== 'string' ||
      !result.result.trim() ||
      typeof init.session_id !== 'string' ||
      result.session_id !== init.session_id
    )
      throw new Error();
    return { text: result.result, observedModel: expectedModel };
  } catch {
    throw new Error('fable_protocol_refused');
  }
}
/** Secrets remain private to the broker and never become evidence fields. */
export function fableEgressAllowed(stdout: string, stderr: string, credentials: string): boolean {
  try {
    const root: unknown = JSON.parse(credentials);
    const secrets: string[] = [];
    const visit = (value: unknown, key = ''): void => {
      if (typeof value === 'string' && /token|secret|password|key/i.test(key)) {
        if (!value.length) throw new Error();
        secrets.push(value);
      } else if (value && typeof value === 'object')
        for (const [name, child] of Object.entries(value)) visit(child, name);
    };
    visit(root);
    const text = `${stdout}\n${stderr}`;
    return (
      secrets.length > 0 &&
      !secrets.some(secret => text.includes(secret)) &&
      !/(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{8,})/i.test(
        text
      )
    );
  } catch {
    return false;
  }
}
function pinnedFableFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
    throw new Error('fable_binding_unavailable');
}
async function runFableJob(
  job: BrokerJob,
  scratch: string,
  config: FableBrokerConfig | undefined,
  limits: { timeoutMs: number; outputLimit: number }
): Promise<BrokerResult> {
  if (!config || !job.fablePermit) throw new Error('fable_binding_unavailable');
  const permit = parseFablePermits(JSON.stringify({ version: 1, entries: [job.fablePermit] }))[0];
  if (permit.headSha !== job.expectedHead || Date.parse(permit.expiresAt) <= Date.now())
    throw new Error('fable_permission_refused');
  const temp = join(scratch, 'isolated');
  await mkdir(temp, { recursive: true, mode: 0o700 });
  await chmod(scratch, 0o700);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: temp,
    CODEX_HOME: temp,
    LANG: 'C.UTF-8',
  };
  // BEFORE any legacy auth copy. Repository/check children receive no account capability.
  const head = await runBrokerProcess(
    fableNamespaceArgv({
      scratch: temp,
      checkout: job.checkout,
      argv: ['git', '-c', 'safe.directory=/repo', '-C', '/repo', 'rev-parse', 'HEAD'],
    }),
    temp,
    env
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== job.expectedHead)
    throw new Error('checkout_identity_failure');
  if (job.prompt === undefined) {
    const result = await runBrokerProcess(
      fableNamespaceArgv({
        scratch: temp,
        checkout: job.checkout,
        argv: job.argv.map(value => (value === job.checkout ? '/repo' : value)),
      }),
      temp,
      env,
      undefined,
      limits
    );
    return {
      id: job.id,
      uid: process.getuid?.() ?? -1,
      ok: result.exitCode === 0 && !result.timedOut && !result.outputTruncated,
      ...result,
      checkPolicy: FABLE_POLICY,
    };
  }
  if (JSON.stringify(job.argv) !== '["fable-model-only"]') throw new Error('model_argv_invalid');
  const binding = config.accountBindings.find(value => value.bindingId === permit.accountBindingId);
  if (!binding) throw new Error('fable_binding_unavailable');
  const model = config.modelBinding;
  pinnedFableFile(model.executablePath);
  pinnedFableFile(binding.oauthSourceFile);
  if (
    createHash('sha256').update(readFileSync(model.executablePath)).digest('hex') !==
    model.executableSha256
  )
    throw new Error('fable_binding_unavailable');
  const credentials = readFileSync(binding.oauthSourceFile, 'utf8');
  const wrapper = (argv: string[]): string[] =>
    fableNamespaceArgv({
      scratch: temp,
      executable: model.executablePath,
      account: binding.oauthSourceFile,
      argv,
    });
  const version = await runBrokerProcess(wrapper(['/model/cli', '--version']), temp, env);
  const help = await runBrokerProcess(wrapper(['/model/cli', '--help']), temp, env);
  if (
    !fableEgressAllowed(version.stdout + help.stdout, version.stderr + help.stderr, credentials) ||
    version.exitCode !== 0 ||
    version.stdout.trim() !== model.version ||
    help.exitCode !== 0 ||
    [
      '--tools',
      '--strict-mcp-config',
      '--mcp-config',
      '--disable-slash-commands',
      '--setting-sources',
      '--no-session-persistence',
      '--model',
      '--output-format',
    ].some(flag => !help.stdout.includes(flag))
  )
    throw new Error('fable_binding_unavailable');
  if (Date.parse(permit.expiresAt) <= Date.now()) throw new Error('fable_permission_refused');
  const result = await runBrokerProcess(
    wrapper(fableModelArgv(model.cliModelToken)),
    temp,
    env,
    job.prompt,
    { timeoutMs: job.timeoutMs ?? limits.timeoutMs, outputLimit: MODEL_OUTPUT_LIMIT }
  );
  if (!fableEgressAllowed(result.stdout, result.stderr, credentials))
    throw new Error('fable_credential_egress_refused');
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
    return {
      id: job.id,
      uid: process.getuid?.() ?? -1,
      ok: false,
      ...result,
      stdout: '',
      stderr: '',
    };
  const decoded = decodeFableProtocol(result.stdout, model.cliModelToken);
  return {
    id: job.id,
    uid: process.getuid?.() ?? -1,
    ok: true,
    ...result,
    stdout: decoded.text,
    stderr: '',
    fableEvidence: {
      policy: FABLE_POLICY,
      provider: 'claude',
      model: FABLE_MODEL,
      executableSha256: model.executableSha256,
      version: model.version,
      accountBindingId: binding.bindingId,
      invocationId: job.id,
      requestId: permit.requestId,
      workerId: permit.workerId,
      fencingToken: permit.fencingToken,
      headSha: job.expectedHead,
      permitId: permit.permitId,
      credentialEgressPassed: true,
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-child deadline and retained-output byte limit (S4). Read once from the
 * broker's own env -i start environment; the defaults apply in production.
 */
export function brokerLimits(env: Record<string, string | undefined> = process.env): {
  timeoutMs: number;
  outputLimit: number;
} {
  return {
    timeoutMs: positiveInteger(env.OVERSEER_REVIEW_CHECK_TIMEOUT_MS, EXECUTION_TIMEOUT_MS),
    outputLimit: positiveInteger(env.OVERSEER_REVIEW_OUTPUT_LIMIT_BYTES, OUTPUT_LIMIT),
  };
}
const PINNED_CODEX_PREFIX = ['bunx', '--offline', `@openai/codex@${CODEX_VERSION}`];

/** Model jobs: pinned sandbox argv through --cd <checkout>, then --model <token>. */
function isPinnedModelArgv(argv: string[], checkout: string): boolean {
  const expected = [
    ...PINNED_CODEX_PREFIX,
    '-c',
    'web_search="disabled"',
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=false',
    '--skip-git-repo-check',
    '--cd',
    checkout,
  ];
  if (argv.length !== expected.length + 2) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (argv[index] !== expected[index]) return false;
  }
  const model = argv[expected.length + 1];
  return argv[expected.length] === '--model' && typeof model === 'string' && model.length > 0;
}

/** Model jobs only: point the pinned argv's --cd at the reviewer's working copy. */
export function rebindModelArgv(argv: string[], checkout: string, workingCopy: string): string[] {
  const index = argv.indexOf('--cd');
  if (index < 0 || argv[index + 1] !== checkout) throw new Error('model_argv_invalid');
  return argv.map((value, position) => (position === index + 1 ? workingCopy : value));
}

/**
 * Model jobs run in a reviewer-only copy of the sealed checkout (#4291). codex
 * 0.159.2 builds `workspace-write` with bubblewrap, which must create mount
 * points (live: `.agents`) in the workspace root, and the sealed checkout is
 * read-only for the reviewer by design. The copy lives in this job's 0700
 * scratch, so it is removed with the scratch and the cached checkout stays
 * sealed.
 */
export async function prepareModelWorkingCopy(
  checkout: string,
  scratch: string,
  expectedHead: string,
  env: Record<string, string>
): Promise<string> {
  const workingCopy = join(scratch, 'co');
  const copied = await runBrokerProcess(
    ['cp', '-R', '--no-dereference', '--preserve=mode,timestamps', `${checkout}/.`, workingCopy],
    scratch,
    env,
    undefined,
    { timeoutMs: 120_000 }
  );
  if (copied.exitCode !== 0 || copied.timedOut || copied.outputTruncated)
    throw new Error('working_copy_failed');
  // The copy is the reviewer's own: writable throughout (the judge may run
  // tests), closed to everyone else at its root.
  const writable = await runBrokerProcess(['chmod', '-R', 'u+rwX', workingCopy], scratch, env);
  if (writable.exitCode !== 0) throw new Error('working_copy_failed');
  await chmod(workingCopy, 0o700);
  const head = await runBrokerProcess(
    ['git', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'],
    workingCopy,
    env
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== expectedHead)
    throw new Error('checkout_identity_failure');
  return workingCopy;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function validJob(value: unknown): value is BrokerJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<BrokerJob>;
  return (
    job.version === 1 &&
    typeof job.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(job.id) &&
    typeof job.checkout === 'string' &&
    /^[0-9a-f]{40}$/.test(job.expectedHead ?? '') &&
    Array.isArray(job.argv) &&
    job.argv.length > 0 &&
    job.argv.every(
      value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
    ) &&
    (job.prompt === undefined || typeof job.prompt === 'string') &&
    (job.timeoutMs === undefined ||
      (job.prompt !== undefined &&
        Number.isSafeInteger(job.timeoutMs) &&
        job.timeoutMs > 0 &&
        job.timeoutMs <= MODEL_TIMEOUT_MAX_MS))
  );
}

/**
 * Drop an incomplete trailing UTF-8 sequence left by a byte-limit cut, so the
 * decoded text re-encodes to at most the retained byte count (no U+FFFD).
 */
function trimPartialUtf8(bytes: Buffer): Buffer {
  let start = bytes.length - 1;
  let continuation = 0;
  while (start >= 0 && continuation < 3 && (bytes[start] & 0xc0) === 0x80) {
    start -= 1;
    continuation += 1;
  }
  if (start < 0) return bytes;
  const lead = bytes[start];
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return width > continuation + 1 ? bytes.subarray(0, start) : bytes;
}

export async function runBrokerProcess(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  prompt?: string,
  options: { timeoutMs?: number; outputLimit?: number } = {}
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
}> {
  const child = Bun.spawn(['setsid', '--', ...argv], {
    cwd,
    env,
    stdin: prompt === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Streaming capture bounded in BYTES across both streams. Chunks past the
  // limit are drained and discarded, so a flooding child can never grow the
  // broker's memory, and crossing the limit kills the whole process group.
  const limit = options.outputLimit ?? OUTPUT_LIMIT;
  const retained: { stdout: Uint8Array[]; stderr: Uint8Array[] } = { stdout: [], stderr: [] };
  let retainedBytes = 0;
  let outputTruncated = false;
  const killGroup = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  const consume = async (
    stream: ReadableStream<Uint8Array> | null,
    into: Uint8Array[]
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = limit - retainedBytes;
        if (value.byteLength > remaining) {
          if (remaining > 0) into.push(value.subarray(0, remaining));
          retainedBytes = limit;
          if (!outputTruncated) {
            outputTruncated = true;
            killGroup('SIGKILL');
          }
        } else {
          into.push(value);
          retainedBytes += value.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  const capture = Promise.all([
    consume(child.stdout, retained.stdout),
    consume(child.stderr, retained.stderr),
  ]);
  if (prompt !== undefined) {
    const stdin = child.stdin;
    if (!stdin) throw new Error('broker_stdin_unavailable');
    void Promise.resolve(stdin.write(prompt))
      .then(() => stdin.end())
      .catch(() => undefined);
  }
  let timer: Timer | undefined;
  let timedOut = false;
  const timeout = new Promise<number>(resolveTimeout => {
    timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => {
        killGroup('SIGKILL');
      }, 250).unref?.();
      resolveTimeout(124);
    }, options.timeoutMs ?? EXECUTION_TIMEOUT_MS);
  });
  const completed = (async (): Promise<number> => {
    const code = await child.exited;
    await capture;
    return code;
  })();
  const exitCode = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  if (exitCode === 124) await Promise.race([capture, Bun.sleep(1_000)]);
  // Belt and braces: never leave a descendant behind, even after a clean exit
  // of the group leader (a background child would otherwise outlive the job).
  killGroup('SIGKILL');
  const decode = (chunks: Uint8Array[]): string =>
    new TextDecoder().decode(
      trimPartialUtf8(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
    );
  return {
    exitCode,
    stdout: decode(retained.stdout),
    stderr: decode(retained.stderr),
    outputTruncated,
    timedOut,
  };
}

export async function processJob(
  path: string,
  spool = SPOOL,
  limits: { timeoutMs: number; outputLimit: number } = brokerLimits(),
  fableConfig?: FableBrokerConfig
): Promise<BrokerResult> {
  const id = basename(path, '.request.json');
  const scratch = join(spool, `${id}.scratch`);
  let fableJob = false;
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!validJob(raw) || raw.id !== id) throw new Error('invalid_job');
    const job = raw;
    fableJob = job.fablePermit !== undefined;
    const spoolReal = await realpath(spool);
    const checkout = await realpath(job.checkout);
    if (!inside(checkout, spoolReal)) throw new Error('checkout_outside_spool');
    const info = await stat(checkout);
    if (!info.isDirectory()) throw new Error('checkout_invalid');
    if (job.fablePermit !== undefined) return await runFableJob(job, scratch, fableConfig, limits);
    if (job.prompt !== undefined && !isPinnedModelArgv(job.argv, checkout)) {
      throw new Error('model_argv_invalid');
    }

    const codexHome = join(scratch, 'codex');
    const temp = join(scratch, 'tmp');
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await chmod(scratch, 0o700);
    const login = '/home/reviewer/.codex/auth.json';
    try {
      await copyFile(login, join(codexHome, 'auth.json'));
      await chmod(join(codexHome, 'auth.json'), 0o600);
    } catch {
      if (job.prompt !== undefined) throw new Error('reviewer_auth_missing');
    }
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/reviewer',
      TMPDIR: temp,
      CODEX_HOME: codexHome,
      LANG: 'C.UTF-8',
    };
    if (Object.keys(env).some(name => FORBIDDEN_ENV.test(name)))
      throw new Error('unsafe_environment');
    const head = await runBrokerProcess(
      ['git', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'],
      checkout,
      env
    );
    if (head.exitCode !== 0 || head.stdout.trim() !== job.expectedHead)
      throw new Error('checkout_identity_failure');

    const workdir =
      job.prompt === undefined
        ? checkout
        : await prepareModelWorkingCopy(checkout, scratch, job.expectedHead, env);
    const command =
      job.prompt === undefined
        ? [...PINNED_CODEX_PREFIX, '-C', checkout, 'sandbox', '--', ...job.argv]
        : rebindModelArgv(job.argv, checkout, workdir);
    if (job.prompt !== undefined && !isPinnedModelArgv(command, workdir)) {
      throw new Error('model_argv_invalid');
    }
    const version = await runBrokerProcess([...PINNED_CODEX_PREFIX, '--version'], workdir, env);
    if (version.exitCode !== 0 || !version.stdout.includes(CODEX_VERSION))
      throw new Error('landlock_unsupported');
    const jobLimits =
      job.prompt === undefined
        ? limits
        : {
            timeoutMs: job.timeoutMs ?? limits.timeoutMs,
            outputLimit: Math.max(limits.outputLimit, MODEL_OUTPUT_LIMIT),
          };
    const result = await runBrokerProcess(command, workdir, env, job.prompt, jobLimits);
    return {
      id,
      ok: result.exitCode === 0 && !result.outputTruncated && !result.timedOut,
      ...result,
      uid: process.getuid?.() ?? -1,
      ...(result.timedOut ? { reason: 'execution_timeout' } : {}),
      ...(result.outputTruncated ? { reason: 'output_limit_exceeded' } : {}),
    };
  } catch (error) {
    return {
      id,
      ok: false,
      exitCode: 125,
      stdout: '',
      stderr: '',
      uid: process.getuid?.() ?? -1,
      reason: fableJob
        ? 'fable_broker_refused'
        : error instanceof Error
          ? error.message
          : 'broker_failure',
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<never> {
  if (process.platform !== 'linux' || process.getuid?.() !== 1002)
    throw new Error('reviewer_identity_invalid');
  await mkdir(SPOOL, { recursive: true });
  await writeFile(join(SPOOL, 'ready.tmp'), `${process.pid}\n`, { mode: 0o640 });
  await rename(join(SPOOL, 'ready.tmp'), join(SPOOL, 'ready'));

  let fableConfig: FableBrokerConfig | undefined;
  try {
    fableConfig = loadFableBrokerConfig();
  } catch {
    /* Invalid configured capability remains disabled, never fallback. */
  }
  for (;;) {
    const names = (await readdir(SPOOL)).filter(name => name.endsWith('.request.json')).sort();
    for (const name of names) {
      const path = resolve(SPOOL, name);
      if (!inside(path, resolve(SPOOL))) continue;
      const result = await processJob(path, SPOOL, brokerLimits(), fableConfig);
      await writeFile(join(SPOOL, `${result.id}.result.tmp`), JSON.stringify(result), {
        mode: 0o640,
      });
      await rename(join(SPOOL, `${result.id}.result.tmp`), join(SPOOL, `${result.id}.result.json`));
      await rm(path, { force: true });
    }
    await Bun.sleep(25);
  }
}

if (import.meta.main) await main();
