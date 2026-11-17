import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { CODEX_JUDGE_CLI_VERSION } from '../packages/overseer/src/judge-transport';
import { fableNamespaceArgv, prepareModelWorkingCopy } from './overseer-reviewer-broker';

const SPOOL = '/var/lib/overseer-review';
/**
 * codex >= 0.159 refuses legacy Landlock for a restricted filesystem policy and
 * builds the sandbox with bubblewrap instead. `--reviewer-bwrap` proves that
 * path as the reviewer user (WO-HARNESS-REVIEW-SANDBOX-BUBBLEWRAP-01).
 *
 * `--reviewer-bwrap` also runs the judge's own policy (`--sandbox
 * workspace-write`, network off) on the reviewer-only working copy the broker
 * builds from a sealed checkout, and prints a line ending `workspace-write`
 * (WO-HARNESS-REVIEW-JUDGE-WORKSPACE-WRITABLE-01). CI (test.yml, docker-build)
 * runs it as `docker exec --user reviewer ... --reviewer-bwrap` and greps both lines.
 */
const BWRAP_CODEX_VERSION = CODEX_JUDGE_CLI_VERSION;

async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${argv[0]} failed: ${stdout}${stderr}`);
}

async function run(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 180_000);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * Runs as the reviewer user (uid 1002) with an `env -i` environment. Drives
 * codex 0.159.2 `sandbox` WITHOUT use_legacy_landlock, so codex must build the
 * sandbox with bubblewrap, and asserts the same denials as the broker smoke:
 * no network, no write outside the checkout, no appuser codex login, no
 * secrets, no credential environment, no parent environment.
 */
async function reviewerBwrapSmoke(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('native_sandbox_requires_linux');
  if (process.getuid?.() !== 1002) throw new Error('bwrap_smoke_requires_reviewer_uid_1002');
  const bwrap = await run(['bwrap', '--version']);
  if (bwrap.code !== 0) throw new Error(`bwrap_missing:${bwrap.stderr}`);

  const root = await mkdtemp(join('/home/reviewer', `bwrap-smoke-${process.pid}-`));
  const checkout = join(root, 'checkout');
  const codexHome = join(root, 'codex');
  const temp = join(root, 'tmp');
  const outside = join(root, 'outside.txt');
  const server = createServer(socket =>
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
  );
  try {
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(codexHome, { mode: 0o700 });
    await mkdir(temp, { mode: 0o700 });
    await writeFile(join(checkout, 'allowed.txt'), 'allowed\n', { mode: 0o600 });
    // Writable by the reviewer under plain file permissions: only the
    // sandbox can stop the write below.
    await writeFile(outside, 'outside-control\n', { mode: 0o600 });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback_control_start_failed');
    const url = `http://127.0.0.1:${address.port}`;
    if ((await (await fetch(url)).text()) !== 'ok')
      throw new Error('outside_network_control_failed');

    const probe = [
      'set -eu',
      'assert_denied() { name="$1"; shift; output="$("$@" 2>&1)" && { echo "FAIL: $name succeeded"; exit 1; }; printf "%s" "$output" | grep -Eqi "Permission denied|Operation not permitted|Read-only file system|EACCES|EROFS|Connection refused|Could not connect to server|Network is unreachable|blocked" || { echo "FAIL: $name failed for an unexpected reason: $output"; exit 1; }; }',
      'test "$(id -u)" = 1002',
      'test "$(cat allowed.txt)" = allowed',
      'assert_denied secret_read cat /run/secrets/thinman-overseer.pem',
      'assert_denied appuser_auth_read cat /home/appuser/.codex/auth.json',
      'assert_denied other_worktrees_read ls /.archon/workspaces',
      `assert_denied outside_write sh -c 'printf changed >> "$1"' write ${JSON.stringify(outside)}`,
      `assert_denied loopback_network curl -fsS --max-time 5 ${JSON.stringify(url)}`,
      "if env | grep -Eq '^(GITHUB_|GH_|ARCHON_)|(_TOKEN|_KEY|_SECRET)='; then echo 'FAIL: credential environment succeeded'; exit 1; fi",
      "if tr '\\000' '\\n' < /proc/1/environ 2>/dev/null | grep -Eq '^(PORT|CLAUDE_USE_GLOBAL_AUTH|GITHUB_|GH_|ARCHON_)'; then echo 'FAIL: parent environment read succeeded'; exit 1; fi",
      'echo BWRAP_PROBE_OK',
    ].join('\n');
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/reviewer',
      TMPDIR: temp,
      CODEX_HOME: codexHome,
      LANG: 'C.UTF-8',
    };
    const codex = ['bunx', '--offline', `@openai/codex@${BWRAP_CODEX_VERSION}`];
    const version = await run([...codex, '--version'], { cwd: checkout, env });
    if (version.code !== 0 || !version.stdout.includes(BWRAP_CODEX_VERSION))
      throw new Error(`codex_version_mismatch:${version.stdout}${version.stderr}`);
    const result = await run([...codex, '-C', checkout, 'sandbox', '--', '/bin/sh', '-c', probe], {
      cwd: checkout,
      env,
    });
    const output = `${result.stdout}${result.stderr}`;
    if (/requires bubblewrap|bubblewrap is unavailable|panicked/.test(output))
      throw new Error(`native_sandbox_failed:${output}`);
    if (result.code !== 0 || !result.stdout.includes('BWRAP_PROBE_OK'))
      throw new Error(`native_sandbox_failed:exit=${result.code}:${output}`);
    if ((await readFile(outside, 'utf8')) !== 'outside-control\n')
      throw new Error('sandbox_forbidden_write_succeeded');
    console.log(
      `overseer-review-sandbox-smoke: ok uid=1002 codex=${BWRAP_CODEX_VERSION} policy=bubblewrap`
    );

    // The judge's own policy (#4291): `exec --sandbox workspace-write` with the
    // network off. bwrap must create mount points (`.agents`) in the workspace
    // root, which a sealed checkout refuses, so the broker runs model jobs in a
    // reviewer-only working copy. Prove that copy starts the judge's sandbox.
    const sealed = join(root, 'sealed');
    await mkdir(sealed, { mode: 0o700 });
    await writeFile(join(sealed, 'allowed.txt'), 'allowed\n', { mode: 0o600 });
    const git = (args: string[]): Promise<void> =>
      command([
        'git',
        '-C',
        sealed,
        '-c',
        'user.name=smoke',
        '-c',
        'user.email=smoke@example.invalid',
        ...args,
      ]);
    await git(['init', '-q']);
    await git(['add', 'allowed.txt']);
    await git(['commit', '-qm', 'fixture']);
    const headRun = await run(['git', '-C', sealed, 'rev-parse', 'HEAD'], { env });
    const head = headRun.stdout.trim();
    await command(['chmod', '-R', 'a-w', sealed]);
    const workspaceWrite = [
      ...codex,
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=false',
    ];
    const control = await run([...workspaceWrite, '-C', sealed, 'sandbox', '--', '/bin/true'], {
      cwd: sealed,
      env,
    });
    console.log(
      `overseer-review-sandbox-smoke: control sealed-checkout workspace-write exit=${control.code}`
    );
    const scratch = join(root, 'job.scratch');
    await mkdir(scratch, { mode: 0o700 });
    const copy = await prepareModelWorkingCopy(sealed, scratch, head, env);
    const judgeProbe = probe.replace(
      'echo BWRAP_PROBE_OK',
      'printf w > judge-write.txt && test "$(cat judge-write.txt)" = w\necho BWRAP_PROBE_OK'
    );
    const judge = await run(
      [...workspaceWrite, '-C', copy, 'sandbox', '--', '/bin/sh', '-c', judgeProbe],
      {
        cwd: copy,
        env,
      }
    );
    const judgeOutput = `${judge.stdout}${judge.stderr}`;
    if (/Can't mkdir|requires bubblewrap|panicked/.test(judgeOutput))
      throw new Error(`judge_sandbox_failed:${judgeOutput}`);
    if (judge.code !== 0 || !judge.stdout.includes('BWRAP_PROBE_OK'))
      throw new Error(`judge_sandbox_failed:exit=${judge.code}:${judgeOutput}`);
    if ((await readFile(outside, 'utf8')) !== 'outside-control\n')
      throw new Error('sandbox_forbidden_write_succeeded');
    console.log(
      `overseer-review-sandbox-smoke: ok uid=1002 codex=${BWRAP_CODEX_VERSION} policy=bubblewrap workspace-write`
    );
  } finally {
    server.close();
    await command(['chmod', '-R', 'u+w', root]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function brokerSmoke(): Promise<void> {
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
  const server = createServer(socket =>
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
  );

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
    if ((await (await fetch(url)).text()) !== 'ok')
      throw new Error('outside_network_control_failed');

    const probe = [
      'set -eu',
      'assert_denied() { name="$1"; shift; output="$("$@" 2>&1)" && { echo "FAIL: $name succeeded"; exit 1; }; printf "%s" "$output" | grep -Eqi "Permission denied|Operation not permitted|Read-only file system|Landlock|EACCES|EROFS|Connection refused|Could not connect to server|Network is unreachable|blocked" || { echo "FAIL: $name failed for an unexpected reason: $output"; exit 1; }; }',
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
      `overseer-review-sandbox-smoke: ok uid=1002 codex=${CODEX_JUDGE_CLI_VERSION} policy=bubblewrap`
    );
  } finally {
    server.close();
    await rm(requestRoot, { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(request, { force: true });
    await rm(resultPath, { force: true });
  }
}

/** Synthetic-only classification: never print captured child output, paths or account canaries. */
function fableFixtureFailure(result: { code: number; stdout: string; stderr: string }): string {
  const text = `${result.stdout}\n${result.stderr}`;
  const fixed =
    /fable_fixture_(?:read_allowed|parent_environment|account_binding|auth_writable|repository_binding|network_allowed|denial_unknown|model_network|network_denial_unknown|socket_allowed|socket_denial_unknown)/.exec(
      text
    )?.[0];
  if (fixed) return fixed;
  if (/bwrap:.*(?:namespace|unshare|permitted)/i.test(text)) return 'namespace_refused';
  if (/bwrap:.*(?:mount|bind|symlink|directory)/i.test(text)) return 'mount_refused';
  if (/bwrap:.*exec|not found|shared librar/i.test(text)) return 'runtime_unavailable';
  return 'unclassified';
}

/** Same production wrapper, fake local executable/account only; never provider traffic. */
async function fableSyntheticSmoke(): Promise<void> {
  const root = await mkdtemp('/tmp/fable-synthetic-');
  const scratch = join(root, 'scratch');
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  const account = join(root, 'oauth');
  const nonce = randomUUID();
  const server = createServer(socket =>
    socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${nonce.length}\r\n\r\n${nonce}`)
  );
  const socketPath = join(root, 'control.sock');
  const unixServer = createServer(socket => socket.end('synthetic'));
  try {
    await mkdir(scratch, { mode: 0o700 });
    await mkdir(repo, { mode: 0o700 });
    await writeFile(join(repo, 'repo-canary'), 'SYNTHETIC_REPO');
    await writeFile(outside, 'SYNTHETIC_CONTROLPLANE');
    await writeFile(account, '{"accessToken":"SYNTHETIC_ONLY"}', { mode: 0o600 });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => unixServer.listen(socketPath, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fable_fixture_control_failed');
    const url = `http://127.0.0.1:${address.port}`;
    if ((await (await fetch(url)).text()) !== nonce)
      throw new Error('fable_fixture_control_failed');
    const probe = `
      import { readFileSync, writeFileSync } from 'node:fs';
      const denied = path => { try { readFileSync(path); } catch (error) { if (['ENOENT','EACCES','EPERM'].includes(error.code)) return; throw new Error('fable_fixture_denial_unknown'); } throw new Error('fable_fixture_read_allowed'); };
      for (const path of ${JSON.stringify([outside, account, '/app/package.json', '/home/reviewer/.codex/auth.json', '/home/appuser/.codex/auth.json', '/proc/1/environ'])}) {
        if (path === '/proc/1/environ') { const text = readFileSync(path, 'utf8'); if (/GITHUB_|ARCHON_|_TOKEN=/.test(text)) throw new Error('fable_fixture_parent_environment'); }
        else denied(path);
      }
      denied(${JSON.stringify(`/proc/${process.pid}/environ`)});
      const { createConnection } = await import('node:net');
      await new Promise((resolve, reject) => { const socket = createConnection(${JSON.stringify(socketPath)}); socket.on('connect', () => { socket.destroy(); reject(new Error('fable_fixture_socket_allowed')); }); socket.on('error', error => ['ENOENT','EACCES','EPERM'].includes(error.code) ? resolve() : reject(new Error('fable_fixture_socket_denial_unknown'))); });
      writeFileSync('/scratch/permitted', 'isolated');
      if (process.argv.includes('model')) {
        denied('/repo/repo-canary');
        if (await (await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) })).text() !== ${JSON.stringify(nonce)}) throw new Error('fable_fixture_model_network');
        if (!readFileSync('/home/model/.claude/.credentials.json', 'utf8').includes('SYNTHETIC_ONLY')) throw new Error('fable_fixture_account_binding');
        try { writeFileSync('/home/model/.claude/.credentials.json', 'bad'); throw new Error('fable_fixture_auth_writable'); } catch (error) { if (error.message === 'fable_fixture_auth_writable') throw error; }
      } else {
        denied('/home/model/.claude/.credentials.json');
        if (readFileSync('/repo/repo-canary', 'utf8') !== 'SYNTHETIC_REPO') throw new Error('fable_fixture_repository_binding');
        try { await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1000) }); throw new Error('fable_fixture_network_allowed'); } catch (error) { if (!['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ConnectionRefused'].includes(error.code)) throw new Error('fable_fixture_network_denial_unknown'); }
      }
      console.log('FABLE_WRAPPER_OK');
    `;
    await writeFile(join(scratch, 'probe.ts'), probe);
    const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch };
    const model = await run(
      fableNamespaceArgv({
        scratch,
        executable: process.execPath,
        account,
        argv: ['/model/cli', '/scratch/probe.ts', 'model'],
      }),
      { cwd: scratch, env: cleanEnv }
    );
    if (model.code !== 0 || !model.stdout.includes('FABLE_WRAPPER_OK'))
      throw new Error(
        `fable_model_wrapper_failed:exit=${model.code}:class=${fableFixtureFailure(model)}`
      );
    const check = await run(
      fableNamespaceArgv({
        scratch,
        checkout: repo,
        argv: ['/usr/local/bin/bun', '/scratch/probe.ts', 'check'],
      }),
      { cwd: scratch, env: cleanEnv }
    );
    if (check.code !== 0 || !check.stdout.includes('FABLE_WRAPPER_OK'))
      throw new Error(
        `fable_check_wrapper_failed:exit=${check.code}:class=${fableFixtureFailure(check)}`
      );
    if ((await readFile(outside, 'utf8')) !== 'SYNTHETIC_CONTROLPLANE')
      throw new Error('fable_fixture_outside_mutated');
    if ((await readFile(account, 'utf8')) !== '{"accessToken":"SYNTHETIC_ONLY"}')
      throw new Error('fable_fixture_account_mutated');
    await rm(scratch, { recursive: true });
    try {
      await readFile(join(scratch, 'permitted'));
      throw new Error('fable_fixture_cleanup_failed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    console.log('overseer-fable-synthetic: ok');
  } finally {
    server.close();
    unixServer.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--reviewer-bwrap')) await reviewerBwrapSmoke();
else await brokerSmoke();

await fableSyntheticSmoke();
