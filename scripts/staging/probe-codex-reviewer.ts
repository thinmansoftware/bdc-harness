// Credential-free installed-SDK probe. Only the inspected CI container may run it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
// Type-only resolution uses the provider workspace dependency; runtime uses the
// exact hoisted SDK inside the inspected image below.
import type { Codex } from '../../packages/providers/node_modules/@openai/codex-sdk';
import type * as Fixture from './teetime-reviewer-fixture';
import type * as Policy from '../../packages/providers/src/codex/restricted-policy';

function requireValue(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error('reviewer fixture: ' + label);
}
const rawCase = process.env.TEE_TIME_REVIEWER_CASE;
requireValue(
  process.env.TEE_TIME_SANDBOX_PROBE === '1' &&
    process.getuid?.() === 1001 &&
    ['positive', 'shell', 'patch', 'code-mode'].includes(rawCase ?? ''),
  'fixed container and case required'
);
const caseName = rawCase as Fixture.ReviewerFixtureCase;
const fixturePath = '/app/scripts/staging/teetime-reviewer-fixture.ts';
const policyPath = '/app/packages/providers/src/codex/restricted-policy.ts';
const fixture = (await import(fixturePath)) as typeof Fixture;
const policy = (await import(policyPath)) as typeof Policy;
const options = fixture.fixtureClientOptions();
const binary = policy.RESTRICTED_BINARY;
const env = options.env;
requireValue(
  options.codexPathOverride === binary && env !== undefined,
  'fixed executable and environment'
);
const home = '/home/appuser/.codex';
const catalogPath = home + '/reviewer-models.json';
const marker = '/workspace/reviewer-marker';
const hash = (raw: string | Uint8Array): string => createHash('sha256').update(raw).digest('hex');
requireValue(!existsSync(home), 'home not empty');
mkdirSync(home, { mode: 0o700 });
for (const path of ['/etc/codex', '/.codex', '/.agents'])
  requireValue(!existsSync(path), 'inherited configuration');
for (const path of ['/workspace/.codex', '/workspace/.agents'])
  requireValue(readdirSync(path).length === 0, 'configuration mask not empty');
requireValue(!existsSync(marker), 'sentinel exists before probe');

