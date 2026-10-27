/** Same credential-free runtime acceptance gate on CI and the staging laptop. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Required: ${name}`);
  return value;
}

const image = option('--image');
const sourceSha = option('--source-sha');
if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('source-sha must be a full commit');
const output = resolve(option('--output-dir'));
if (existsSync(join(output, 'receipt.json'))) throw new Error('Evidence directory already used');
mkdirSync(output, { recursive: true });
const name = `archon-runtime-${randomUUID()}`;
const receipt: Record<string, unknown> = {
  sourceSha,
  image,
  name,
  startedAt: new Date().toISOString(),
  passed: false,
  network: 'none',
  credentials: 'none',
};
let created = false;

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function containerLogs(): string {
  const result = spawnSync('docker', ['logs', name], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Cannot collect container logs');
  return result.stdout + result.stderr;
}

async function health(): Promise<unknown> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = JSON.parse(docker('inspect', name))[0].State;
    if (!state.Running) throw new Error(`Container exited during boot: ${state.ExitCode}`);
    try {
      const result = JSON.parse(
        docker('exec', name, 'curl', '-fsS', '--max-time', '2', 'http://127.0.0.1:3093/api/health')
      );
      if (
        result.status !== 'ok' ||
        result.is_docker !== true ||
        result.runningWorkflows !== 0 ||
        result.concurrency.active !== 0 ||
        result.concurrency.queuedTotal !== 0 ||
        result.overseer.watcher !== 'stopped' ||
        result.overseer.emergency_stop !== true
      ) {
        throw new Error('Unsafe or unhealthy staging state');
      }
      return result;
    } catch (error) {
      if (attempt === 29) throw error;
      await Bun.sleep(1000);
    }
  }
  throw new Error('Health deadline exceeded');
}

function stopAndVerify(phase: string): void {
  docker('stop', '--time', '10', name);
  const state = JSON.parse(docker('inspect', name))[0].State;
  receipt[`${phase}Stop`] = state;
  const logs = containerLogs();
  writeFileSync(join(output, `${phase}.log`), logs + '\n');
  if (state.Running || state.ExitCode !== 0 || state.OOMKilled) {
    throw new Error(`${phase}: unclean stop (exit ${state.ExitCode})`);
  }
  if (!logs.includes('server_shutting_down') || !logs.includes('database_pool_closed')) {
    throw new Error(`${phase}: shutdown evidence missing`);
  }
  if (logs.includes('taskmaster.github_digest_failed') || logs.includes('db.sqlite_query_failed')) {
    throw new Error(`${phase}: runtime database query failed`);
  }
}

try {
  receipt.dockerVersion = docker('version', '--format', '{{.Server.Version}}');
  const inspect = (
    JSON.parse(docker('image', 'inspect', image)) as {
      Id: string;
      RepoDigests: string[];
      Config: { Env: string[]; Labels: Record<string, string> | null };
    }[]
  )[0];
  if (!inspect.Config.Env.includes(`ARCHON_BUILD_SHA=${sourceSha}`)) {
    throw new Error('Image build SHA does not match the requested source');
  }
  if (inspect.Config.Labels?.['org.opencontainers.image.revision'] !== sourceSha) {
    throw new Error('Image revision label does not match the requested source');
  }
  receipt.imageId = inspect.Id;
  receipt.repoDigests = inspect.RepoDigests;
  docker(
    'create',
    '--name',
    name,
    '--network',
    'none',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--label',
    'bdc.runtime-acceptance=true',
    '-e',
    'ARCHON_DOCKER=true',
    '-e',
    'PORT=3093',
    '-e',
    'CLAUDE_USE_GLOBAL_AUTH=true',
    '-e',
    'OVERSEER_ENABLED=false',
    '-e',
    'OVERSEER_EMERGENCY_STOP=true',
    '-e',
    'TASKMASTER_FIRE_MAX_PER_DAY=0',
    inspect.Id
  );
  created = true;
  docker('start', name);
  receipt.health = await health();
  // Execute the actual digest loader and validate the migrated, disposable DB.
  receipt.database = docker(
    'exec',
    '--user',
    'appuser',
    name,
    'bun',
    '--eval',
    `
    const {getDatabase, closeDatabase} = await import('@archon/core/db');
    const {loadGitHubDigestData} = await import('/app/packages/server/src/taskmaster/loop.ts');
    try {
      const db = getDatabase();
      const integrity = await db.query('PRAGMA integrity_check');
      if (integrity.rows[0]?.integrity_check !== 'ok') throw new Error('SQLite integrity failed');
      const tables = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tm_control','tm_fire_admissions') ORDER BY name");
      if (tables.rows.length !== 2) throw new Error('Taskmaster migrations missing');
      const digest = await loadGitHubDigestData(Date.now());
      console.log(JSON.stringify({integrity: 'ok', tables: tables.rows, digest}));
    } finally { await closeDatabase(); }
  `
  );
  const bunVersion = docker('exec', '--user', 'appuser', name, 'bun', '--version');
  const nodeVersion = docker('exec', '--user', 'appuser', name, 'node', '--version');
  if (bunVersion !== '1.4.4' || nodeVersion !== 'v24.22.1') {
    throw new Error(`Toolchain drift: Bun ${bunVersion}, Node ${nodeVersion}`);
  }
  receipt.toolchain = docker(
    'exec',
    '--user',
    'appuser',
    name,
    'sh',
    '-ec',
    'bun --version && node --version && npm --version && npx --version && pytest --version && git --version && gh --version && jq --version && rg --version && shellcheck --version && chromium --version && agent-browser --version'
  );
  const dom = docker(
    'exec',
    '--user',
    'appuser',
    name,
    'chromium',
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--timeout=15000',
    '--virtual-time-budget=3000',
    '--dump-dom',
    'http://127.0.0.1:3093'
  );
  writeFileSync(join(output, 'browser-dom.html'), dom);
  if (!dom.includes('<html') || !dom.includes('id="root"')) {
    throw new Error('Headless browser did not render the application document');
  }
  receipt.browser = 'headless Chromium rendered the packaged application';
  stopAndVerify('initial');
  // Reopen the same disposable store; do not replace it with a fresh database.
  docker('start', name);
  receipt.restartHealth = await health();
  stopAndVerify('restart');
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      const state = JSON.parse(docker('inspect', name))[0].State;
      if (state.Running) docker('stop', '--time', '10', name);
      receipt.finalState = JSON.parse(docker('inspect', name))[0].State;
      writeFileSync(join(output, 'container.log'), containerLogs() + '\n');
      docker('rm', name);
      receipt.cleanedUp = true;
    } catch (error) {
      receipt.cleanupError = error instanceof Error ? error.message : String(error);
      receipt.passed = false;
      process.exitCode = 1;
    }
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
