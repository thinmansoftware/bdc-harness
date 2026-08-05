/**
 * BDC-owned MCP client leg for native `codex mcp-server` stdio dispatches.
 * Prompt payloads are encoded by the SDK onto child stdin and never appended to argv.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { enumerateProcessTree, killProcessTree, waitForTreeDeath } from '../acp/kill-tree';

export interface McpRunConfig {
  command: string;
  args: string[];
  cwd: string;
  idleTimeoutMs: number;
  wallClockMs: number;
  killGraceMs: number;
  toolName?: string;
  env?: Record<string, string>;
}

export interface McpRunResult {
  ok: boolean;
  stopReason: string | null;
  finalText: string;
  updates: unknown[];
  timedOut: 'idle' | 'wall' | null;
  cancelled: boolean;
  exitCode: number | null;
  agentPid: number | null;
  treeBeforeKill: number[];
  treeAfterKill: number[];
  durationMs: number;
  error?: string;
}

export interface McpCancelController {
  cancelled: boolean;
  cancel: () => void;
}

export function createMcpCancelController(): McpCancelController {
  const controller: McpCancelController = {
    cancelled: false,
    cancel: () => {
      controller.cancelled = true;
    },
  };
  return controller;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'mcp_failed';
  }
}

function promptArgument(schema: unknown, prompt: string): Record<string, unknown> {
  const value = schema as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  const properties = value?.properties ?? {};
  const candidates = Object.entries(properties).filter(
    ([, property]) => property.type === 'string'
  );
  const name =
    (properties.prompt?.type === 'string' ? 'prompt' : undefined) ??
    value.required?.find(key => properties[key]?.type === 'string') ??
    candidates[0]?.[0];
  if (!name) throw new Error('codex tool inputSchema has no string prompt field');
  return { [name]: prompt };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      const record = item as Record<string, unknown> | null;
      if (record && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .join('');
}

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
}

/** Records server notifications while delegating all wire behavior to the official SDK. */
class ReceiptTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private messageHandler?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly inner: StdioClientTransport,
    private readonly updates: unknown[],
    private readonly onActivity: () => void
  ) {}

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this.messageHandler = handler;
  }

  get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
    return this.messageHandler;
  }

  async start(): Promise<void> {
    this.inner.onclose = (): void => {
      this.onclose?.();
    };
    this.inner.onerror = (error): void => {
      this.onerror?.(error);
    };
    this.inner.onmessage = (message): void => {
      this.onActivity();
      if ('method' in message && !('id' in message)) this.updates.push(message);
      this.messageHandler?.(message);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

export async function runMcpAgent(
  config: McpRunConfig,
  prompt: string,
  external?: McpCancelController
): Promise<McpRunResult> {
  const startedAt = Date.now();
  const updates: unknown[] = [];
  let timedOut: 'idle' | 'wall' | null = null;
  let cancelled = false;
  let error: string | undefined;
  let finalText = '';
  let agentPid: number | null = null;
  let treeBeforeKill: number[] = [];
  let treeAfterKill: number[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    cwd: config.cwd,
    env: childEnvironment(config.env ?? {}),
    stderr: 'pipe',
  });
  let killPromise: Promise<void> | undefined;
  const boundedKill = (): Promise<void> => {
    killPromise ??= (async (): Promise<void> => {
      const pid = transport.pid;
      if (pid === null) return;
      const tree = await enumerateProcessTree(pid);
      treeBeforeKill = tree.map(node => node.pid);
      await killProcessTree(pid);
      treeAfterKill = await waitForTreeDeath(treeBeforeKill, config.killGraceMs);
    })();
    return killPromise;
  };
  const requestCancel = (reason: 'idle' | 'wall' | 'external'): void => {
    if (cancelled) return;
    cancelled = true;
    if (reason !== 'external') timedOut = reason;
    void boundedKill();
  };
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      requestCancel('idle');
    }, config.idleTimeoutMs);
    idleTimer.unref?.();
  };
  const recording = new ReceiptTransport(transport, updates, armIdle);
  const client = new Client({ name: 'bdc-dispatch-worker', version: '1.0.0' });
  const wallTimer = setTimeout(() => {
    requestCancel('wall');
  }, config.wallClockMs);
  wallTimer.unref?.();
  const externalPoll = setInterval(() => {
    if (external?.cancelled) requestCancel('external');
  }, 50);
  externalPoll.unref?.();

  try {
    armIdle();
    await client.connect(recording);
    agentPid = transport.pid;
    const listed = await client.listTools();
    const toolName = config.toolName ?? 'codex';
    const tool = listed.tools.find(candidate => candidate.name === toolName);
    if (!tool) throw new Error(`MCP tool not found: ${toolName}`);
    const args = promptArgument(tool.inputSchema, prompt);
    const result = await client.callTool({ name: tool.name, arguments: args });
    finalText = contentText(result.content);
    if (result.isError === true) error = finalText.trim() || 'MCP tools/call returned isError=true';
    else if (finalText.trim().length === 0) {
      error = 'empty_success_exit: MCP tools/call returned no text content';
    }
  } catch (caught) {
    error = error ?? errorText(caught);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(wallTimer);
    clearInterval(externalPoll);
    if (transport.pid !== null) await boundedKill();
    await client.close().catch(() => undefined);
  }
  if (cancelled && error === undefined) error = timedOut ? `${timedOut}_timeout` : 'cancelled';
  const ok = !cancelled && error === undefined && finalText.trim().length > 0;
  return {
    ok,
    stopReason: null,
    finalText,
    updates,
    timedOut,
    cancelled,
    exitCode: null,
    agentPid,
    treeBeforeKill,
    treeAfterKill,
    durationMs: Date.now() - startedAt,
    ...(error !== undefined ? { error } : {}),
  };
}
