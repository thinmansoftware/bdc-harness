import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CODEX_VERSION = '0.153.3';

async function run(argv: string[], cwd?: string): Promise<{ code: number; text: string }> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, text: `${stdout}\n${stderr}` };
}

if (process.platform !== 'linux') throw new Error('native_sandbox_requires_linux');
if (process.getuid?.() !== 1001) throw new Error('native_sandbox_requires_appuser_uid_1001');

const root = await mkdtemp(join(tmpdir(), 'overseer-sandbox-smoke-'));
const checkout = join(root, 'checkout');
const outside = join(process.cwd(), `.overseer-sandbox-outside-${process.pid}`);
const server = createServer(socket => {
  socket.once('data', () =>
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
  );
});

try {
  await Bun.$`mkdir -p ${checkout}`;
  await Bun.$`git -C ${checkout} init -q`;
  await writeFile(join(checkout, 'allowed.txt'), 'allowed\n');
  await Bun.$`git -C ${checkout} add allowed.txt`;
  await Bun.$`git -C ${checkout} -c user.name=smoke -c user.email=smoke@example.invalid commit -qm fixture`;
  await writeFile(outside, 'outside-control\n');
  if ((await readFile(outside, 'utf8')).trim() !== 'outside-control') {
    throw new Error('outside_filesystem_control_failed');
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
  const version = await run([codex, '--version']);
  if (version.code !== 0 || !version.text.includes(CODEX_VERSION)) {
    throw new Error('pinned_codex_unavailable');
  }
  const prefix = [codex, '--enable', 'use_legacy_landlock', '-C', checkout, 'sandbox', '--'];
  const allowed = await run(
    [...prefix, '/bin/sh', '-c', 'git rev-parse HEAD >/dev/null && test -r allowed.txt'],
    checkout
  );
  if (allowed.code !== 0)
    throw new Error(`sandbox_allowed_operation_failed:${allowed.text.trim()}`);

  const forbiddenRead = await run([...prefix, '/bin/cat', outside], checkout);
  if (forbiddenRead.code === 0) throw new Error('sandbox_forbidden_read_succeeded');
  const forbiddenWrite = await run(
    [...prefix, '/bin/sh', '-c', 'printf changed >> "$1"', 'sandbox-write', outside],
    checkout
  );
  if (forbiddenWrite.code === 0) throw new Error('sandbox_forbidden_write_succeeded');
  const forbiddenNetwork = await run([...prefix, '/usr/bin/curl', '-fsS', url], checkout);
  if (forbiddenNetwork.code === 0) throw new Error('sandbox_forbidden_network_succeeded');

  console.log(
    `overseer-review-sandbox-smoke: ok uid=1001 codex=${CODEX_VERSION} policy=use_legacy_landlock`
  );
} finally {
  server.close();
  await rm(outside, { force: true });
  await rm(root, { recursive: true, force: true });
}
