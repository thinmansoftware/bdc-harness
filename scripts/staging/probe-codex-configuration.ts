// Non-model configuration/discovery probe. Requires inspected disposable container.
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import type { restrictedClientOptions } from '../../packages/providers/src/codex/restricted-policy';

if (process.env.TEE_TIME_SANDBOX_PROBE !== '1') throw new Error('probe container required');
const policyPath = '/app/packages/providers/src/codex/restricted-policy.ts';
const policy = (await import(policyPath)) as {
  restrictedClientOptions: typeof restrictedClientOptions;
};
const options = policy.restrictedClientOptions();
const binary = options.codexPathOverride;
if (!binary) throw new Error('missing pinned binary');
const version = Bun.spawnSync([binary, '--version'], { env: options.env });
if (version.exitCode !== 0 || version.stdout.toString().trim() !== 'codex-cli 0.153.3')
  throw new Error('unreviewed CLI version');
const args = [binary, 'app-server', '--stdio', '--strict-config'];
function flatten(value: Record<string, unknown>, prefix = ''): void {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === 'object' && !Array.isArray(item))
      flatten(item as Record<string, unknown>, path);
    else args.push('-c', `${path}=${JSON.stringify(item)}`);
  }
}
flatten(options.config ?? {});
for (const raw of options.configOverrides ?? []) args.push('-c', raw);
const home = '/home/appuser/.codex';
mkdirSync(home, { recursive: true });
if (readdirSync(home).length) throw new Error('nonempty initial home');
for (const path of ['/etc/codex', '/.codex', '/.agents']) {
  if (existsSync(path)) throw new Error('inherited config path');
}
function checkMasks(): void {
  for (const path of ['/workspace/.codex', '/workspace/.agents']) {
    if (readdirSync(path).length) throw new Error('nonempty mask');
    for (const command of [
      `echo hostile > ${path}/config.toml`,
      `mv ${path} ${path}-renamed`,
      `ln -s /tmp ${path}/injected`,
    ]) {
      const result = Bun.spawnSync(['sh', '-c', command], { env: options.env, timeout: 5000 });
      if (result.exitCode === 0 || result.signalCode)
        throw new Error('mask mutation boundary failed');
      if (
        !/Read-only file system|Device or resource busy|Permission denied/.test(
          result.stderr.toString()
        )
      ) {
        throw new Error('unexpected mask denial');
      }
    }
  }
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function inspectCatalogs(): Promise<void> {
  const child = Bun.spawn(args, {
    cwd: '/workspace',
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 15000);
  function send(id: number, method: string, params: Record<string, unknown>): void {
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }
  send(1, 'initialize', {
    clientInfo: { name: 'teetime_probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  let buffer = '';
  try {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        requireCondition(!response.error, 'configuration RPC failed');
        if (response.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          send(2, 'config/read', { cwd: '/workspace', includeLayers: false });
        } else if (response.id === 2) {
          const config = response.result.config;
          for (const key of [
            'hooks',
            'apps',
            'plugins',
            'remote_plugin',
            'multi_agent',
            'multi_agent_v2',
          ]) {
            requireCondition(config.features[key] === false, 'extension enabled: ' + key);
          }
          requireCondition(
            config.features.skip_host_skill_discovery === true,
            'host skill discovery enabled'
          );
          requireCondition(config.agents.enabled === false, 'agents enabled');
          requireCondition(
            config.skills.bundled.enabled === false && config.skills.include_instructions === false,
            'skills enabled'
          );
          requireCondition(config.default_permissions === 'tee-time', 'named policy mismatch');
          const permissions = config.permissions['tee-time'];
          requireCondition(
            permissions.extends === ':workspace' && permissions.network.enabled === false,
            'permission inheritance/network mismatch'
          );
          for (const [path, access] of Object.entries({
            ':root': 'deny',
            ':minimal': 'read',
            '/app': 'read',
            ':slash_tmp': 'deny',
            ':tmpdir': 'deny',
          })) {
            requireCondition(permissions.filesystem[path] === access, 'filesystem policy mismatch');
          }
          requireCondition(
            Object.keys(permissions.filesystem).length === 5,
            'additional filesystem permission'
          );
          requireCondition(config.model_provider === 'openai', 'provider mismatch');
          requireCondition(
            config.notify.length === 0 && Object.keys(config.mcp_servers).length === 0,
            'external config present'
          );
          send(3, 'mcpServerStatus/list', {});
        } else if (response.id === 3) {
          requireCondition(
            response.result.data.length === 0 && response.result.nextCursor === null,
            'MCP catalog nonempty'
          );
          send(4, 'plugin/list', { cwds: ['/workspace'], forceRefetch: false });
        } else if (response.id === 4) {
          requireCondition(
            response.result.marketplaces.length === 0 &&
              response.result.marketplaceLoadErrors.length === 0 &&
              response.result.featuredPluginIds.length === 0,
            'plugin catalog nonempty or failed'
          );
          send(5, 'skills/list', { cwds: ['/workspace'] });
        } else if (response.id === 5) {
          requireCondition(response.result.data.length === 1, 'missing skill catalog');
          const catalog = response.result.data[0];
          requireCondition(
            catalog.cwd === '/workspace' &&
              catalog.skills.length === 0 &&
              catalog.errors.length === 0,
            'skill catalog nonempty or failed'
          );
          return;
        }
      }
    }
    throw new Error(timedOut ? 'configuration RPC timed out' : 'configuration RPC ended early');
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
  }
}
checkMasks();
await inspectCatalogs();
checkMasks();
await inspectCatalogs();
console.log(
  JSON.stringify({
    passed: true,
    modelInvocations: 0,
    configurationStarts: 2,
    emptyCatalogs: ['mcp', 'plugins', 'skills'],
    immutableMasks: ['.codex', '.agents'],
  })
);
