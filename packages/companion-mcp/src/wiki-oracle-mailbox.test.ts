import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { COMPANION_REQUEST_NOTE } from './constants';
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

const BEARER_TAIL = 'Authorization: Bearer abcdefghijklmnop';

describe('wiki oracle and mailbox tools', () => {
  test('audit_line_per_call', async () => {
    const harness = await createHarness();
    const oracle = await startRecordingServer(() => ({ status: 500, body: { error: 'down' } }));
    const running = await startFromHarness(harness, { ORACLE_URL: oracle.url });
    try {
      await writeFile(
        join(harness.wikiRoot, 'xo-wiki/wiki/secret.md'),
        'UNTRACKED-SECRET-CONTENT\n',
        'utf8'
      );
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
      await writeFile(
        join(harness.wikiRoot, 'xo-wiki/wiki/secret.md'),
        'UNTRACKED-SECRET-CONTENT\n',
        'utf8'
      );
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
    const dispatch = await startRecordingServer(request => {
      const url = new URL(request.path, 'http://stub.local');
      const recipient = url.searchParams.get('recipient');
      if (recipient === 'grokbot') {
        return {
          status: 200,
          body: [
            {
              id: 'own-1',
              correlation_id: 'c-own',
              sender: 'xo',
              recipient: 'grokbot',
              body: 'hello grokbot',
              status: 'queued',
              task_type: 'agent_message',
            },
          ],
        };
      }
      return {
        status: 200,
        body: [
          {
            id: 'xo-1',
            correlation_id: 'c-xo',
            sender: 'astra',
            recipient: 'xo',
            body: 'XO-PRIVATE-BODY',
            status: 'queued',
            task_type: 'agent_message',
          },
        ],
      };
    });
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: dispatch.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const listed = parseToolJson(await callToolText(client, 'mailbox_list', {}));
        const messages = listed.messages as Array<{ id: string }>;
        expect(messages.map(message => message.id)).toEqual(['own-1']);
        const refused = parseToolJson(await callToolText(client, 'mailbox_read', { id: 'xo-1' }));
        expect(refused.error).toBe('not_own_message');
        expect(JSON.stringify(refused)).not.toContain('XO-PRIVATE-BODY');
      });
      const listCalls = dispatch.requests.filter(request => request.method === 'GET');
      expect(listCalls.length).toBeGreaterThan(0);
      for (const call of listCalls) {
        expect(call.path).toContain('recipient=grokbot');
        expect(call.path).toContain('limit=500');
        expect(call.path).not.toContain('recipient=xo');
      }
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });

  test('nested_structured_responses_redact_bearer_and_stay_json', async () => {
    const dispatch = await startRecordingServer(request => {
      const url = new URL(request.path, 'http://stub.local');
      if (url.searchParams.get('recipient') === 'grokbot') {
        return {
          status: 200,
          body: [
            {
              id: 'own-1',
              correlation_id: 'c-own',
              sender: 'xo',
              recipient: 'grokbot',
              body: `ordinary hello ${BEARER_TAIL}`,
              status: 'queued',
              task_type: 'agent_message',
            },
          ],
        };
      }
      return {
        status: 200,
        body: [
          {
            id: 'xo-1',
            correlation_id: 'c-xo',
            sender: 'astra',
            recipient: 'xo',
            body: 'XO-PRIVATE-BODY',
            status: 'queued',
            task_type: 'agent_message',
          },
        ],
      };
    });
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
    } finally {
      await running.close();
      await dispatch.close();
      await harness.cleanup();
    }
  });
});
