// Private, non-query native thread/start diagnostic. Never register as a provider.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { RESTRICTED_BINARY } from '../../packages/providers/src/codex/restricted-policy';
import { compareBundledCatalog, fixtureClientOptions } from './teetime-reviewer-fixture';
import { exchangeStartup, startupArguments } from './teetime-startup-protocol';

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('startup input rejected');
}
const hash = (raw: Uint8Array | string): string => createHash('sha256').update(raw).digest('hex');
async function main(): Promise<void> {
  requireValue(process.env.TEE_TIME_SANDBOX_PROBE === '1' && process.getuid?.() === 1001);
  const expectedBinary = process.env.TEE_TIME_STARTUP_BINARY_HASH;
  requireValue(typeof expectedBinary === 'string' && /^[a-f0-9]{64}$/.test(expectedBinary));
  const binaryHash = hash(readFileSync(RESTRICTED_BINARY));
  requireValue(binaryHash === expectedBinary);
  const options = fixtureClientOptions();
  // Explicit replacement environment; no host account, originator override,
  // credential helper, GitHub token, proxy or inherited CLI setting reaches CLI.
  const env = { ...options.env, CODEX_API_KEY: 'synthetic-reviewer-only' };
  const home = '/home/appuser/.codex';
  const catalogPath = home + '/reviewer-models.json';
  requireValue(!existsSync(home));
  for (const path of ['/etc/codex', '/.codex', '/.agents']) requireValue(!existsSync(path));
  for (const path of ['/workspace/.codex', '/workspace/.agents'])
    requireValue(readdirSync(path).length === 0);
  mkdirSync(home, { mode: 0o700 });
  function native(args: string[], maxBuffer: number): Uint8Array {
    const result = Bun.spawnSync([RESTRICTED_BINARY, ...args], {
      env,
      cwd: '/workspace',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10000,
      killSignal: 'SIGKILL',
      maxBuffer,
    });
    requireValue(result.success && result.exitCode === 0 && result.signalCode === null);
    requireValue(result.stdout.length + result.stderr.length <= maxBuffer);
    return result.stdout;
  }
  requireValue(
    new TextDecoder().decode(native(['--version'], 4096)).trim() === 'codex-cli 0.153.3'
  );
  const source = readFileSync(
    '/app/packages/providers/src/codex/restricted-review-model-base.json'
  );
  const compared = compareBundledCatalog(native(['debug', 'models', '--bundled'], 1048576), source);
  requireValue(
    compared.catalogHash === 'e5a56e880294de40cfd546abc67943839247ef41f9fea095c6ffc93ca4f53e14'
  );
  writeFileSync(catalogPath, compared.catalogText, { flag: 'wx', mode: 0o400 });
  const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-reviewer-only"}';
  writeFileSync(home + '/auth.json', auth, { flag: 'wx', mode: 0o600 });
  const child = Bun.spawn(startupArguments(), {
    env,
    cwd: '/workspace',
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = await exchangeStartup({
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    write: line => {
      child.stdin.write(line);
    },
    kill: () => {
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  });
  requireValue(child.exitCode !== null && hash(readFileSync(RESTRICTED_BINARY)) === binaryHash);
  requireValue(readFileSync(home + '/auth.json', 'utf8') === auth);
  requireValue(readFileSync(catalogPath, 'utf8') === compared.catalogText);
  const packet = JSON.stringify({
    kind: 'teetime-thread-start-debug-v1',
    steps: ['initialize', 'initialized', 'thread/start'],
    ...result,
    binaryHash,
    sourceFixtureHash: compared.sourceFixtureHash,
    catalogHash: compared.catalogHash,
    authUnchanged: true,
    catalogUnchanged: true,
    childReaped: true,
    modelTurnsSent: 0,
  });
  requireValue(Buffer.byteLength(packet) <= 65536);
  // Private controller capture only. This must never be piped into public CI logs.
  process.stdout.write(packet);
}
void main().catch(() => {
  // Never stringify native failures, private RPC data, stderr or stack traces.
  process.stdout.write('{"kind":"teetime-startup-capture-failed-v1"}');
  process.exitCode = 1;
});
