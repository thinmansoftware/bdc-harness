import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

import { COMPANION_REQUEST_NOTE } from './constants';
import { DispatchClient } from './dispatch-client';
import { loadCompanionRegistry } from './registry';
import {
  callToolText,
  createHarness,
  parseToolJson,
  SECRET_PAGE,
  startFromHarness,
  startRecordingServer,
  withClient,
  type RecordedHttpRequest,
} from './test-harness';
import { executeTool } from './tools/execute';
import { TrackedTree } from './tracked-tree';

const BEARER_TAIL = 'Authorization: Bearer abcdefghijklmnop';

function ownWireMessage(body: string, id = 'own-1'): Record<string, string> {
  return {
    id,
    correlation_id: 'c-own',
    sender: 'xo',
    recipient: 'grokbot',
    body,
    status: 'queued',
    task_type: 'agent_message',
  };
}

function selectedDispatchGet(
  request: RecordedHttpRequest,
  respond: (params: URLSearchParams) => { status: number; body: unknown }
): { status: number; body: unknown } {
  if (
    request.headers.authorization !== undefined ||
    request.headers['x-archon-operator-token'] !== undefined
  ) {
    return { status: 403, body: { error: 'operator_credential_refused' } };
  }
  if (request.headers['x-dispatch-principal-id'] !== 'grokbot') {
    return { status: 401, body: { error: 'principal_required' } };
  }
  const params = new URL(request.path, 'http://stub.local').searchParams;
  const selectors = ['message_id', 'correlation_id', 'after_seq'].filter(key => params.has(key));
  if (selectors.length !== 1) {
    return { status: 400, body: { error: 'selector_required' } };
  }
  return respond(params);
}

