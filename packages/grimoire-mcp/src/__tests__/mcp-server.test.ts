import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGrimoireServer } from '../mcp-server';
import fixture from './fixtures/base.json';

test('10 MCP exposes exactly read-only pr_card and handles invalid refs', async () => {
  const deps: any = {
    github: async () => ({
      pr: fixture,
      reviews: [],
      checkRuns: [{ name: 'x', status: 'completed', conclusion: 'success' }],
      statuses: [],
      checks: [],
      woId: null,
      issue: null,
      issueAssignee: null,
      status: 'ok',
    }),
    eventStore: async () => ({ runs: [], status: 'ok' }),
    taskmaster: async () => ({ recipient: null, status: 'ok' }),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createGrimoireServer(deps);
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  expect(listed.tools).toHaveLength(1);
  expect(listed.tools[0]?.name).toBe('pr_card');
  expect(listed.tools[0]?.annotations?.readOnlyHint).toBe(true);
  const valid: any = await client.callTool({
    name: 'pr_card',
    arguments: { pr: 'thinmansoftware/bdc-harness#1' },
  });
  expect(JSON.parse(valid.content[0].text).blocker_class).toBeTruthy();
  const invalid: any = await client.callTool({ name: 'pr_card', arguments: { pr: 'nope' } });
  expect(invalid.isError).toBe(true);
  await client.close();
  await server.close();
});
test('13 CLI bad reference exits 2 with the required diagnostic', async () => {
  const process = Bun.spawn(
    ['bun', 'run', new URL('../cli.ts', import.meta.url).pathname, 'card', 'nope'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).toBe(2);
  expect(stderr.trim()).toBe('expected PR reference in owner/repo#N form');
});
