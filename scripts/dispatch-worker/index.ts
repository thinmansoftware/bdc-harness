import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import { spawn } from 'bun';

type DispatchTaskType = 'agent_message' | 'run_review' | 'draft_spec' | 'run_report';
type DispatchStatus = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';

interface DispatchMessage {
  id: string;
  task_type: DispatchTaskType;
  sender: string;
  recipient: string;
  body: string;
  status: DispatchStatus;
  fencing_token: number;
}

interface AgentConfig {
  command: string;
  args: string[];
}

interface WorkerConfig {
  worker_id?: string;
  host?: string;
  server_url: string;
  operator_token_env?: string;
  poll_interval_ms?: number;
  heartbeat_interval_ms?: number;
  lease_duration_ms?: number;
  capabilities?: Record<string, unknown>;
  max_concurrency?: Record<string, number>;
  agents: Record<string, AgentConfig>;
}

interface WorkerState {
  stopping: boolean;
  activeByAgent: Map<string, number>;
}

function parseArgs(): string {
  const index = process.argv.indexOf('--config');
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error('Usage: bun run scripts/dispatch-worker/index.ts --config <path>');
  }
  return process.argv[index + 1];
}

async function readConfig(path: string): Promise<Required<WorkerConfig>> {
  const raw = await Bun.file(path).text();
  const parsed = JSON.parse(raw) as WorkerConfig;
  if (!parsed.server_url) throw new Error('config.server_url is required');
  if (!parsed.agents || Object.keys(parsed.agents).length === 0) {
    throw new Error('config.agents must include at least one local agent');
  }

  return {
    worker_id: parsed.worker_id ?? `dispatch-worker-${hostname()}`,
    host: parsed.host ?? hostname(),
    server_url: parsed.server_url.replace(/\/+$/, ''),
    operator_token_env: parsed.operator_token_env ?? 'ARCHON_OPERATOR_TOKEN',
    poll_interval_ms: parsed.poll_interval_ms ?? 5_000,
    heartbeat_interval_ms: parsed.heartbeat_interval_ms ?? 30_000,
    lease_duration_ms: parsed.lease_duration_ms ?? 300_000,
    capabilities: parsed.capabilities ?? { providers: Object.keys(parsed.agents) },
    max_concurrency: parsed.max_concurrency ?? {},
    agents: parsed.agents,
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-archon-operator-token': token,
  };
}

async function requestJson<T>(
  config: Required<WorkerConfig>,
  token: string,
  path: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
): Promise<T> {
  const response = await fetch(`${config.server_url}${path}`, {
    ...init,
    headers: { ...authHeaders(token), ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${path}: ${text}`);
  }
  return (await response.json()) as T;
}

async function register(config: Required<WorkerConfig>, token: string): Promise<void> {
  await requestJson(config, token, '/api/dispatch/workers/register', {
    method: 'POST',
    body: JSON.stringify({
      worker_id: config.worker_id,
      host: config.host,
      capabilities: config.capabilities,
      max_concurrency: Object.values(config.max_concurrency).reduce(
        (max, value) => Math.max(max, value),
        1
      ),
    }),
  });
}

async function heartbeat(config: Required<WorkerConfig>, token: string): Promise<void> {
  await requestJson(config, token, '/api/dispatch/workers/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ worker_id: config.worker_id }),
  });
}

function promptFor(message: DispatchMessage): string {
  switch (message.task_type) {
    case 'agent_message':
      return message.body;
    case 'run_review':
      return `Review request from ${message.sender}:\n\n${message.body}`;
    case 'draft_spec':
      return `Draft a specification from this request by ${message.sender}:\n\n${message.body}`;
    case 'run_report':
      return `Prepare a concise report for ${message.sender}:\n\n${message.body}`;
  }
}

function buildArgs(template: string[], prompt: string): string[] {
  return template.map(arg => (arg === '{{prompt}}' ? prompt : arg));
}

async function writeTranscript(data: {
  message: DispatchMessage;
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}): Promise<string> {
  const dir = join(import.meta.dir, 'transcripts');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${data.message.id}.json`);
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

async function runAgent(
  config: AgentConfig,
  message: DispatchMessage
): Promise<{
  resultBody: string;
  status: 'done' | 'failed';
}> {
  const cwd = await mkdtemp(join(tmpdir(), `bdc-dispatch-${message.recipient}-`));
  const prompt = promptFor(message);
  const args = buildArgs(config.args, prompt);
  const proc = spawn({
    cmd: [config.command, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const transcript = await writeTranscript({
    message,
    command: config.command,
    args,
    cwd,
    stdout,
    stderr,
    exitCode,
  });
  const finalText = stdout.trim() || stderr.trim() || `No output. See transcript: ${transcript}`;
  return {
    resultBody: `${finalText}\n\nTranscript: ${transcript}`,
    status: exitCode === 0 ? 'done' : 'failed',
  };
}

async function processMessage(
  config: Required<WorkerConfig>,
  token: string,
  state: WorkerState,
  queued: DispatchMessage
): Promise<void> {
  const agent = queued.recipient;
  const active = state.activeByAgent.get(agent) ?? 0;
  const cap = config.max_concurrency[agent] ?? 1;
  if (active >= cap) return;
  const agentConfig = config.agents[agent];
  if (!agentConfig) return;

  state.activeByAgent.set(agent, active + 1);
  try {
    const claimed = await requestJson<DispatchMessage>(
      config,
      token,
      `/api/dispatch/messages/${queued.id}/claim`,
      {
        method: 'POST',
        body: JSON.stringify({
          worker_id: config.worker_id,
          lease_duration_ms: config.lease_duration_ms,
        }),
      }
    );
    const result = await runAgent(agentConfig, claimed);
    await requestJson(config, token, `/api/dispatch/messages/${claimed.id}/result`, {
      method: 'POST',
      body: JSON.stringify({
        worker_id: config.worker_id,
        fencing_token: claimed.fencing_token,
        result_body: result.resultBody,
        status: result.status,
      }),
    });
  } catch (error) {
    console.error(`dispatch-worker failed message ${queued.id}:`, error);
  } finally {
    state.activeByAgent.set(agent, Math.max(0, (state.activeByAgent.get(agent) ?? 1) - 1));
  }
}

async function poll(
  config: Required<WorkerConfig>,
  token: string,
  state: WorkerState
): Promise<void> {
  for (const recipient of Object.keys(config.agents)) {
    const messages = await requestJson<DispatchMessage[]>(
      config,
      token,
      `/api/dispatch/messages?recipient=${encodeURIComponent(recipient)}&status=queued`
    );
    for (const message of messages) {
      if (state.stopping) return;
      void processMessage(config, token, state, message);
    }
  }
}

async function main(): Promise<void> {
  const config = await readConfig(parseArgs());
  const token = process.env[config.operator_token_env];
  if (!token) throw new Error(`${config.operator_token_env} must be set`);
  const state: WorkerState = { stopping: false, activeByAgent: new Map() };

  const stop = (): void => {
    state.stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await register(config, token);
  const heartbeatTimer = setInterval(() => {
    if (!state.stopping)
      void heartbeat(config, token).catch(error => {
        console.error(error);
      });
  }, config.heartbeat_interval_ms);
  heartbeatTimer.unref?.();

  while (!state.stopping) {
    await poll(config, token, state).catch(error => {
      console.error(error);
    });
    await Bun.sleep(config.poll_interval_ms);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
