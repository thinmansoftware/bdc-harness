// Private, non-query native thread/start diagnostic. Never register as a provider.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type * as Policy from '../../packages/providers/src/codex/restricted-policy';
import type * as Fixture from './teetime-reviewer-fixture';
import type * as Startup from './teetime-startup-protocol';

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error('startup input rejected');
}
const hash = (raw: Uint8Array | string): string => createHash('sha256').update(raw).digest('hex');
type FailurePhase = 'context' | 'imports' | 'binary-identity' | 'home-checks'
  | 'native-version' | 'catalog-read' | 'catalog-compare' | 'synthetic-setup'
  | 'native-spawn' | 'initialize-exchange' | 'thread-start-exchange'
  | 'postchecks' | 'packet-serialization';
let phase: FailurePhase = 'context';
async function main(): Promise<void> {
  requireValue(process.env.TEE_TIME_SANDBOX_PROBE === '1' && process.getuid?.() === 1001);
  // This entry is supplied on stdin from /workspace, not loaded at its source path.
  const policyPath = '/app/packages/providers/src/codex/restricted-policy.ts';
  const fixturePath = '/app/scripts/staging/teetime-reviewer-fixture.ts';
  const protocolPath = '/app/scripts/staging/teetime-startup-protocol.ts';
  phase = 'imports';
  const { RESTRICTED_BINARY } = (await import(policyPath)) as typeof Policy;
  const { compareBundledCatalog, fixtureClientOptions } = (await import(
    fixturePath
  )) as typeof Fixture;
  const { exchangeStartup, startupArguments, startupCommandOutput } =
    (await import(protocolPath)) as typeof Startup;
  phase = 'binary-identity';
  const expectedBinary = process.env.TEE_TIME_STARTUP_BINARY_HASH;
  requireValue(typeof expectedBinary === 'string' && /^[a-f0-9]{64}$/.test(expectedBinary));
  const binaryHash = hash(readFileSync(RESTRICTED_BINARY));
  requireValue(binaryHash === expectedBinary);
  phase = 'home-checks';
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
    return startupCommandOutput(result, maxBuffer);
  }
  phase = 'native-version';
  requireValue(
    new TextDecoder().decode(native(['--version'], 4096)).trim() === 'codex-cli 0.153.3'
  );
  phase = 'catalog-read';
  const source = readFileSync(
    '/app/packages/providers/src/codex/restricted-review-model-base.json'
  );
  const bundled = native(['debug', 'models', '--bundled'], 1048576);
  phase = 'catalog-compare';
  const compared = compareBundledCatalog(bundled, source);
  requireValue(
    compared.catalogHash === 'e5a56e880294de40cfd546abc67943839247ef41f9fea095c6ffc93ca4f53e14'
  );
  phase = 'synthetic-setup';
  writeFileSync(catalogPath, compared.catalogText, { flag: 'wx', mode: 0o400 });
  const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-reviewer-only"}';
  writeFileSync(home + '/auth.json', auth, { flag: 'wx', mode: 0o600 });
  phase = 'native-spawn';
  const child = Bun.spawn(startupArguments(), {
    env,
    cwd: '/workspace',
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  phase = 'initialize-exchange';
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
  }, 12000, value => { phase = value; });
  phase = 'postchecks';
  requireValue(child.exitCode !== null && hash(readFileSync(RESTRICTED_BINARY)) === binaryHash);
  requireValue(readFileSync(home + '/auth.json', 'utf8') === auth);
  requireValue(readFileSync(catalogPath, 'utf8') === compared.catalogText);
  phase = 'packet-serialization';
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
  process.stdout.write(JSON.stringify({ kind: 'teetime-startup-capture-failed-v2', phase }));
  process.exitCode = 1;
});