describe('wiki oracle and mailbox tools', () => {
  test('audit_line_per_call', async () => {
    const harness = await createHarness();
    const oracle = await startRecordingServer(() => ({ status: 500, body: { error: 'down' } }));
    const running = await startFromHarness(harness, { ORACLE_URL: oracle.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        await callToolText(client, 'wiki_read', { path: 'xo-wiki/wiki/a.md' });
        await callToolText(client, 'wiki_read', { path: 'xo-wiki/wiki/secret.md' });
        await callToolText(client, 'oracle_query', { question: 'what is M-129' });
      });
      const lines = (await readFile(harness.auditLog, 'utf8'))
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      expect(lines).toHaveLength(3);
      const events = lines.map(line => JSON.parse(line) as Record<string, unknown>);
      expect(events.map(event => event.outcome)).toEqual(['ok', 'refused', 'error']);
      for (const event of events) {
        expect(event.companion_id).toBe('grokbot');
        expect(typeof event.tool).toBe('string');
        expect(event.args).toBeDefined();
        expect(typeof event.row_count).toBe('number');
      }
      const audit = lines.join('\n');
      expect(audit).not.toContain(harness.tokens.grokbot);
      expect(audit).not.toContain(harness.dispatchToken);
    } finally {
      await running.close();
      await oracle.close();
      await harness.cleanup();
    }
  });

  test('scrub_redacts_secret_patterns', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const body = parseToolJson(
          await callToolText(client, 'wiki_read', { path: 'xo-wiki/wiki/secrets.md' })
        );
        const text = String(body.text);
        expect(text).toContain('keep-me');
        expect(text).toContain('prefix ');
        expect(text).toContain(' suffix');
        for (const leaked of [
          'ghp_abcdefghijklmnopqrstuvwxyz012345',
          'sk-ant-abcdefghijklmnopqrstuvwxyz',
          'sk_live_abcdefghijklmnopqrst',
          'rk_live_abcdefghijklmnopqrst',
          'sk_test_abcdefghijklmnopqrst',
          'github_pat_abcdefghijklmnop',
          'xoxb-abcdefghijklmnopqrstuvwxyz',
          'AKIAIOSFODNN7EXAMPLE',
          'abcdefghijklmnop',
          'not-a-real-key',
          'eyJhbGciOiJIUzI1NiJ9',
          'user:pass',
          'gho_tokensecret',
        ]) {
          expect(text).not.toContain(leaked);
        }
        expect(text).toContain('[REDACTED]');
        expect(SECRET_PAGE).toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('search_scrubs_source_before_snippets', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const hidden = parseToolJson(
          await callToolText(client, 'board_record_search', { query: 'not-a-real-key' })
        );
        const hiddenText = JSON.stringify(hidden);
        expect(hiddenText).not.toContain('not-a-real-key');
        expect(hiddenText).not.toContain('BEGIN PRIVATE KEY');
        const board = parseToolJson(
          await callToolText(client, 'board_record_search', { query: 'ordinary board sentence' })
        );
        expect(JSON.stringify(board)).toContain('ordinary board sentence');
        expect(JSON.stringify(board)).not.toContain('not-a-real-key');
        const wiki = parseToolJson(
          await callToolText(client, 'wiki_search', { query: 'alpha tracked page' })
        );
        expect(JSON.stringify(wiki)).toContain('alpha tracked page');
        const kept = parseToolJson(await callToolText(client, 'wiki_search', { query: 'keep-me' }));
        const keptText = JSON.stringify(kept);
        expect(keptText).toContain('keep-me');
        expect(keptText).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
        expect(keptText).not.toContain('BEGIN PRIVATE KEY');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('wiki_read_tracked_only', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const ok = parseToolJson(
          await callToolText(client, 'wiki_read', { path: 'xo-wiki/wiki/a.md' })
        );
        expect(ok.text).toContain('alpha tracked page');
        const refused = parseToolJson(
          await callToolText(client, 'wiki_read', { path: 'xo-wiki/wiki/secret.md' })
        );
        expect(refused.error).toBe('not_tracked');
        expect(JSON.stringify(refused)).not.toContain('UNTRACKED-SECRET-CONTENT');
        const hidden = parseToolJson(
          await callToolText(client, 'wiki_search', { query: 'UNTRACKED-SECRET-CONTENT' })
        );
        expect(JSON.stringify(hidden)).not.toContain('UNTRACKED-SECRET-CONTENT');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('wiki_read_rejects_traversal_and_symlinks', async () => {
    const harness = await createHarness();
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        for (const path of ['../.env', '/etc/passwd', 'xo-wiki/wiki/outside.md']) {
          const refused = parseToolJson(await callToolText(client, 'wiki_read', { path }));
          expect(refused.error).toBe('path_refused');
          expect(JSON.stringify(refused)).not.toContain('OUTSIDE-SECRET-CONTENT');
          expect(JSON.stringify(refused)).not.toContain('root:');
        }
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('oracle_query_shapes_request_and_response', async () => {
    const seen: RecordedHttpRequest[] = [];
    const oracle = await startRecordingServer(request => {
      seen.push(request);
      return {
        status: 200,
        body: { answer: 'M-129 is the dispatch mailbox', top_score: 0.42, needs_human: false },
      };
    });
    const harness = await createHarness();
    const running = await startFromHarness(harness, { ORACLE_URL: oracle.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const body = parseToolJson(
          await callToolText(client, 'oracle_query', { question: 'what is M-129' })
        );
        expect(body.answer).toBe('M-129 is the dispatch mailbox');
        expect(body.top_score).toBe(0.42);
        expect(body.needs_human).toBe(false);
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.body).toEqual({
        session_id: 'companion-grokbot',
        message: 'what is M-129',
        page_url: '',
        conversation_history: [],
      });
    } finally {
      await running.close();
      await oracle.close();
      await harness.cleanup();
    }
  });

  test('mailbox_send_forces_sender_and_allowlist', async () => {
    const posts: RecordedHttpRequest[] = [];
    const dispatch = await startRecordingServer(request => {
      if (request.method === 'POST') {
        posts.push(request);
      }
      return { status: 200, body: { id: 'm-1' } };
    });
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const sent = parseToolJson(
          await callToolText(client, 'mailbox_send', {
            recipient: 'xo',
            text: 'please look at M-129',
          })
        );
        expect(typeof sent.correlation_id).toBe('string');
        const operator = parseToolJson(
          await callToolText(client, 'mailbox_send', { recipient: 'operator', text: 'no' })
        );
        const codex = parseToolJson(
          await callToolText(client, 'mailbox_send', { recipient: 'codex', text: 'no' })
        );
        expect(operator.error).toBe('recipient_not_allowed');
        expect(codex.error).toBe('recipient_not_allowed');
      });
      expect(posts).toHaveLength(1);
      const post = posts[0];
      const body = post?.body as Record<string, unknown>;
      expect(body?.sender).toBe('grokbot');
      expect(body?.recipient).toBe('xo');
      expect(body?.task_type).toBe('agent_message');
      expect(body?.priority).toBeUndefined();
      expect(post?.headers['x-dispatch-principal-id']).toBe('grokbot');
      expect(post?.headers['x-dispatch-principal-token']).toBe(harness.dispatchToken);
      const wrapped = JSON.parse(String(body?.body)) as Record<string, unknown>;
      expect(wrapped.untrusted).toBe(true);
      expect(wrapped.kind).toBe('companion_request');
      expect(wrapped.from_companion).toBe('grokbot');
      expect(wrapped.note).toBe(COMPANION_REQUEST_NOTE);
      expect(wrapped.text).toBe('please look at M-129');
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });

  test('mailbox_list_and_read_are_own_inbox_only', async () => {
    const dispatch = await startRecordingServer(request =>
      selectedDispatchGet(request, params => {
        const messageId = params.get('message_id');
        if (messageId !== null) {
          return {
            status: 200,
            body: messageId === 'own-1' ? [ownWireMessage('hello grokbot')] : [],
          };
        }
        return {
          status: 200,
          body: {
            messages: [ownWireMessage('hello grokbot')],
            next_after_seq: 4,
            page_full: false,
          },
        };
      })
    );
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listed = parseToolJson(await callToolText(client, 'mailbox_list', {}));
        const messages = listed.messages as Array<{ id: string }>;
        expect(messages.map(message => message.id)).toEqual(['own-1']);
        expect(listed.next_after_seq).toBe(4);
        expect(listed.page_full).toBe(false);
        const refused = parseToolJson(await callToolText(client, 'mailbox_read', { id: 'xo-1' }));
        expect(refused.error).toBe('not_own_message');
        expect(JSON.stringify(refused)).not.toContain('XO-PRIVATE-BODY');
      });
      const gets = dispatch.requests.filter(request => request.method === 'GET');
      const lists = gets.filter(request => request.path.includes('after_seq='));
      const reads = gets.filter(request => request.path.includes('message_id='));
      expect(lists).toHaveLength(1);
      expect(reads).toHaveLength(1);
      expect(lists[0]?.path).toContain('recipient=grokbot');
      expect(lists[0]?.path).toContain('after_seq=0');
      expect(lists[0]?.path).toContain('limit=500');
      expect(reads[0]?.path).toContain('recipient=grokbot');
      expect(reads[0]?.path).toContain('message_id=xo-1');
      expect(reads[0]?.path).not.toContain('limit=');
      for (const call of gets) {
        expect(call.path).not.toContain('recipient=xo');
        expect(call.headers['x-dispatch-principal-id']).toBe('grokbot');
        expect(call.headers.authorization).toBeUndefined();
        expect(call.headers['x-archon-operator-token']).toBeUndefined();
      }
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });

  test('nested_structured_responses_redact_bearer_and_stay_json', async () => {
    const dispatch = await startRecordingServer(request =>
      selectedDispatchGet(request, params => {
        const message = ownWireMessage(`ordinary hello ${BEARER_TAIL}`);
        const messageId = params.get('message_id');
        if (messageId !== null) {
          return { status: 200, body: messageId === 'own-1' ? [message] : [] };
        }
        return {
          status: 200,
          body: { messages: [message], next_after_seq: 4, page_full: false },
        };
      })
    );
    const oracle = await startRecordingServer(() => ({
      status: 200,
      body: {
        answer: `ordinary answer ${BEARER_TAIL}`,
        top_score: 0.42,
        needs_human: false,
      },
    }));
    const harness = await createHarness();
    const running = await startFromHarness(harness, {
      DISPATCH_BASE_URL: dispatch.url,
      ORACLE_URL: oracle.url,
    });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listedText = await callToolText(client, 'mailbox_list', {});
        const listed = parseToolJson(listedText);
        const messages = listed.messages as Array<{ id: string; body: string }>;
        expect(messages.map(message => message.id)).toEqual(['own-1']);
        expect(messages[0]?.body).toContain('ordinary hello');
        expect(listedText).not.toContain('abcdefghijklmnop');
        expect(listedText).not.toContain('Bearer');
        const readText = await callToolText(client, 'mailbox_read', { id: 'own-1' });
        const read = parseToolJson(readText);
        expect(String(read.body)).toContain('ordinary hello');
        expect(readText).not.toContain('abcdefghijklmnop');
        const refusedText = await callToolText(client, 'mailbox_read', { id: 'xo-1' });
        const refused = parseToolJson(refusedText);
        expect(refused.error).toBe('not_own_message');
        expect(refusedText).not.toContain('XO-PRIVATE-BODY');
        const oracleText = await callToolText(client, 'oracle_query', {
          question: 'what is M-129',
        });
        const answer = parseToolJson(oracleText);
        expect(String(answer.answer)).toContain('ordinary answer');
        expect(oracleText).not.toContain('abcdefghijklmnop');
        expect(answer.top_score).toBe(0.42);
        expect(typeof answer.top_score).toBe('number');
        expect(answer.needs_human).toBe(false);
        expect(typeof answer.needs_human).toBe('boolean');
      });
    } finally {
      await running.close();
      await dispatch.close();
      await oracle.close();
      await harness.cleanup();
    }
  });

  test('mailbox_ack_always_sends_principal_headers', async () => {
    const dispatch = await startRecordingServer(request => {
      if (request.method === 'POST' && request.path.includes('/ack')) {
        return { status: 200, body: { id: 'own-1', principal_id: 'grokbot' } };
      }
      return { status: 200, body: [] };
    });
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const acked = parseToolJson(await callToolText(client, 'mailbox_ack', { id: 'own-1' }));
        expect(acked.id).toBe('own-1');
      });
      const acks = dispatch.requests.filter(request => request.path.includes('/ack'));
      expect(acks).toHaveLength(1);
      expect(acks[0]?.headers['x-dispatch-principal-id']).toBe('grokbot');
      expect(acks[0]?.headers['x-dispatch-principal-token']).toBe(harness.dispatchToken);
      expect(acks[0]?.body).toEqual({ principal_id: 'grokbot' });
      expect(acks[0]?.headers.authorization).toBeUndefined();
      expect(acks[0]?.headers['x-archon-operator-token']).toBeUndefined();
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });

  test('mailbox_read_uses_direct_id_beyond_the_first_page', async () => {
    const previousOperatorToken = process.env.ARCHON_OPERATOR_TOKEN;
    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret-must-not-be-sent';
    const later = ownWireMessage('LATER-OWN-BODY', 'later-id');
    const dispatch = await startRecordingServer(request =>
      selectedDispatchGet(request, params => {
        const messageId = params.get('message_id');
        if (messageId !== null) {
          if (messageId === 'later-id') return { status: 200, body: [later] };
          return { status: 200, body: [] };
        }
        if (params.get('after_seq') === '500') {
          return { status: 200, body: { messages: [], next_after_seq: 500, page_full: false } };
        }
        if (!params.has('after_seq')) {
          return { status: 400, body: { error: 'selector_required' } };
        }
        return {
          status: 200,
          body: {
            messages: [ownWireMessage('OLD-PAGE-BODY', 'old-id')],
            next_after_seq: 500,
            page_full: true,
          },
        };
      })
    );
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const read = parseToolJson(await callToolText(client, 'mailbox_read', { id: 'later-id' }));
        expect(read.id).toBe('later-id');
        expect(read.body).toBe('LATER-OWN-BODY');
        const foreign = parseToolJson(
          await callToolText(client, 'mailbox_read', { id: 'foreign-id' })
        );
        const unknown = parseToolJson(
          await callToolText(client, 'mailbox_read', { id: 'missing-id' })
        );
        expect(foreign).toEqual({ error: 'not_own_message' });
        expect(unknown).toEqual({ error: 'not_own_message' });
        expect(JSON.stringify(foreign)).not.toContain('FOREIGN');
        const listed = parseToolJson(
          await callToolText(client, 'mailbox_list', { status: 'queued' })
        );
        expect(listed.messages).toEqual([
          expect.objectContaining({ id: 'old-id', body: 'OLD-PAGE-BODY' }),
        ]);
        expect(listed.next_after_seq).toBe(500);
        expect(listed.page_full).toBe(true);
        const next = parseToolJson(
          await callToolText(client, 'mailbox_list', { after_seq: listed.next_after_seq })
        );
        expect(next.messages).toEqual([]);
        expect(next.next_after_seq).toBe(500);
        expect(next.page_full).toBe(false);
      });
      const gets = dispatch.requests.filter(request => request.method === 'GET');
      expect(gets).toHaveLength(5);
      for (const call of gets) {
        expect(call.headers['x-dispatch-principal-id']).toBe('grokbot');
        expect(call.headers['x-dispatch-principal-token']).toBe(harness.dispatchToken);
        expect(call.headers.authorization).toBeUndefined();
        expect(call.headers['x-archon-operator-token']).toBeUndefined();
        expect(JSON.stringify(call.headers)).not.toContain('operator-secret-must-not-be-sent');
      }
      const reads = gets.filter(request => request.path.includes('message_id='));
      expect(reads.map(request => request.path)).toEqual([
        expect.stringContaining('message_id=later-id'),
        expect.stringContaining('message_id=foreign-id'),
        expect.stringContaining('message_id=missing-id'),
      ]);
      expect(reads.every(request => !request.path.includes('after_seq='))).toBe(true);
      const lists = gets.filter(request => request.path.includes('after_seq='));
      expect(lists[0]?.path).toContain('after_seq=0');
      expect(lists[0]?.path).toContain('status=queued');
      expect(lists[1]?.path).toContain('after_seq=500');
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
      if (previousOperatorToken === undefined) delete process.env.ARCHON_OPERATOR_TOKEN;
      else process.env.ARCHON_OPERATOR_TOKEN = previousOperatorToken;
    }
  });

  test('mailbox_list_schema_cursor_and_malformed_dispatch_are_refused', async () => {
    const harness = await createHarness();
    const slot = loadCompanionRegistry(harness.configPath).slots.find(
      entry => entry.companion_id === 'grokbot'
    );
    if (slot === undefined) {
      throw new Error('missing grokbot slot');
    }
    const deps = {
      wikiRoot: harness.wikiRoot,
      tree: new TrackedTree(harness.wikiRoot),
      oracleUrl: 'http://127.0.0.1:9',
      dispatch: new DispatchClient('http://127.0.0.1:9'),
      auditLog: harness.auditLog,
      env: harness.env,
    };
    const invalidCursors: unknown[] = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2'];
    for (const afterSeq of invalidCursors) {
      const refused = await executeTool(slot, 'mailbox_list', { after_seq: afterSeq }, deps);
      expect(refused.isError).toBe(true);
      expect(refused.content[0]).toMatchObject({
        type: 'text',
        text: '{"error":"cursor_invalid"}',
      });
    }
    const unavailable = await executeTool(slot, 'mailbox_list', {}, deps);
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content[0]).toMatchObject({
      type: 'text',
      text: '{"error":"dispatch_unavailable"}',
    });

    const dispatch = await startRecordingServer(request =>
      selectedDispatchGet(request, params => {
        const afterSeq = params.get('after_seq');
        if (afterSeq === '0') {
          return { status: 200, body: [ownWireMessage('SHOULD-NOT-LEAK')] };
        }
        if (afterSeq === '1') {
          return { status: 500, body: { error: 'down' } };
        }
        return { status: 200, body: { messages: 'nope', next_after_seq: 2, page_full: false } };
      })
    );
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listed = await client.listTools();
        const schema = listed.tools.find(tool => tool.name === 'mailbox_list')?.inputSchema as {
          required?: string[];
          properties?: Record<string, { type?: string; minimum?: number }>;
        };
        expect(schema.required ?? []).not.toContain('after_seq');
        expect(schema.properties?.status?.type).toBe('string');
        expect(
          schema.properties?.after_seq?.type === 'integer' ||
            schema.properties?.after_seq?.type === 'number'
        ).toBe(true);
        expect(schema.properties?.after_seq?.minimum).toBe(0);
        for (const afterSeq of [0, 1, 2]) {
          const text = await callToolText(client, 'mailbox_list', { after_seq: afterSeq });
          expect(parseToolJson(text).error).toBe('dispatch_rejected');
          expect(text).not.toContain('SHOULD-NOT-LEAK');
        }
      });
      expect(dispatch.requests.filter(request => request.method === 'GET')).toHaveLength(3);
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });
});
