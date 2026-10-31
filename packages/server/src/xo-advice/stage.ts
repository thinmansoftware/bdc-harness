/** Isolated HTTP acceptance, real Board authentication/lease DB, no live writes. */
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, basename, join, isAbsolute } from 'path';
import { homedir } from 'os';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  authenticateBoardPrincipal,
  acquireXoLease,
  getCurrentXoLease,
} from '@archon/core/db/board-authority';
import { closeDatabase } from '@archon/core/db/connection';
import { registerXoAdviceRoutes } from '../routes/xo-advice.routes';
import { AdviceLedger } from './ledger';
import {
  AdviceService,
  OpenRouterAdviceClient,
  TERRA,
  SOL,
  type AdviceClient,
  type ModelRequest,
} from './service';

const dir = process.env.XO_ADVICE_STAGE_DIR;
if (
  !dir ||
  !isAbsolute(dir) ||
  !basename(dir).startsWith('xo-advice-stage-') ||
  process.env.DATABASE_URL
)
  throw new Error('isolated_stage_directory_required_no_database_url');
const paid = process.argv.includes('--paid');
mkdirSync(dir, { recursive: true });
const reportPath = join(dir, 'HTTP-STAGING-REPORT.json');
if (existsSync(reportPath)) throw new Error('staging_report_exists_no_implicit_replay');
process.env.ARCHON_HOME = dir;
process.env.NODE_ENV = 'staging';
delete process.env.ARCHON_DOCKER;
const token = randomBytes(32).toString('hex');
const operator = randomBytes(32).toString('hex');
const principalId = 'xo-advice-isolated-stage';
process.env.BOARD_PRINCIPALS_JSON = JSON.stringify([
  {
    principal_id: principalId,
    seat_id: 'xo',
    roles: ['board'],
    token_sha256: createHash('sha256').update(token).digest('hex'),
    status: 'active',
  },
]);
const principal = await authenticateBoardPrincipal({ principal_token: token });
const acquired = await acquireXoLease({
  principal,
  holder_id: principalId,
  holder_token: token,
  lease_duration_ms: 3_600_000,
});
if (!acquired.ok || !acquired.lease) throw new Error('isolated_stage_lease_failed');
const lease = acquired.lease;
// One fixed paid campaign across every report/lease directory and process.
// Changing XO_ADVICE_STAGE_DIR cannot obtain another dollar of authority.
const pilotPath = paid
  ? join(homedir(), 'Downloads', 'terra-xo-lane-approval-20261031', 'XO-STAGING-PILOT.sqlite')
  : join(dir, 'xo-offline-protocol.sqlite');
const ledger = new AdviceLedger(pilotPath);
const calls: { model: string; input_hash: string; generation_id?: string }[] = [];
async function relay(path: string, body?: unknown): Promise<Response> {
  const child = Bun.spawn(['python', resolve('scripts/staging/xo-advice-relay.py')], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(JSON.stringify({ path, body }));
  child.stdin.end();
  const text = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if ((await child.exited) || error.trim()) throw new Error('stage_relay_failed');
  const result = JSON.parse(text) as { status: number; body: unknown };
  return Response.json(result.body, { status: result.status });
}
const relayFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const prefix = 'https://openrouter.ai/api/v1/';
  if (typeof url !== 'string' || !url.startsWith(prefix))
    throw new Error('stage_provider_url_refused');
  return relay(
    url.slice(prefix.length),
    typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  );
}) as typeof fetch;
const underlying: AdviceClient = paid
  ? new OpenRouterAdviceClient('key-stays-in-existing-remote-container', relayFetch)
  : {
      prices: async () => ({ prompt: 0.000004, completion: 0.000015 }),
      complete: async (request: ModelRequest) => ({
        id: 'gen-stage-offline-' + request.model.split('/')[1],
        model: request.model,
        status: 'completed',
        usage: { cost: 0 },
        output: [
          {
            type: 'function_call',
            name: 'submit_brief',
            arguments: JSON.stringify({
              summary: 'Offline staging protocol control.',
              claims: [{ claim: 'This is a captured control.', evidence_ids: ['E1'] }],
              next_steps: [],
              missing_evidence: [],
              important: false,
              live_change_authorized: false,
            }),
          },
        ],
      }),
      receipt: async id => ({
        id,
        model: id.includes('terra') ? TERRA : SOL,
        provider_name: 'OpenAI',
        total_cost: 0,
      }),
    };
const client: AdviceClient = {
  prices: model => underlying.prices(model),
  complete: async request => {
    const row = {
      model: request.model,
      input_hash: createHash('sha256').update(JSON.stringify(request.input)).digest('hex'),
      generation_id: undefined as string | undefined,
    };
    calls.push(row);
    const response = await underlying.complete(request);
    row.generation_id = response.id;
    return response;
  },
  receipt: id => underlying.receipt(id),
};
const service = new AdviceService(ledger, client, getCurrentXoLease);
const app = new OpenAPIHono();
app.use('/api/*', async (c, next) => {
  if (c.req.header('Authorization') !== 'Bearer ' + operator)
    return c.json({ error: 'stage_operator_required' }, 401);
  return next();
});
registerXoAdviceRoutes(app, { enabled: true, service });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, idleTimeout: 255 });
const base = 'http://127.0.0.1:' + server.port;
const checks: Record<string, boolean> = {};
const results: { label: string; status: number; body: unknown }[] = [];
async function post(
  packet: unknown,
  boardToken = token,
  operatorToken = operator
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + '/api/board/xo-advice', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + operatorToken,
      'x-board-principal-token': boardToken,
    },
    body: JSON.stringify(packet),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
