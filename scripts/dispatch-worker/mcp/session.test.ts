import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { createMcpCancelController, runMcpAgent } from './session';

export type McpStubMode = 'ok' | 'renamed-prompt' | 'empty' | 'error' | 'hang' | 'spawn-child';

function stubSource(mode: McpStubMode): string {
  return `
const MODE = ${JSON.stringify(mode)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, end).trim();
    input = input.slice(end + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05', capabilities: { tools: {} },
        serverInfo: { name: 'codex-mcp-server', version: '0.144.1' }
      }});
    } else if (msg.method === 'tools/list') {
      const promptName = MODE === 'renamed-prompt' ? 'task' : 'prompt';
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
        name: 'codex', description: 'stub',
        inputSchema: { type: 'object', properties: { [promptName]: { type: 'string' } }, required: [promptName] }
      }, { name: 'codex-reply', description: 'stub', inputSchema: { type: 'object' } }] }});
    } else if (msg.method === 'tools/call') {
      if (MODE === 'spawn-child') {
        require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { stdio: 'ignore' });
      }
      if (MODE === 'hang' || MODE === 'spawn-child') continue;
      const prompt = msg.params.arguments[MODE === 'renamed-prompt' ? 'task' : 'prompt'];
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'receipt' } });
      if (MODE === 'empty') send({ jsonrpc: '2.0', id: msg.id, result: { content: [] } });
      else if (MODE === 'error') send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'server reported failure' }] } });
      else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ACP_STUB_OK bytes=' + Buffer.byteLength(prompt) + ' argv=' + JSON.stringify(process.argv.slice(2)) }] } });
    }
  }
});
setInterval(() => {}, 1e9);
`;
}

export async function writeMcpStub(mode: McpStubMode): Promise<{ script: string; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-stub-'));
  const script = join(cwd, 'stub-server.cjs');
  await writeFile(script, stubSource(mode), 'utf8');
  return { script, cwd };
}

async function run(mode: McpStubMode, prompt: string, timeout = 5_000) {
  const { script, cwd } = await writeMcpStub(mode);
  return runMcpAgent(
    {
      command: process.execPath,
      args: [script],
      cwd,
      idleTimeoutMs: timeout,
      wallClockMs: 10_000,
      killGraceMs: 1_000,
    },
    prompt
  );
}

describe('runMcpAgent reliability contract', () => {
  test('completes honestly with a durable receipt and no prompt argv', async () => {
    const prompt = 'private prompt marker';
    const result = await run('ok', prompt);
    expect(result.ok).toBe(true);
    expect(result.finalText).toContain('ACP_STUB_OK');
    expect(result.finalText).not.toContain(prompt);
    expect(result.updates.length).toBeGreaterThan(0);
  });

  test('uses the required string field when the live schema has no prompt property', async () => {
    const prompt = 'schema-selected task';
    const result = await run('renamed-prompt', prompt);
    expect(result.ok).toBe(true);
    expect(result.finalText).toContain(`bytes=${Buffer.byteLength(prompt)}`);
  });

  test('empty content is not success', async () => {
    const result = await run('empty', 'produce nothing');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty_success_exit');
  });

  test('isError result fails with the server reason', async () => {
    const result = await run('error', 'fail');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('server reported failure');
  });

  test('large unicode CRLF payload round-trips byte-identically', async () => {
    const prompt = `${'x'.repeat(61_440)}\r\nUnicode: \u2603`;
    const result = await run('ok', prompt);
    expect(result.ok).toBe(true);
    expect(result.finalText).toContain(`bytes=${Buffer.byteLength(prompt)}`);
  });

  test('external cancellation kills descendants and preserves evidence', async () => {
    const { script, cwd } = await writeMcpStub('spawn-child');
    const controller = createMcpCancelController();
    setTimeout(() => controller.cancel(), 500);
    const result = await runMcpAgent(
      {
        command: process.execPath,
        args: [script],
        cwd,
        idleTimeoutMs: 10_000,
        wallClockMs: 20_000,
        killGraceMs: 2_000,
      },
      'spawn and hang',
      controller
    );
    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.treeBeforeKill.length).toBeGreaterThan(0);
    expect(result.treeAfterKill).toEqual([]);
  }, 30_000);

  test('idle timeout is an honest failure distinct from cancellation input', async () => {
    const result = await run('hang', 'timeout', 300);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe('idle');
    expect(result.error).not.toBe('');
  });
});
