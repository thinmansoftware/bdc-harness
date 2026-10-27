/**
 * Typed client for the Cursor Cloud Agents API (https://api.cursor.com).
 *
 * Auth is HTTP Basic with the API key as the username and an empty password.
 * The key is never written into a URL, a log line, or an error message.
 * This client has no delete or archive method: cloud agents stay visible.
 */
export class CursorCloudHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Cursor API HTTP ${status}`);
    this.name = 'CursorCloudHttpError';
    this.status = status;
  }
}

export interface CursorCloudAgentRecord {
  id: string;
  url: string;
  name?: string;
  status?: string;
  createdAt?: string;
  latestRunId?: string;
}

export interface CursorCloudRunRecord {
  id: string;
  agentId?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationMs?: number;
}

export interface CursorCloudAgentUsage {
  cost?: {
    rawCostCents?: number;
    chargedCents?: number;
  };
}

export interface CursorCloudAgentPage {
  items: CursorCloudAgentRecord[];
  nextCursor?: string;
}

export interface CursorCloudCreateAgentInput {
  promptText: string;
  modelId: string;
  name: string;
  repoUrl: string;
  startingRef: string;
  agentId: string;
}

export interface CursorCloudAgentClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.cursor.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function redact(message: string, key: string): string {
  const token = Buffer.from(`${key}:`, 'utf8').toString('base64');
  return message.split(key).join('[redacted]').split(token).join('[redacted]');
}

function agentFrom(value: unknown): CursorCloudAgentRecord | null {
  const body = isRecord(value) ? value : null;
  const nested = body && isRecord(body.agent) ? body.agent : null;
  const source = nested ?? body;
  if (!source) return null;
  const id = str(source.id);
  const url = str(source.url);
  if (!id || !url) return null;
  const createdAt = str(source.createdAt);
  const latestRunId = str(source.latestRunId);
  const name = str(source.name);
  const status = str(source.status);
  return {
    id,
    url,
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(latestRunId ? { latestRunId } : {}),
  };
}

function runIdFromCreate(value: unknown, agent: CursorCloudAgentRecord): string | undefined {
  const body = isRecord(value) ? value : null;
  const nested = body && isRecord(body.run) ? body.run : null;
  return str(nested?.id) ?? str(body?.runId) ?? str(body?.latestRunId) ?? agent.latestRunId;
}

function runFrom(value: unknown): CursorCloudRunRecord | null {
  const body = isRecord(value) ? value : null;
  const nested = body && isRecord(body.run) ? body.run : null;
  const source = nested ?? body;
  if (!source) return null;
  const id = str(source.id);
  const status = str(source.status);
  if (!id || !status) return null;
  const agentId = str(source.agentId);
  const createdAt = str(source.createdAt);
  const updatedAt = str(source.updatedAt);
  const durationMs = typeof source.durationMs === 'number' ? source.durationMs : undefined;
  return {
    id,
    status,
    ...(agentId ? { agentId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export class CursorCloudAgentClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(options: CursorCloudAgentClientOptions) {
    if (!options.apiKey) {
      throw new Error('CURSOR_API_KEY required for cursor-cloud transport');
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.authorization = `Basic ${Buffer.from(`${options.apiKey}:`, 'utf8').toString('base64')}`;
  }

  async createAgent(
    input: CursorCloudCreateAgentInput
  ): Promise<CursorCloudAgentRecord & { runId?: string }> {
    const body = {
      prompt: { text: input.promptText },
      model: { id: input.modelId },
      name: input.name.slice(0, 100),
      env: { type: 'cloud' },
      repos: [{ url: input.repoUrl, startingRef: input.startingRef }],
      workOnCurrentBranch: true,
      autoCreatePR: false,
      skipReviewerRequest: true,
      mode: 'agent',
      agentId: input.agentId,
    };
    const payload = await this.request('POST', '/v1/agents', body);
    const agent = agentFrom(payload);
    if (!agent) {
      throw new Error('Cursor API create response missing id or url');
    }
    const runId = runIdFromCreate(payload, agent);
    return { ...agent, ...(runId ? { runId } : {}) };
  }

  async getAgent(agentId: string): Promise<CursorCloudAgentRecord> {
    const payload = await this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}`);
    const agent = agentFrom(payload);
    if (!agent) {
      throw new Error('Cursor API agent response missing id or url');
    }
    return agent;
  }

  async createRun(agentId: string, promptText: string): Promise<CursorCloudRunRecord> {
    const payload = await this.request('POST', `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      prompt: { text: promptText },
    });
    const run = runFrom(payload);
    if (!run) {
      throw new Error('Cursor API run response missing id or status');
    }
    return run;
  }

  async getRun(
    agentId: string,
    runId: string,
    signal?: AbortSignal
  ): Promise<CursorCloudRunRecord> {
    const payload = await this.request(
      'GET',
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
      undefined,
      signal
    );
    const run = runFrom(payload);
    if (!run) {
      throw new Error('Cursor API run response missing id or status');
    }
    return run;
  }

  async cancelRun(agentId: string, runId: string): Promise<void> {
    await this.request(
      'POST',
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`
    );
  }

  async listAgents(cursor?: string): Promise<CursorCloudAgentPage> {
    const path = cursor ? `/v1/agents?cursor=${encodeURIComponent(cursor)}` : '/v1/agents';
    const payload = await this.request('GET', path);
    const body = isRecord(payload) ? payload : null;
    const rawItems = body && Array.isArray(body.items) ? body.items : null;
    if (!rawItems) {
      throw new Error('Cursor API agents response missing items');
    }
    const items: CursorCloudAgentRecord[] = [];
    for (const item of rawItems) {
      const agent = agentFrom(item);
      if (agent) items.push(agent);
    }
    const nextCursor = body ? str(body.nextCursor) : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async getAgentUsage(agentId: string): Promise<CursorCloudAgentUsage> {
    const payload = await this.request('GET', `/v1/agents/${encodeURIComponent(agentId)}/usage`);
    const body = isRecord(payload) ? payload : null;
    const cost = body && isRecord(body.cost) ? body.cost : null;
    if (!cost) return {};
    const rawCostCents = typeof cost.rawCostCents === 'number' ? cost.rawCostCents : undefined;
    const chargedCents = typeof cost.chargedCents === 'number' ? cost.chargedCents : undefined;
    return {
      cost: {
        ...(rawCostCents !== undefined ? { rawCostCents } : {}),
        ...(chargedCents !== undefined ? { chargedCents } : {}),
      },
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authorization,
      Accept: 'application/json',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'cursor-cloud request failed';
      throw new Error(redact(message, this.apiKey));
    }
    if (!response.ok) {
      await response.text().catch(() => '');
      throw new CursorCloudHttpError(response.status);
    }
    if (response.status === 204) return {};
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cursor API response was not JSON';
      throw new Error(redact(message, this.apiKey));
    }
  }
}
