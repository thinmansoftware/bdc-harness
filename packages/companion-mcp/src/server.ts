import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { appendAudit } from './audit';
import { authenticateRequest } from './auth';
import { DEFAULT_PORT } from './constants';
import { DispatchClient } from './dispatch-client';
import { buildMcpServer } from './mcp';
import { loadCompanionRegistry } from './registry';
import { TrackedTree } from './tracked-tree';
import type { ToolDeps } from './tools/execute';

type Env = Record<string, string | undefined>;

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  companionId: string;
}

export interface RunningCompanionServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function assertBindAddr(value: string | undefined): string {
  const bind = value?.trim();
  if (
    bind === undefined ||
    bind === '' ||
    bind === '0.0.0.0' ||
    bind === '::' ||
    bind === '::0' ||
    bind === '[::]'
  ) {
    throw new Error('bind_addr_refused');
  }
  return bind;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('invalid_port');
  }
  return port;
}

function requiredEnv(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing_env:${name}`);
  }
  return value;
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export async function startCompanionMcp(env: Env = process.env): Promise<RunningCompanionServer> {
  const bindAddr = assertBindAddr(env.COMPANION_MCP_BIND_ADDR);
  const port = readPort(env.COMPANION_MCP_PORT);
  const configPath = requiredEnv(env, 'COMPANION_MCP_CONFIG');
  const auditLog = requiredEnv(env, 'COMPANION_MCP_AUDIT_LOG');
  const revokedFile = requiredEnv(env, 'COMPANION_MCP_REVOKED_FILE');
  const wikiRoot = requiredEnv(env, 'COMPANION_WIKI_ROOT');
  const oracleUrl = requiredEnv(env, 'ORACLE_URL');
  const dispatchBaseUrl = requiredEnv(env, 'DISPATCH_BASE_URL');
  const registry = loadCompanionRegistry(configPath);
  const tree = new TrackedTree(wikiRoot);
  await tree.start();
  const dispatch = new DispatchClient(dispatchBaseUrl);
  const deps: ToolDeps = { wikiRoot, tree, oracleUrl, dispatch, auditLog, env };
  const sessions = new Map<string, SessionRecord>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal_error' });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://companion.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/mcp') {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    const auth = authenticateRequest(headerValue(req.headers.authorization), registry, revokedFile);
    if (!auth.ok) {
      appendAudit(auditLog, {
        companionId: auth.companionId,
        tool: 'auth',
        args: { code: auth.code },
        rowCount: 0,
        outcome: 'refused',
        error: auth.code,
      });
      writeJson(res, auth.status, { error: auth.code });
      return;
    }
    const sessionId = headerValue(req.headers['mcp-session-id']);
    if (sessionId !== undefined && sessionId !== '') {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        writeJson(res, 404, { error: 'session_not_found' });
        return;
      }
      if (existing.companionId !== auth.slot.companion_id) {
        writeJson(res, 401, { error: 'unauthorized' });
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }
    const holder: { session?: SessionRecord } = {};
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: (): string => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string): void => {
        if (holder.session !== undefined) {
          sessions.set(id, holder.session);
        }
      },
      onsessionclosed: (id: string): void => {
        sessions.delete(id);
      },
    });
    const mcp = buildMcpServer(auth.slot, deps);
    holder.session = { transport, server: mcp, companionId: auth.slot.companion_id };
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, bindAddr, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('bind_failed');
  }

  return {
    baseUrl: `http://${bindAddr}:${address.port}`,
    close: async (): Promise<void> => {
      tree.stop();
      for (const session of sessions.values()) {
        await session.transport.close();
        await session.server.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

if (import.meta.main) {
  startCompanionMcp()
    .then(running => {
      process.stdout.write(`companion-mcp listening ${running.baseUrl}\n`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'startup_failed';
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
