import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { describeTool } from './constants';
import type { CompanionSlot } from './types';
import { executeTool, type ToolDeps } from './tools/execute';

export function buildMcpServer(slot: CompanionSlot, deps: ToolDeps): McpServer {
  const mcp = new McpServer({
    name: `bdc-companion-${slot.companion_id}`,
    version: '0.3.10',
  });
  for (const name of slot.tools) {
    mcp.registerTool(name, { description: describeTool(name) }, () => ({
      content: [{ type: 'text', text: '{"error":"unhandled"}' }],
      isError: true,
    }));
  }
  mcp.server.setRequestHandler(CallToolRequestSchema, request => {
    const args = request.params.arguments ?? {};
    return executeTool(slot, request.params.name, args, deps);
  });
  return mcp;
}