let starting: unknown;
let ending: unknown;
try {
  if (paid) starting = await (await relay('credits')).json();
  const source = Bun.spawnSync(['gh', 'api', 'repos/thinmansoftware/bdc-harness/pulls/1377']);
  if (source.exitCode) throw new Error('github_capture_failed');
  const pr = JSON.parse(source.stdout.toString()) as {
    html_url: string;
    changed_files: number;
    state: string;
    draft: boolean;
    head: { sha: string };
  };
  const routine = {
    request_id: crypto.randomUUID(),
    lease_id: lease.lease_id,
    fencing_token: lease.fencing_token,
    task: 'Report only the number of changed files in this captured inventory.',
    category: 'status',
    captured_at: new Date().toISOString(),
    evidence: [
      {
        id: 'E1',
        url: pr.html_url,
        content:
          'Captured GitHub file count = ' +
          pr.changed_files +
          '. This capture is supplied by the caller.',
      },
    ],
  };
  checks.operator_required = (await post(routine, token, 'wrong')).status === 401;
  checks.board_required = (await post(routine, 'wrong')).status === 401;
  checks.malformed_refused = (await post({ ...routine, actor: 'pretend-xo' })).status === 400;
  checks.stale_fence_refused =
    (await post({ ...routine, fencing_token: lease.fencing_token + 1 })).status === 409;
  const beforeRoutine = calls.length;
  const first = await post(routine);
  results.push({ label: 'routine', ...first });
  checks.routine_complete = first.status === 200;
  checks.routine_terra_only =
    calls.length === beforeRoutine + 1 && calls[beforeRoutine].model === TERRA;
  const duplicate = await post(routine);
  checks.duplicate_refused = duplicate.status === 409 && calls.length === beforeRoutine + 1;
  const important = {
    ...routine,
    request_id: crypto.randomUUID(),
    task: 'Assess deployment readiness from this capture and propose the next verification; do not execute.',
    category: 'important',
    captured_at: new Date().toISOString(),
    evidence: [
      {
        id: 'E1',
        url: pr.html_url,
        content: JSON.stringify({
          capture_source: 'GitHub API, caller supplied',
          head: pr.head.sha,
          state: pr.state,
          draft: pr.draft,
          independent_review: 'not supplied',
          deployment_proof: 'not supplied',
        }),
      },
    ],
  };
  const beforeImportant = calls.length;
  const second = await post(important);
  results.push({ label: 'important', ...second });
  checks.important_complete = second.status === 200;
  checks.important_terra_sol =
    calls.length === beforeImportant + 2 &&
    calls[beforeImportant].model === TERRA &&
    calls[beforeImportant + 1].model === SOL;
  checks.original_packet_independent =
    checks.important_terra_sol &&
    calls[beforeImportant].input_hash === calls[beforeImportant + 1].input_hash;
  checks.cap_preserved = ledger.total() <= 1_000_000;
  if (paid) ending = await (await relay('credits')).json();
} finally {
  const snapshot = ledger.snapshot();
  const sourceFiles = [
    'packages/server/src/xo-advice/service.ts',
    'packages/server/src/xo-advice/ledger.ts',
    'packages/server/src/xo-advice/stage.ts',
    'packages/server/src/routes/xo-advice.routes.ts',
    'packages/server/src/routes/schemas/xo-advice.schemas.ts',
    'scripts/staging/xo-advice-relay.py',
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async file => [
        file,
        createHash('sha256')
          .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
          .digest('hex'),
      ])
    )
  );
  const report = {
    phase: paid ? 'paid_staging_provider_acceptance' : 'offline_staging_protocol_control',
    checked_at: new Date().toISOString(),
    base,
    stage_principal: principalId,
    stage_home: dir,
    source_head: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    source_hashes: sourceHashes,
    checks,
    results,
    calls,
    ledger_path: pilotPath,
    ledger: snapshot,
    starting_balance: starting,
    ending_balance: ending,
    production_application_configuration_database_changes: 0,
    production_lease_changes: 0,
    live_host_provider_bridge_exec: paid,
    paid_provider_requests: paid ? calls.length : 0,
    heldout_accesses: 0,
    notes:
      'Loopback staging only; separate Board principal and lease DB. Same route/service as private API. Paid mode executes the existing credential-safe SSH/container bridge and spends provider credits; no provider secret copied locally. No production application, database, registry, lane or lease change.',
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  server.stop(true);
  ledger.close();
  await closeDatabase();
  console.log(
    JSON.stringify({
      phase: report.phase,
      checks,
      conservative_debit_usd: snapshot.conservative_microusd / 1_000_000,
      report: reportPath,
    })
  );
}
if (!Object.values(checks).every(Boolean) || !checks.important_complete) process.exitCode = 1;
