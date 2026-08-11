import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from '@archon/paths';
import { z } from 'zod';
import { fireWorkflow, type OperatorRequestOptions } from './tools/fire';
import { getRun, getNodeEvents, listDashboardRuns } from './tools/inspect';
import {
  sendMessage,
  claimMessage,
  postResult,
  ackMessage,
  addressMessage,
  cancelMessage,
} from './tools/dispatch';

const log = createLogger('mcp-operator');
const baseUrl = process.env.ARCHON_API_BASE_URL ?? 'http://localhost:3090';
const textResult = (value: unknown): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const options = (scope: 'inspect' | 'message' | 'fire'): OperatorRequestOptions => ({
  baseUrl,
  token: process.env[`ARCHON_OPERATOR_TOKEN_${scope.toUpperCase()}`] ?? '',
});
const bodySchema = z.record(z.string(), z.unknown());
const actionSchema = { id: z.string(), body: bodySchema };

export function createOperatorMcpServer(): McpServer {
  const server = new McpServer({ name: 'archon-operator', version: '0.3.10' });

  server.registerTool(
    'fire_workflow',
    {
      inputSchema: {
        name: z.string(),
        conversationId: z.string(),
        message: z.string(),
        approved_by: z.string(),
        approval_reason: z.string(),
        conductor: z.unknown().optional(),
      },
    },
    input => fireWorkflow(options('fire'), input).then(textResult)
  );
  server.registerTool('get_run', { inputSchema: { runId: z.string() } }, input =>
    getRun(options('inspect'), input.runId).then(textResult)
  );
  server.registerTool(
    'get_node_events',
    {
      inputSchema: {
        runId: z.string(),
        nodeId: z.string(),
        limit: z.number().int().positive().optional(),
      },
    },
    input => getNodeEvents(options('inspect'), input).then(textResult)
  );
  server.registerTool(
    'list_dashboard_runs',
    {
      inputSchema: {
        query: z.record(z.string(), z.string()).optional(),
      },
    },
    input => listDashboardRuns(options('inspect'), input.query).then(textResult)
  );
  server.registerTool('send_message', { inputSchema: { body: bodySchema } }, input =>
    sendMessage(options('message'), input.body).then(textResult)
  );
  server.registerTool('claim_message', { inputSchema: actionSchema }, input =>
    claimMessage(options('message'), input.id, input.body).then(textResult)
  );
  server.registerTool('post_result', { inputSchema: actionSchema }, input =>
    postResult(options('message'), input.id, input.body).then(textResult)
  );
  server.registerTool('ack_message', { inputSchema: actionSchema }, input =>
    ackMessage(options('message'), input.id, input.body).then(textResult)
  );
  server.registerTool('address_message', { inputSchema: actionSchema }, input =>
    addressMessage(options('message'), input.id, input.body).then(textResult)
  );
  server.registerTool('cancel_message', { inputSchema: actionSchema }, input =>
    cancelMessage(options('message'), input.id, input.body).then(textResult)
  );
  return server;
}

if (import.meta.main) {
  createOperatorMcpServer()
    .connect(new StdioServerTransport())
    .catch(error => {
      log.error({ err: error }, 'mcp_operator.start_failed');
      process.exitCode = 1;
    });
}
