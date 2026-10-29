import { connect } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { loadCompanionRegistry } from './registry';
import {
  callToolText,
  createHarness,
  parseToolJson,
  startFromHarness,
  withClient,
  writeConfig,
  type Harness,
} from './test-harness';

async function canConnect(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

describe('companion mcp server', () => {
  test('mcp_endpoint_initializes_and_lists_tools', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listed = await client.listTools();
        expect(listed.tools.map(tool => tool.name)).toContain('wiki_read');
        expect(listed.tools.map(tool => tool.name)).toContain('board_record_propose');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('refuses_wildcard_or_missing_bind_address', async () => {
    const port = 39123;
    const cases: Array<Record<string, string>> = [
      { COMPANION_MCP_PORT: String(port) },
      { COMPANION_MCP_BIND_ADDR: '0.0.0.0', COMPANION_MCP_PORT: String(port) },
      { COMPANION_MCP_BIND_ADDR: '::', COMPANION_MCP_PORT: String(port) },
    ];
    for (const env of cases) {
      await expect(startFromHarness({ env } as Harness, env)).rejects.toThrow('bind_addr_refused');
    }
    expect(await canConnect(port)).toBe(false);
  });

  test('bearer_token_required_and_checked', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      const bodies = [undefined, 'Bearer', `Bearer ${harness.tokens.grokbot}-wrong`];
      for (const authorization of bodies) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (authorization !== undefined) {
          headers.authorization = authorization;
        }
        const response = await fetch(`${running.baseUrl}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(response.status).toBe(401);
      }
      const audit = await readFile(harness.auditLog, 'utf8');
      expect(audit).toContain('"outcome":"refused"');
      expect(audit).not.toContain(harness.tokens.grokbot);
      expect(audit).not.toContain(`${harness.tokens.grokbot}-wrong`);
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('expired_token_refused', async () => {
    const harness = await createHarness();
    const config = JSON.parse(await readFile(harness.configPath, 'utf8')) as {
      slots: Array<{ companion_id: string; token_expires_at: string }>;
    };
    for (const slot of config.slots) {
      if (slot.companion_id === 'grokbot') {
        slot.token_expires_at = '2000-01-01T00:00:00.000Z';
      }
    }
    await writeConfig(harness, config);
    const running = await startFromHarness(harness);
    try {
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.tokens.grokbot}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('token_expired');
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('revoke_takes_effect_on_next_call', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listed = await client.listTools();
        expect(listed.tools.length).toBeGreaterThan(0);
      });
      const digest = createHash('sha256').update(harness.tokens.grokbot).digest('hex');
      await writeFile(harness.revokedFile, JSON.stringify([digest]), 'utf8');
      const response = await fetch(`${running.baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.tokens.grokbot}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('token_revoked');
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('healthz_has_no_secrets', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      const response = await fetch(`${running.baseUrl}/healthz`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: true });
      expect(Object.keys(JSON.parse(text) as object)).toEqual(['ok']);
      expect(text).not.toContain(harness.tokens.grokbot);
      expect(text).not.toContain(harness.dispatchToken);
      expect(text).not.toContain(harness.configPath);
      expect(text).not.toContain('sha256');
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('enabling_a_slot_by_config_only', async () => {
    const harness = await createHarness();
    const config = JSON.parse(await readFile(harness.configPath, 'utf8')) as {
      slots: Array<{ companion_id: string; enabled: boolean; tools: string[] }>;
    };
    for (const slot of config.slots) {
      if (slot.companion_id === 'dot') {
        slot.enabled = true;
      }
    }
    await writeConfig(harness, config);
    const registry = loadCompanionRegistry(harness.configPath);
    expect(registry.slots.find(slot => slot.companion_id === 'dot')?.enabled).toBe(true);
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.dot, async client => {
        const names = (await client.listTools()).tools.map(tool => tool.name).sort();
        const dot = registry.slots.find(slot => slot.companion_id === 'dot');
        expect(names).toEqual([...(dot?.tools ?? [])].sort());
        expect(names).not.toContain('board_record_propose');
        const refused = parseToolJson(
          await callToolText(client, 'board_record_propose', {
            kind: 'synthesis',
            motion_id: 'M-TEST',
            files: [],
            summary: 'no',
          })
        );
        expect(refused.error).toBe('tool_not_allowed');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });
});
