#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fireWorkflow, fireWorkflowInput } from './tools/fire.js';
import {
  getRun,
  getRunInput,
  getNodeEvents,
  getNodeEventsInput,
  listDashboardRuns,
  listDashboardRunsInput,
} from './tools/inspect.js';
import {
  sendMessage,
  claimMessage,
  postResult,
  ackMessage,
  addressMessage,
  cancelMessage,
  dispatchBodyInput,
  dispatchMessageInput,
} from './tools/dispatch.js';

export function createOperatorMcpServer(): McpServer {
  const server = new McpServer({ name: 'archon-operator', version: '0.3.10' });
  server.registerTool('fire_workflow', { inputSchema: fireWorkflowInput }, args =>
    fireWorkflow(args)
  );
  server.registerTool('get_run', { inputSchema: getRunInput }, args => getRun(args));
  server.registerTool('get_node_events', { inputSchema: getNodeEventsInput }, args =>
    getNodeEvents(args)
  );
  server.registerTool('list_dashboard_runs', { inputSchema: listDashboardRunsInput }, args =>
    listDashboardRuns(args)
  );
  server.registerTool('send_message', { inputSchema: dispatchBodyInput }, args =>
    sendMessage(args)
  );
  server.registerTool('claim_message', { inputSchema: dispatchMessageInput }, args =>
    claimMessage(args)
  );
  server.registerTool('post_result', { inputSchema: dispatchMessageInput }, args =>
    postResult(args)
  );
  server.registerTool('ack_message', { inputSchema: dispatchMessageInput }, args =>
    ackMessage(args)
  );
  server.registerTool('address_message', { inputSchema: dispatchMessageInput }, args =>
    addressMessage(args)
  );
  server.registerTool('cancel_message', { inputSchema: dispatchMessageInput }, args =>
    cancelMessage(args)
  );
  return server;
}

if (import.meta.main) await createOperatorMcpServer().connect(new StdioServerTransport());
