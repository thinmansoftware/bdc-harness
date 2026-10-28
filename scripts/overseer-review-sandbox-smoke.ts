import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

const SPOOL = '/var/lib/overseer-review';
const CODEX_VERSION = '0.153.3';

async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv[0]} failed: ${stdout}${stderr}`);
}

if (process.platform !== 'linux') throw new Error('native_sandbox_requires_linux');
if (process.getuid?.() !== 1001) throw new Error('native_sandbox_requires_appuser_uid_1001');
try {
  await readFile(join(SPOOL, 'ready'), 'utf8');
} catch {
  throw new Error('reviewer_broker_unavailable');
}

const id = `smoke-${process.pid}-${Date.now()}`;
const requestRoot = await mkdtemp(join(SPOOL, `${id}-`));
const checkout = join(requestRoot, 'checkout');
const outside = join(SPOOL, `${id}.outside`);
const request = join(SPOOL, `${id}.request.json`);
const resultPath = join(SPOOL, `${id}.result.json`);
const server = createServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));

try {
  await mkdir(checkout, { mode: 0o750 });
  await command(['git', '-C', checkout, 'init', '-q']);
  await writeFile(join(checkout, 'allowed.txt'), 'allowed\n', { mode: 0o640 });
  await command(['git', '-C', checkout, 'add', 'allowed.txt']);
  await command([
    'git',
    '-C',
    checkout,
    '-c',
    'user.name=smoke',
    '-c',
    'user.email=smoke@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const headProc = Bun.spawn(['git', '-C', checkout, 'rev-parse', 'HEAD'], { stdout: 'pipe' });
  const head = (await new Response(headProc.stdout).text()).trim();
  if ((await headProc.exited) !== 0 || !/^[0-9a-f]{40}$/.test(head))
    throw new Error('fixture_head_invalid');
  await command(['chgrp', '-R', 'reviewer', requestRoot]);
  await command(['chmod', '-R', 'g+rX,o-rwx', requestRoot]);
  await writeFile(outside, 'outside-control\n', { mode: 0o660 });
  await command(['chgrp', 'reviewer', outside]);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback_control_start_failed');
  const url = `http://127.0.0.1:${address.port}`;
  if ((await (await fetch(url)).text()) !== 'ok') throw new Error('outside_network_control_failed');

  const probe = [
    'set -eu',
    'assert_denied() { name="$1"; shift; output="$("$@" 2>&1)" && { echo "FAIL: $name succeeded"; exit 1; }; printf "%s" "$output" | grep -Eqi "Permission denied|Operation not permitted|Landlock|EACCES|Connection refused|Could not connect to server|Network is unreachable|blocked" || { echo "FAIL: $name failed for an unexpected reason: $output"; exit 1; }; }',
    'test "$(id -u)" = 1002',
    'test "$(cat allowed.txt)" = allowed',
    'assert_denied secret_read cat /run/secrets/thinman-overseer.pem',
    'assert_denied appuser_auth_read cat /home/appuser/.codex/auth.json',
    'assert_denied other_worktrees_read ls /.archon/workspaces',
    'assert_denied parent_environment_read cat /proc/1/environ',
    `assert_denied outside_write sh -c 'printf changed >> "$1"' write ${JSON.stringify(outside)}`,
    `assert_denied loopback_network curl -fsS ${JSON.stringify(url)}`,
    "if env | grep -Eq '^(GITHUB_|GH_|ARCHON_)|(_TOKEN|_KEY|_SECRET)='; then echo 'FAIL: credential environment succeeded'; exit 1; fi",
  ].join('\n');
  await writeFile(
    `${request}.tmp`,
    JSON.stringify({
      version: 1,
      id,
      checkout,
      expectedHead: head,
      argv: ['/bin/sh', '-c', probe],
    }),
    { mode: 0o640 }
  );
  await command(['chgrp', 'reviewer', `${request}.tmp`]);
  await rename(`${request}.tmp`, request);

  let result:
    | { ok?: boolean; uid?: number; reason?: string; stdout?: string; stderr?: string }
    | undefined;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      result = JSON.parse(await readFile(resultPath, 'utf8'));
      break;
    } catch {
      await Bun.sleep(25);
    }
  }
  if (!result) throw new Error('reviewer_broker_unavailable');
  if (!result.ok || result.uid !== 1002)
    throw new Error(
      `native_sandbox_failed:${result.reason ?? (result.stderr || result.stdout || 'unknown')}`
    );
  if ((await readFile(outside, 'utf8')) !== 'outside-control\n')
    throw new Error('sandbox_forbidden_write_succeeded');
  console.log(
    `overseer-review-sandbox-smoke: ok uid=1002 codex=${CODEX_VERSION} policy=use_legacy_landlock`
  );
} finally {
  server.close();
  await rm(requestRoot, { recursive: true, force: true });
  await rm(outside, { force: true });
  await rm(request, { force: true });
  await rm(resultPath, { force: true });
}
