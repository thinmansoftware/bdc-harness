import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('operator MCP server', () => {
  test('mounts every declared v1 tool', async () => {
    const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    for (const name of [
      'fire_workflow',
      'get_run',
      'get_node_events',
      'list_dashboard_runs',
      'send_message',
      'claim_message',
      'post_result',
      'ack_message',
      'address_message',
      'cancel_message',
    ]) {
      expect(source).toContain(`registerTool('${name}'`);
    }
  });
});
