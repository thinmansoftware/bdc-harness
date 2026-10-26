import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CODEX_VERSION = '0.153.3';

interface ExplicitEnv {
  PATH: string;
  HOME: string;
  CODEX_HOME: string;
  TMPDIR: string;
}

function explicitEnv(scratch: string): ExplicitEnv {
  const pathValue = process.env.PATH;
  if (!pathValue) throw new Error('untrusted_execution_path_missing');
  return {
    PATH: pathValue,
    HOME: scratch,
    CODEX_HOME: scratch,
    TMPDIR: scratch,
  };
}

async function run(
  argv: string[],
  cwd: string | undefined,
  env: ExplicitEnv
): Promise<{ code: number; text: string }> {
  const child = Bun.spawn(argv, {
    cwd,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      CODEX_HOME: env.CODEX_HOME,
      TMPDIR: env.TMPDIR,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, text: `${stdout}\n${stderr}` };
}

function pathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/**
 * Sentinel lives outside the worktree, the fixture checkout, and the system
 * temp directory, and not inside a git root. Permissions stay at the default
 * so a later denial cannot be explained by mode bits.
 */
async function resolveOutsideSentinel(checkout: string): Promise<string> {
  const parent = '/home/appuser';
  const parentReal = await realpath(parent);
  const cwdReal = await realpath(process.cwd());
  const tmpReal = await realpath(tmpdir());
  const checkoutReal = await realpath(checkout);
  if (
    pathInside(parentReal, cwdReal) ||
    pathInside(parentReal, tmpReal) ||
    pathInside(parentReal, checkoutReal)
  ) {
    throw new Error('outside_sentinel_location_invalid');
  }
  const probe = await run(
    ['git', '-C', parentReal, 'rev-parse', '--show-toplevel'],
    undefined,
    explicitEnv(parentReal)
  );
  if (probe.code === 0) throw new Error('outside_sentinel_inside_git_root');
  return join(parentReal, `.overseer-sandbox-outside-${process.pid}`);
}

if (process.platform !== 'linux') throw new Error('native_sandbox_requires_linux');
if (process.getuid?.() !== 1001) throw new Error('native_sandbox_requires_appuser_uid_1001');

const root = await mkdtemp(join(tmpdir(), 'overseer-sandbox-smoke-'));
const checkout = join(root, 'checkout');
const scratch = join(root, 'private-state');
const server = createServer(socket => {
  socket.once('data', () =>
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
  );
});
let outside = '';

try {
  await mkdir(checkout, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await Bun.$`git -C ${checkout} init -q`;
  await writeFile(join(checkout, 'allowed.txt'), 'allowed\n');
  await Bun.$`git -C ${checkout} add allowed.txt`;
  await Bun.$`git -C ${checkout} -c user.name=smoke -c user.email=smoke@example.invalid commit -qm fixture`;

  outside = await resolveOutsideSentinel(checkout);
  await writeFile(outside, 'outside-control\n');
  if ((await readFile(outside, 'utf8')) !== 'outside-control\n') {
    throw new Error('outside_filesystem_read_control_failed');
  }
  await writeFile(outside, 'outside-control\noutside-write\n');
  if ((await readFile(outside, 'utf8')) !== 'outside-control\noutside-write\n') {
    throw new Error('outside_filesystem_write_control_failed');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback_control_start_failed');
  const url = `http://127.0.0.1:${address.port}`;
  const outsideNetwork = await fetch(url);
  if ((await outsideNetwork.text()) !== 'ok') throw new Error('outside_network_control_failed');

  const sandboxEnv = explicitEnv(scratch);
  const codexCandidates = [
    join(process.cwd(), 'node_modules/.bin/codex'),
    join(process.cwd(), 'node_modules/.bun/@openai+codex@0.153.3/node_modules/.bin/codex'),
  ];
  let codex = '';
  for (const candidate of codexCandidates) {
    try {
      await access(candidate);
      codex = candidate;
      break;
    } catch {
      /* try next pinned layout */
    }
  }
  if (!codex) throw new Error('pinned_codex_unavailable');
  const version = await run([codex, '--version'], checkout, sandboxEnv);
  if (version.code !== 0 || !version.text.includes(CODEX_VERSION)) {
    throw new Error('pinned_codex_unavailable');
  }
  const prefix = [codex, '--enable', 'use_legacy_landlock', '-C', checkout, 'sandbox', '--'];
  const allowed = await run(
    [...prefix, '/bin/sh', '-c', 'git rev-parse HEAD >/dev/null && test -r allowed.txt'],
    checkout,
    sandboxEnv
  );
  if (allowed.code !== 0)
    throw new Error(`sandbox_allowed_operation_failed:${allowed.text.trim()}`);

  const forbiddenRead = await run([...prefix, '/bin/cat', outside], checkout, sandboxEnv);
  if (forbiddenRead.code === 0) throw new Error('sandbox_forbidden_read_succeeded');
  const forbiddenWrite = await run(
    [...prefix, '/bin/sh', '-c', 'printf changed >> "$1"', 'sandbox-write', outside],
    checkout,
    sandboxEnv
  );
  if (forbiddenWrite.code === 0) throw new Error('sandbox_forbidden_write_succeeded');
  const forbiddenNetwork = await run(
    [...prefix, '/usr/bin/curl', '-fsS', url],
    checkout,
    sandboxEnv
  );
  if (forbiddenNetwork.code === 0) throw new Error('sandbox_forbidden_network_succeeded');

  console.log(
    `overseer-review-sandbox-smoke: ok uid=1001 codex=${CODEX_VERSION} policy=use_legacy_landlock`
  );
} finally {
  server.close();
  if (outside) await rm(outside, { force: true });
  await rm(root, { recursive: true, force: true });
}
