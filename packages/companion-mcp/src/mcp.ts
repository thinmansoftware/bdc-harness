import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { appendAudit } from './audit';
import { describeTool } from './constants';
import type { CompanionSlot } from './types';
import { executeTool, type ToolDeps } from './tools/execute';
import { validateToolArguments, zodInputShape } from './tools/schemas';

function isArgsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidParams(
  slot: CompanionSlot,
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): CallToolResult {
  appendAudit(deps.auditLog, {
    companionId: slot.companion_id,
    tool: name,
    args,
    rowCount: 0,
    outcome: 'refused',
    error: 'invalid_params',
  });
  return {
    content: [{ type: 'text', text: '{"error":"invalid_params"}' }],
    isError: true,
  };
}

export function buildMcpServer(slot: CompanionSlot, deps: ToolDeps): McpServer {
  const mcp = new McpServer({
    name: `bdc-companion-${slot.companion_id}`,
    version: '0.3.10',
  });
  for (const name of slot.tools) {
    mcp.registerTool(
      name,
      { description: describeTool(name), inputSchema: zodInputShape(name) },
      () => ({
        content: [{ type: 'text', text: '{"error":"unhandled"}' }],
        isError: true,
      })
    );
  }
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const raw: unknown = request.params.arguments;
    const args = isArgsRecord(raw) ? raw : {};
    if (slot.tools.includes(name) && !validateToolArguments(name, raw ?? {})) {
      return invalidParams(slot, name, args, deps);
    }
    return executeTool(slot, name, args, deps);
  });
  return mcp;
}
