import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { DispatchClient } from './dispatch-client';
import { buildMcpServer } from './mcp';
import { loadCompanionRegistry, parseCompanionRegistry } from './registry';
import { TrackedTree } from './tracked-tree';
import type { ToolDeps } from './tools/execute';

const EXAMPLE = join(
  import.meta.dir,
  '../../../deploy/companion-mcp/companions.config.example.json'
);

function slot(principal: string, recipients: string[] = ['xo']): Record<string, unknown> {
  return {
    companion_id: principal.replace(/[^a-z0-9-]/g, '') || 'slot',
    enabled: true,
    dispatch_principal_id: principal,
    token_sha256_file: '/run/companion-mcp/digests/slot.sha256',
    token_expires_at: '2099-01-01T00:00:00.000Z',
    dispatch_credential_file: '/run/companion-mcp/dispatch/slot',
    tools: ['wiki_read'],
    allowed_recipients: recipients,
    board_secretary: false,
    board_seat_recipients: ['astra'],
  };
}

describe('companion registry', () => {
  test('example_config_has_grokbot_enabled_and_three_disabled_slots', async () => {
    const registry = loadCompanionRegistry(EXAMPLE);
    expect(registry.slots.map(entry => entry.companion_id)).toEqual([
      'grokbot',
      'dot',
      'muse',
      'duet',
    ]);
    expect(registry.slots.filter(entry => entry.enabled).map(entry => entry.companion_id)).toEqual([
      'grokbot',
    ]);
    expect(
      registry.slots.filter(entry => entry.board_secretary).map(entry => entry.companion_id)
    ).toEqual(['grokbot']);
  });

  test('registry_rejects_privileged_principals', () => {
    const privileged = ['xo', 'operator', 'john', 'board', 'system:x'];
    for (const principal of privileged) {
      expect(() => parseCompanionRegistry({ slots: [slot(principal)] })).toThrow(
        'registry_invalid:dispatch_principal_id'
      );
    }
    expect(() => parseCompanionRegistry({ slots: [slot('grokbot', ['operator'])] })).toThrow(
      'registry_invalid:allowed_recipients'
    );
    expect(() =>
      parseCompanionRegistry({
        slots: [slot('grokbot', ['dot']), slot('dot', ['xo'])],
      })
    ).toThrow('registry_invalid:allowed_recipients');
  });

  test('registered_tools_equal_allowlist', async () => {
    const registry = loadCompanionRegistry(EXAMPLE);
    const deps: ToolDeps = {
      wikiRoot: '/tmp',
      tree: new TrackedTree('/tmp'),
      oracleUrl: 'http://127.0.0.1:9',
      dispatch: new DispatchClient('http://127.0.0.1:9'),
      auditLog: '/tmp/companion-mcp-audit.log',
      env: {},
    };
    const raw = JSON.parse(await readFile(EXAMPLE, 'utf8')) as { slots: unknown[] };
    expect(raw.slots).toHaveLength(4);
    for (const entry of registry.slots) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = buildMcpServer(entry, deps);
      await mcp.connect(serverTransport);
      const client = new Client({ name: 'allowlist-test', version: '0.0.1' });
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map(tool => tool.name).sort();
      expect(names).toEqual([...entry.tools].sort());
      for (const name of names) {
        expect(name).not.toMatch(/shell|exec|sql|deploy|vault|secret/);
      }
      expect(names.includes('board_record_propose')).toBe(entry.board_secretary);
      await client.close();
      await mcp.close();
    }
  });
});
