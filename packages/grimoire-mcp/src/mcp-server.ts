import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildBlockedPrCard, type CardDeps } from './build-card';

export function createGrimoireServer(deps: CardDeps = {}): Server {
  const server = new Server(
    { name: 'grimoire', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'pr_card',
        description: 'Render a read-only blocked PR card',
        inputSchema: {
          type: 'object',
          properties: { pr: { type: 'string' } },
          required: ['pr'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== 'pr_card')
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    try {
      const raw = request.params.arguments?.pr;
      const card = await buildBlockedPrCard(typeof raw === 'string' ? raw : '', deps);
      return { content: [{ type: 'text', text: JSON.stringify(card) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}
if (import.meta.main) await createGrimoireServer().connect(new StdioServerTransport());
