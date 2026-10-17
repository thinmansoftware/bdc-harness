// Non-model probe only. Run in a disposable credential-free container.
import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';

const cwd = '/workspace';
const home = '/home/appuser';
const binary =
  '/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
if (process.env.TEE_TIME_SANDBOX_PROBE !== '1') throw new Error('probe container required');
if (existsSync(`${home}/.codex/auth.json`)) throw new Error('credential-free probe required');
const env = { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', CODEX_HOME: `${home}/.codex` };
const version = Bun.spawnSync([binary, '--version'], { env });
if (version.exitCode !== 0 || version.stdout.toString().trim() !== 'codex-cli 0.153.3') {
  throw new Error('unreviewed Codex binary version');
}
mkdirSync(`${home}/.codex`, { recursive: true });
writeFileSync(`${home}/.codex/auth.json`, '{"OPENAI_API_KEY":"synthetic-not-a-credential"}\n');
writeFileSync('/protected/synthetic-secret.txt', 'synthetic fixture only\n');
writeFileSync(
  `${home}/.codex/config.toml`,
  `approval_policy = "never"
[permissions.tee-time]
extends = ":workspace"
[permissions.tee-time.filesystem]
":root" = "deny"
":minimal" = "read"
"/app" = "read"
":slash_tmp" = "deny"
":tmpdir" = "deny"
[permissions.tee-time.network]
enabled = false
`
);
const server = Bun.spawn(
  [
    'bun',
    '-e',
    'Bun.serve({hostname:"127.0.0.1",port:3999,fetch(){return new Response("probe")}})',
  ],
  { env, stdout: 'ignore', stderr: 'ignore' }
);
const results: Record<string, number> = {};
const peer = process.env.TEE_TIME_PROBE_PEER;
if (peer && !/^http:\/\/\d{1,3}(\.\d{1,3}){3}:3999$/.test(peer))
  throw new Error('invalid inspected peer address');
function run(name: string, args: string[], expected: 'success' | 'denied'): void {
  const result = Bun.spawnSync(args, { env, cwd, stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  if (result.signalCode) throw new Error(`${name}: process did not exit normally`);
  results[name] = result.exitCode;
  if (
    name !== 'invalid-profile' &&
    args[0] === binary &&
    !result.stdout.toString().includes('sandbox-command-started\n')
  ) {
    throw new Error(
      `${name}: sandbox did not start the probe command: ${result.stderr.toString()}`
    );
  }
  if ((expected === 'success') !== (result.exitCode === 0)) {
    throw new Error(`${name} failed: ${result.exitCode}: ${result.stderr.toString()}`);
  }
  if (name.startsWith('baseline-peer') && result.stdout.toString() !== 'teetime-peer')
    throw new Error('unexpected synthetic peer response');
  if (expected === 'denied' && name !== 'invalid-profile') {
    const expectedCode = name.includes('network') ? 7 : name.includes('write') ? 2 : 1;
    if (result.exitCode !== expectedCode)
      throw new Error(`${name}: unexpected denial code ${result.exitCode}`);
    const diagnostic = name.includes('network')
      ? /Failed to connect|Couldn't connect|Could not connect/i
      : /Permission denied|No such file|Read-only file system|Directory nonexistent/i;
    if (!diagnostic.test(result.stderr.toString()))
      throw new Error(`${name}: unexpected denial diagnostic`);
  }
}
const sandbox = [
  binary,
  'sandbox',
  '-P',
  'tee-time',
  '-C',
  cwd,
  'sh',
  '-c',
  'printf "sandbox-command-started\\n"; exec "$@"',
  'probe',
];
try {
  await Bun.sleep(300);
  if (peer) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ready = Bun.spawnSync(['curl', '--noproxy', '*', '-fsS', '--max-time', '1', peer], {
        env,
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 2000,
      });
      if (ready.exitCode === 0 && ready.stdout.toString() === 'teetime-peer') break;
      if (attempt === 4) throw new Error('synthetic peer readiness failed');
      await Bun.sleep(200);
    }
  }
  run('baseline-write', ['sh', '-c', 'echo baseline > /protected/write-probe'], 'success');
  run('baseline-read', ['cat', '/protected/synthetic-secret.txt'], 'success');
  run('baseline-auth-read', ['cat', `${home}/.codex/auth.json`], 'success');
  symlinkSync(`${home}/.codex/auth.json`, `${cwd}/auth-link`);
  symlinkSync('/protected/write-probe', `${cwd}/write-link`);
  run('baseline-network', ['curl', '-fsS', '--max-time', '2', 'http://127.0.0.1:3999'], 'success');
  if (peer)
    run(
      'baseline-peer-network',
      ['curl', '--noproxy', '*', '-fsS', '--max-time', '2', peer],
      'success'
    );
  run('workspace-write', [...sandbox, 'sh', '-c', 'echo allowed > allowed.txt'], 'success');
  run('outside-write', [...sandbox, 'sh', '-c', 'echo denied > /protected/write-probe'], 'denied');
  run('credential-read', [...sandbox, 'cat', '/protected/synthetic-secret.txt'], 'denied');
  run('codex-auth-read', [...sandbox, 'cat', `${home}/.codex/auth.json`], 'denied');
  run('symlink-auth-read', [...sandbox, 'cat', `${cwd}/auth-link`], 'denied');
  run('symlink-write', [...sandbox, 'sh', '-c', 'echo denied > write-link'], 'denied');
  run(
    'proc-auth-read',
    [...sandbox, 'cat', `/proc/${process.pid}/root${home}/.codex/auth.json`],
    'denied'
  );
  run(
    'tool-network',
    [...sandbox, 'curl', '-fsS', '--max-time', '2', 'http://127.0.0.1:3999'],
    'denied'
  );
  run(
    'nested-write',
    [...sandbox, 'sh', '-c', 'sh -c "echo denied > /protected/write-probe"'],
    'denied'
  );
  run('nested-read', [...sandbox, 'sh', '-c', 'cat /protected/synthetic-secret.txt'], 'denied');
  run('nested-auth-read', [...sandbox, 'sh', '-c', `cat ${home}/.codex/auth.json`], 'denied');
  run(
    'nested-network',
    [...sandbox, 'sh', '-c', 'curl -fsS --max-time 2 http://127.0.0.1:3999'],
    'denied'
  );
  if (peer) {
    run(
      'tool-peer-network',
      [...sandbox, 'curl', '--noproxy', '*', '-fsS', '--max-time', '2', peer],
      'denied'
    );
    run(
      'nested-peer-network',
      [
        ...sandbox,
        'sh',
        '-c',
        'exec "$@"',
        'peer',
        'curl',
        '--noproxy',
        '*',
        '-fsS',
        '--max-time',
        '2',
        peer,
      ],
      'denied'
    );
    run(
      'baseline-peer-network-after',
      ['curl', '--noproxy', '*', '-fsS', '--max-time', '2', peer],
      'success'
    );
  }
  run(
    'invalid-profile',
    [binary, 'sandbox', '-P', 'missing-profile', '-C', cwd, 'touch', 'unsafe.txt'],
    'denied'
  );
  if (existsSync(`${cwd}/unsafe.txt`)) throw new Error('invalid sandbox executed command');
  if (readFileSync(`${cwd}/allowed.txt`, 'utf8') !== 'allowed\n')
    throw new Error('workspace write missing');
  if (readFileSync('/protected/write-probe', 'utf8') !== 'baseline\n')
    throw new Error('protected file changed');
  run(
    'baseline-network-after',
    ['curl', '-fsS', '--max-time', '2', 'http://127.0.0.1:3999'],
    'success'
  );
  console.log(JSON.stringify({ passed: true, modelInvocations: 0, results }));
} finally {
  server.kill();
}
