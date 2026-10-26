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
import { basename, join, resolve, sep } from 'node:path';

const SPOOL = process.env.OVERSEER_REVIEW_SPOOL ?? '/var/lib/overseer-review';
const CODEX_VERSION = '0.153.3';
const FORBIDDEN_ENV = /^(?:GITHUB_|GH_|ARCHON_)|(?:_TOKEN|_KEY|_SECRET)$/;

interface BrokerJob {
  version: 1;
  id: string;
  checkout: string;
  expectedHead: string;
  argv: string[];
  prompt?: string;
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
}

const OUTPUT_LIMIT = 128 * 1024;
const EXECUTION_TIMEOUT_MS = 60_000;

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
    (job.prompt === undefined || typeof job.prompt === 'string')
  );
}

async function run(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  prompt?: string
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
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;
  const consume = async (
    stream: ReadableStream<Uint8Array> | null,
    append: (chunk: string) => void
  ): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  };
  const appendStdout = (chunk: string): void => {
    const remaining = OUTPUT_LIMIT - stdout.length - stderr.length;
    if (remaining <= 0) outputTruncated = true;
    else {
      stdout += chunk.slice(0, remaining);
      if (chunk.length > remaining) outputTruncated = true;
    }
  };
  const appendStderr = (chunk: string): void => {
    const remaining = OUTPUT_LIMIT - stdout.length - stderr.length;
    if (remaining <= 0) outputTruncated = true;
    else {
      stderr += chunk.slice(0, remaining);
      if (chunk.length > remaining) outputTruncated = true;
    }
  };
  const capture = Promise.all([
    consume(child.stdout, appendStdout),
    consume(child.stderr, appendStderr),
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
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 250).unref?.();
      resolveTimeout(124);
    }, EXECUTION_TIMEOUT_MS);
  });
  const completed = (async (): Promise<number> => {
    const code = await child.exited;
    await capture;
    return code;
  })();
  const exitCode = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  if (exitCode === 124) await Promise.race([capture, Bun.sleep(1_000)]);
  return { exitCode, stdout, stderr, outputTruncated, timedOut };
}

async function processJob(path: string): Promise<BrokerResult> {
  const id = basename(path, '.request.json');
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!validJob(raw) || raw.id !== id) throw new Error('invalid_job');
    const job = raw;
    const spoolReal = await realpath(SPOOL);
    const checkout = await realpath(job.checkout);
    if (!inside(checkout, spoolReal)) throw new Error('checkout_outside_spool');
    const info = await stat(checkout);
    if (!info.isDirectory()) throw new Error('checkout_invalid');

    const scratch = join(SPOOL, `${id}.scratch`);
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
    const head = await run(
      ['git', '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'],
      checkout,
      env
    );
    if (head.exitCode !== 0 || head.stdout.trim() !== job.expectedHead)
      throw new Error('checkout_identity_failure');

    const codex = '/app/node_modules/.bin/codex';
    const command =
      job.prompt === undefined
        ? [codex, '--enable', 'use_legacy_landlock', '-C', checkout, 'sandbox', '--', ...job.argv]
        : [
            codex,
            '--enable',
            'use_legacy_landlock',
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
    const version = await run([codex, '--version'], checkout, env);
    if (version.exitCode !== 0 || !version.stdout.includes(CODEX_VERSION))
      throw new Error('landlock_unsupported');
    const result = await run(command, checkout, env, job.prompt);
    await rm(scratch, { recursive: true, force: true });
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
      reason: error instanceof Error ? error.message : 'broker_failure',
    };
  }
}

if (process.platform !== 'linux' || process.getuid?.() !== 1002)
  throw new Error('reviewer_identity_invalid');
await mkdir(SPOOL, { recursive: true });
await writeFile(join(SPOOL, 'ready.tmp'), `${process.pid}\n`, { mode: 0o640 });
await rename(join(SPOOL, 'ready.tmp'), join(SPOOL, 'ready'));

for (;;) {
  const names = (await readdir(SPOOL)).filter(name => name.endsWith('.request.json')).sort();
  for (const name of names) {
    const path = resolve(SPOOL, name);
    if (!inside(path, resolve(SPOOL))) continue;
    const result = await processJob(path);
    await writeFile(join(SPOOL, `${result.id}.result.tmp`), JSON.stringify(result), {
      mode: 0o640,
    });
    await rename(join(SPOOL, `${result.id}.result.tmp`), join(SPOOL, `${result.id}.result.json`));
    await rm(path, { force: true });
  }
  await Bun.sleep(25);
}
