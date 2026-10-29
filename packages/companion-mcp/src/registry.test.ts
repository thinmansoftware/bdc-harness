import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { PROPOSAL_KINDS } from './constants';
import { DispatchClient } from './dispatch-client';
import { buildMcpServer } from './mcp';
import { loadCompanionRegistry, parseCompanionRegistry } from './registry';
import { TrackedTree } from './tracked-tree';
import type { ToolDeps } from './tools/execute';

interface ListedProperty {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  items?: { type?: string; required?: string[]; properties?: Record<string, { type?: string }> };
}

interface ListedSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ListedProperty>;
}

const SCHEMA_FIELDS: Record<string, { required: string[]; types: Record<string, string> }> = {
  wiki_search: { required: ['query'], types: { query: 'string', limit: 'integer' } },
  wiki_read: { required: ['path'], types: { path: 'string' } },
  oracle_query: { required: ['question'], types: { question: 'string' } },
  mailbox_send: {
    required: ['recipient', 'text'],
    types: { recipient: 'string', text: 'string', correlation_id: 'string' },
  },
  mailbox_list: { required: [], types: { status: 'string' } },
  mailbox_read: { required: ['id'], types: { id: 'string' } },
  mailbox_ack: { required: ['id'], types: { id: 'string' } },
  board_record_search: { required: ['query'], types: { query: 'string', limit: 'integer' } },
  board_record_read: { required: ['path'], types: { path: 'string' } },
  board_brief_send: {
    required: ['motion_id', 'seats', 'brief_text'],
    types: { motion_id: 'string', seats: 'array', brief_text: 'string' },
  },
  board_replies_collect: { required: ['correlation_id'], types: { correlation_id: 'string' } },
  board_record_propose: {
    required: ['kind', 'motion_id', 'summary', 'files'],
    types: { kind: 'string', motion_id: 'string', summary: 'string', files: 'array' },
  },
};

function listedSchema(value: unknown): ListedSchema {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as ListedSchema;
}

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
      const listed = await client.listTools();
      const names = listed.tools.map(tool => tool.name).sort();
      expect(names).toEqual([...entry.tools].sort());
      for (const name of names) {
        expect(name).not.toMatch(/shell|exec|sql|deploy|vault|secret/);
        const expected = SCHEMA_FIELDS[name];
        expect(expected).toBeDefined();
        const schema = listedSchema(listed.tools.find(tool => tool.name === name)?.inputSchema);
        expect(schema.type).toBe('object');
        expect(schema.required ?? []).toEqual(expected?.required ?? []);
        for (const [field, type] of Object.entries(expected?.types ?? {})) {
          const property = schema.properties?.[field];
          expect(
            property?.type === type || (type === 'integer' && property?.type === 'number')
          ).toBe(true);
        }
        if (name === 'wiki_search' || name === 'board_record_search') {
          const limit = schema.properties?.limit;
          expect(limit?.minimum).toBe(1);
          expect(limit?.maximum).toBe(20);
        }
        if (name === 'board_record_propose') {
          expect(schema.properties?.kind?.enum).toEqual([...PROPOSAL_KINDS]);
          expect(schema.properties?.files?.items?.type).toBe('object');
          expect(schema.properties?.files?.items?.required).toEqual(['path', 'content']);
          expect(schema.properties?.files?.items?.properties?.path?.type).toBe('string');
          expect(schema.properties?.files?.items?.properties?.content?.type).toBe('string');
        }
        if (name === 'board_brief_send') {
          expect(schema.properties?.seats?.items?.type).toBe('string');
        }
      }
      expect(names.includes('board_record_propose')).toBe(entry.board_secretary);
      await client.close();
      await mcp.close();
    }
  });
});