async function boundedNative(args: string[], timeout: number, limit: number): Promise<Uint8Array> {
  const child = Bun.spawn(args, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let bytes = 0;
  let failed = false;
  const timer = setTimeout(() => {
    failed = true;
    child.kill();
  }, timeout);
  async function drain(stream: AsyncIterable<Uint8Array>, keep: boolean): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limit) {
        failed = true;
        child.kill();
        throw new Error('reviewer fixture: native output bound');
      }
      if (keep) chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  try {
    const [out] = await Promise.all([drain(child.stdout, true), drain(child.stderr, false)]);
    requireValue((await child.exited) === 0 && !failed, 'native subprocess failed');
    return out;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
const version = await boundedNative([binary, '--version'], 5000, 4096);
requireValue(new TextDecoder().decode(version).trim() === 'codex-cli 0.153.3', 'CLI version');
const installed = await boundedNative([binary, 'debug', 'models', '--bundled'], 10000, 1048576);
const source = readFileSync('/app/packages/providers/src/codex/restricted-review-model-base.json');
const compared = fixture.compareBundledCatalog(installed, source);
writeFileSync(catalogPath, compared.catalogText, { flag: 'wx', mode: 0o400 });
const syntheticAuth = '{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-reviewer-only"}';
writeFileSync(home + '/auth.json', syntheticAuth, { flag: 'wx', mode: 0o600 });

// Source prior art: probe-codex-configuration.ts. Inspect actual resolved config
// and inventories; accepted flag syntax alone is not a capability result.
async function effectiveConfiguration(): Promise<void> {
  const args = [binary, 'app-server', '--stdio', '--strict-config'];
  function flatten(value: Record<string, unknown>, prefix = ''): void {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? prefix + '.' + key : key;
      if (item && typeof item === 'object' && !Array.isArray(item))
        flatten(item as Record<string, unknown>, path);
      else args.push('-c', path + '=' + JSON.stringify(item));
    }
  }
  flatten(options.config ?? {});
  for (const raw of options.configOverrides ?? []) args.push('-c', raw);
  const child = Bun.spawn(args, {
    env,
    cwd: '/workspace',
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let failed = false;
  let bytes = 0;
  const timer = setTimeout(() => {
    failed = true;
    child.kill();
  }, 12000);
  const stderr = (async (): Promise<void> => {
    for await (const chunk of child.stderr) {
      bytes += chunk.length;
      if (bytes > 1048576) {
        failed = true;
        child.kill();
      }
    }
  })();
  function send(id: number, method: string, params: Record<string, unknown>): void {
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  }
  let complete = false;
  send(1, 'initialize', {
    clientInfo: { name: 'teetime_reviewer_fixture', version: '1' },
    capabilities: { experimentalApi: true },
  });
  let buffer = '';
  try {
    outer: for await (const chunk of child.stdout) {
      bytes += chunk.length;
      requireValue(bytes <= 1048576 && !failed, 'configuration RPC bound');
      buffer += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        requireValue(!response.error, 'effective configuration RPC rejected');
        if (response.id === 1) {
          child.stdin.write('{"method":"initialized"}\n');
          send(2, 'config/read', { cwd: '/workspace', includeLayers: false });
        } else if (response.id === 2) {
          const config = response.result.config;
          for (const key of [
            ...fixture.REVIEWER_DISABLED_FEATURES,
            'hooks',
            'apps',
            'plugins',
            'remote_plugin',
            'multi_agent',
            'multi_agent_v2',
          ])
            requireValue(config.features[key] === false, 'effective disabled feature: ' + key);
          requireValue(config.features.skip_host_skill_discovery === true, 'skill discovery');
          requireValue(
            config.agents.enabled === false &&
              config.skills.bundled.enabled === false &&
              config.skills.include_instructions === false,
            'effective agent or skills configuration'
          );
          requireValue(config.model_catalog_json === catalogPath, 'effective catalog path');
          requireValue(
            config.tools.update_plan.enabled === false &&
              config.tools.experimental_request_user_input.enabled === false,
            'effective utility tools'
          );
          requireValue(
            config.default_permissions === 'tee-time' && config.model_provider === 'openai',
            'effective restricted provider'
          );
          requireValue(
            config.notify.length === 0 && Object.keys(config.mcp_servers).length === 0,
            'effective extension inventory'
          );
          const permissions = config.permissions['tee-time'];
          requireValue(
            permissions.extends === ':workspace' && permissions.network.enabled === false,
            'effective permission inheritance'
          );
          for (const [path, access] of Object.entries({
            ':root': 'deny',
            ':minimal': 'read',
            '/app': 'read',
            ':slash_tmp': 'deny',
            ':tmpdir': 'deny',
          }))
            requireValue(
              permissions.filesystem[path] === access,
              'effective filesystem restriction'
            );
          requireValue(
            Object.keys(permissions.filesystem).length === 6 &&
              permissions.filesystem.glob_scan_max_depth === null,
            'effective filesystem additions'
          );
          send(3, 'mcpServerStatus/list', {});
        } else if (response.id === 3) {
          requireValue(
            response.result.data.length === 0 && response.result.nextCursor === null,
            'MCP catalog'
          );
          send(4, 'plugin/list', { cwds: ['/workspace'], forceRefetch: false });
        } else if (response.id === 4) {
          requireValue(
            response.result.marketplaces.length === 0 &&
              response.result.marketplaceLoadErrors.length === 0 &&
              response.result.featuredPluginIds.length === 0,
            'plugin catalog'
          );
          send(5, 'skills/list', { cwds: ['/workspace'] });
        } else if (response.id === 5) {
          requireValue(
            response.result.data.length === 1 &&
              response.result.data[0].cwd === '/workspace' &&
              response.result.data[0].skills.length === 0 &&
              response.result.data[0].errors.length === 0,
            'skills catalog'
          );
          complete = true;
          break outer;
        }
      }
    }
    requireValue(complete && !failed, 'configuration RPC incomplete');
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await stderr;
  }
}
await effectiveConfiguration();

let requests = 0;
let websocketAttempts = 0;
let protocolFailure = false;
let hostileEmitted = false;
let denialObserved = false;
let firstBodyHash: string | undefined;
let instructionHash: string | undefined;
let inputHash: string | undefined;
let framingKeys: string[] = [];
let decodedBytes = 0;
const expectedName =
  caseName === 'shell' ? 'exec_command' : caseName === 'patch' ? 'apply_patch' : 'exec';
const callId = fixture.REVIEWER_HOSTILE_CALL_ID;
const finalText = fixture.REVIEWER_FINAL_TEXT;
function completed(id: string): object {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 10,
  async fetch(request) {
    try {
      if (request.headers.get('upgrade') !== null) {
        websocketAttempts++;
        requireValue(
          request.method === 'GET' &&
            new URL(request.url).pathname === '/v1/responses' &&
            request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
            websocketAttempts <= 1,
          'unexpected or repeated WebSocket negotiation'
        );
        return new Response(null, { status: 404, headers: { connection: 'close' } });
      }
      requireValue(
        request.method === 'POST' && new URL(request.url).pathname === '/v1/responses',
        'endpoint'
      );
      requests++;
      requireValue(requests <= (caseName === 'positive' ? 1 : 2), 'request count');
      const size = Number(request.headers.get('content-length'));
      requireValue(
        Number.isSafeInteger(size) &&
          size > 0 &&
          size <= 1048576 &&
          request.headers.get('transfer-encoding') === null,
        'request wire bound'
      );
      const wire = new Uint8Array(await request.arrayBuffer());
      requireValue(wire.length === size, 'request length');
      const encoding = request.headers.get('content-encoding');
      const body = encoding === 'gzip' ? gunzipSync(wire, { maxOutputLength: 1048576 }) : wire;
      requireValue(
        (encoding === null || encoding === 'identity' || encoding === 'gzip') &&
          body.length <= 1048576,
        'decoded request bound'
      );
      const observed = fixture.inspectReviewerRequest(body, requests, caseName);
      if (requests === 1) {
        firstBodyHash = observed.bodyHash;
        instructionHash = observed.instructionHash;
        inputHash = observed.inputHash;
        decodedBytes = observed.decodedBytes;
        framingKeys = observed.framingKeys;
      }
      const events: object[] = [];
      if (requests === 1 && caseName !== 'positive') {
        hostileEmitted = true;
        const shell = 'printf teetime-reviewer-forbidden > /workspace/reviewer-marker';
        const call =
          caseName === 'shell'
            ? {
                type: 'function_call',
                name: expectedName,
                namespace: 'functions',
                arguments: JSON.stringify({ cmd: shell }),
                call_id: callId,
              }
            : {
                type: 'custom_tool_call',
                name: expectedName,
                namespace: 'functions',
                input:
                  caseName === 'patch'
                    ? '*** Begin Patch\n*** Add File: /workspace/reviewer-marker\n+forbidden\n*** End Patch\n'
                    : 'text(await tools.exec_command(' + JSON.stringify({ cmd: shell }) + '));',
                call_id: callId,
              };
        events.push({ type: 'response.output_item.done', item: call });
      } else {
        if (caseName !== 'positive') {
          requireValue(hostileEmitted, 'hostile custody');
          requireValue(observed.denialObserved, 'explicit unsupported tool denial required');
          denialObserved = true;
        }
        events.push({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            role: 'assistant',
            id: 'reviewer-fixture-message',
            content: [{ type: 'output_text', text: finalText }],
          },
        });
      }
      events.push(completed('reviewer-fixture-' + requests));
      return new Response(
        events
          .map(
            event =>
              'event: ' +
              (event as { type: string }).type +
              '\ndata: ' +
              JSON.stringify(event) +
              '\n\n'
          )
          .join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        }
      );
    } catch {
      protocolFailure = true;
      return new Response('fixture request rejected', { status: 400 });
    }
  },
});
const sdkPath = '/app/node_modules/@openai/codex-sdk/dist/index.js';
const sdk = (await import(sdkPath)) as {
  Codex: typeof Codex;
};
const changed = {
  ...options,
  baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
  apiKey: 'synthetic-reviewer-only',
};
const { baseUrl: actualUrl, apiKey: actualKey, ...unchanged } = changed;
requireValue(
  actualUrl === 'http://127.0.0.1:' + server.port + '/v1' &&
    actualKey === 'synthetic-reviewer-only' &&
    isDeepStrictEqual(unchanged, options),
  'unexpected SDK option delta'
);
const controller = new AbortController();
let closed = false;
let normalEnd = false;
const timer = setTimeout(() => {
  if (!closed) controller.abort();
}, 25000);
const counts: Record<string, number> = {};
let finalMessages = 0;
let turnCompleted = 0;
let rawToolEvent = false;
try {
  const client = new sdk.Codex(changed);
  const turn = await client
    .startThread(policy.restrictedThreadOptions())
    .runStreamed(
      'Synthetic reviewer transport fixture. Return only the fixed synthetic response.',
      { signal: controller.signal }
    );
  let eventBytes = 0;
  let eventCount = 0;
  for await (const event of turn.events) {
    eventBytes += Buffer.byteLength(JSON.stringify(event));
    requireValue(
      ++eventCount <= 64 && eventBytes <= 65536 && !controller.signal.aborted,
      'raw SDK event bound'
    );
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    requireValue(!['error', 'turn.failed'].includes(event.type), 'SDK failure');
    if ('item' in event) {
      if (event.item.type === 'agent_message') {
        if (event.type === 'item.completed') {
          fixture.validateFixtureFinalText(event.item.text);
          finalMessages++;
        }
      } else if (event.item.type !== 'reasoning') rawToolEvent = true;
    }
    if (event.type === 'turn.completed') turnCompleted++;
  }
  normalEnd = true;
} finally {
  closed = true;
  clearTimeout(timer);
  server.stop(true);
}
requireValue(
  normalEnd && turnCompleted === 1 && finalMessages === 1 && !controller.signal.aborted,
  'SDK completion protocol'
);
requireValue(
  !protocolFailure && websocketAttempts <= 1 && !existsSync(marker),
  'protocol or tool effect'
);
const acceptedSyntheticResponse = fixture.fixtureCaseAccepted(caseName, {
  requests,
  hostileEmitted,
  denialObserved,
  rawToolEvent,
});
requireValue(
  readFileSync(home + '/auth.json', 'utf8') === syntheticAuth &&
    readFileSync(catalogPath, 'utf8') === compared.catalogText,
  'fixture inputs changed'
);
console.log(
  JSON.stringify({
    passed: true,
    modelInvocations: 0,
    realCredentialsUsed: false,
    case: caseName,
    binaryHash: hash(readFileSync(binary)),
    sourceFixtureHash: compared.sourceFixtureHash,
    installedOutputHash: compared.installedOutputHash,
    catalogHash: compared.catalogHash,
    requests,
    websocketAttempts,
    decodedBytes,
    firstBodyHash,
    instructionHash,
    inputHash,
    framingKeys,
    executableDefinitions: 0,
    effectiveConfigurationVerified: true,
    hostileEmitted,
    denialObserved,
    rawSdkEventCounts: counts,
    normalSdkEnd: normalEnd,
    acceptedSyntheticResponse,
    approvalGranted: false,
    compactionAbsenceVerified: false,
    reviewerQualityVerified: false,
    authenticatedBehaviorVerified: false,
    servedModelVerified: false,
  })
);
