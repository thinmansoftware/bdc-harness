import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

import { secretaryLabel } from './constants';
import {
  BASE_REGISTER,
  callToolText,
  createHarness,
  parseToolJson,
  startFromHarness,
  startRecordingServer,
  withClient,
  type RecordedHttpRequest,
} from './test-harness';

const BASE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function isForbiddenGithub(request: RecordedHttpRequest): boolean {
  const path = request.path.toLowerCase();
  if (
    path.includes('/merge') ||
    path.includes('/reviews') ||
    path.includes('protection') ||
    path.includes('auto-merge')
  ) {
    return true;
  }
  if (request.method !== 'GET' && /\/git\/refs\/heads\/main(?:\?|$)/.test(path)) {
    return true;
  }
  if (typeof request.body === 'object' && request.body !== null && 'ref' in request.body) {
    const ref = String((request.body as { ref?: unknown }).ref ?? '');
    if (ref === 'refs/heads/main' || ref === 'refs/heads/master') {
      return true;
    }
  }
  return false;
}

function contentPath(request: RecordedHttpRequest): string {
  const raw = request.path.split('/contents/')[1] ?? '';
  return decodeURIComponent(raw.split('?')[0] ?? '');
}

function githubStub(
  files: Map<string, string>,
  options: { conflictOnPull?: { count: number } } = {}
): (request: RecordedHttpRequest) => { status: number; body: unknown } {
  const blobs: unknown[] = [];
  return request => {
    if (isForbiddenGithub(request)) {
      throw new Error(`forbidden github ${request.method} ${request.path}`);
    }
    if (!request.path.startsWith('/repos/thinmansoftware/bdc-xo/')) {
      throw new Error(`unexpected repo ${request.path}`);
    }
    if (request.method === 'GET' && request.path.includes('/git/ref/heads/main')) {
      return { status: 200, body: { object: { sha: BASE_SHA, type: 'commit' } } };
    }
    if (request.method === 'GET' && request.path.includes('/git/commits/')) {
      if (!request.path.includes(BASE_SHA)) {
        throw new Error(`read outside base ${request.path}`);
      }
      return { status: 200, body: { sha: BASE_SHA, tree: { sha: TREE_SHA } } };
    }
    if (request.method === 'GET' && request.path.includes('/contents/')) {
      if (!request.path.includes(`ref=${BASE_SHA}`)) {
        throw new Error(`contents read outside base ${request.path}`);
      }
      const file = contentPath(request);
      const text = files.get(file);
      if (text === undefined) {
        return { status: 404, body: { message: 'not found' } };
      }
      return { status: 200, body: { type: 'file', encoding: 'utf-8', content: text } };
    }
    if (request.method === 'POST' && request.path.endsWith('/git/blobs')) {
      blobs.push(request.body);
      return { status: 201, body: { sha: `c${blobs.length.toString(16).padStart(39, '0')}` } };
    }
    if (request.method === 'POST' && request.path.endsWith('/git/trees')) {
      return { status: 201, body: { sha: `d${'1'.padStart(39, '0')}` } };
    }
    if (request.method === 'POST' && request.path.endsWith('/git/commits')) {
      return { status: 201, body: { sha: `e${'2'.padStart(39, '0')}` } };
    }
    if (request.method === 'POST' && request.path.endsWith('/git/refs')) {
      return { status: 201, body: { ref: 'ok', object: { sha: `e${'2'.padStart(39, '0')}` } } };
    }
    if (request.method === 'POST' && request.path.endsWith('/pulls')) {
      options.conflictOnPull && (options.conflictOnPull.count += 1);
      if (options.conflictOnPull && options.conflictOnPull.count > 1) {
        return { status: 409, body: { message: 'conflict' } };
      }
      return {
        status: 201,
        body: { number: 7, html_url: 'https://github.com/thinmansoftware/bdc-xo/pull/7' },
      };
    }
    throw new Error(`unexpected github ${request.method} ${request.path}`);
  };
}

interface StoredMessage {
  id: string;
  correlation_id: string;
  sender: string;
  recipient: string;
  body: string;
  status: string;
  task_type: string;
}

function dispatchStub(seed: StoredMessage[] = []): {
  handler: (request: RecordedHttpRequest) => { status: number; body: unknown };
  messages: StoredMessage[];
} {
  const messages = [...seed];
  return {
    messages,
    handler: request => {
      if (request.method === 'GET') {
        const recipient = new URL(request.path, 'http://stub.local').searchParams.get('recipient');
        return { status: 200, body: messages.filter(message => message.recipient === recipient) };
      }
      const body = request.body as Record<string, unknown>;
      const stored: StoredMessage = {
        id: `id-${messages.length + 1}`,
        correlation_id: String(body.correlation_id ?? ''),
        sender: String(body.sender ?? ''),
        recipient: String(body.recipient ?? ''),
        body: String(body.body ?? ''),
        status: 'queued',
        task_type: String(body.task_type ?? ''),
      };
      messages.push(stored);
      return { status: 200, body: stored };
    },
  };
}

async function enableDot(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    slots: Array<{ companion_id: string; enabled: boolean }>;
  };
  for (const slot of config.slots) {
    if (slot.companion_id === 'dot') {
      slot.enabled = true;
    }
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(configPath, JSON.stringify(config), 'utf8');
}

describe('board secretary tools', () => {
  test('board_tools_only_for_board_secretary_slots', async () => {
    const harness = await createHarness();
    await enableDot(harness.configPath);
    const running = await startFromHarness(harness);
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const names = (await client.listTools()).tools.map(tool => tool.name);
        for (const tool of [
          'board_record_search',
          'board_record_read',
          'board_brief_send',
          'board_replies_collect',
          'board_record_propose',
        ]) {
          expect(names).toContain(tool);
        }
      });
      await withClient(running.baseUrl, harness.tokens.dot, async client => {
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names).not.toContain('board_record_search');
        expect(names).not.toContain('board_record_propose');
        const refused = parseToolJson(
          await callToolText(client, 'board_brief_send', {
            motion_id: 'M-TEST',
            seats: ['astra'],
            brief_text: 'hello',
          })
        );
        expect(refused.error).toBe('tool_not_allowed');
      });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('board_brief_send_and_collect', async () => {
    const dispatch = dispatchStub([
      {
        id: 'noise',
        correlation_id: 'other-correlation',
        sender: 'astra',
        recipient: 'grokbot',
        body: 'NOISE-OTHER-CORRELATION',
        status: 'queued',
        task_type: 'agent_message',
      },
    ]);
    const server = await startRecordingServer(dispatch.handler);
    const harness = await createHarness();
    const running = await startFromHarness(harness, { DISPATCH_BASE_URL: server.url });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const before = server.requests.filter(request => request.method === 'POST').length;
        const refused = parseToolJson(
          await callToolText(client, 'board_brief_send', {
            motion_id: 'M-TEST',
            seats: ['astra', 'fable', 'grok', 'operator'],
            brief_text: 'design question',
          })
        );
        expect(refused.error).toBe('recipient_not_allowed');
        expect(server.requests.filter(request => request.method === 'POST')).toHaveLength(before);
        const sent = parseToolJson(
          await callToolText(client, 'board_brief_send', {
            motion_id: 'M-TEST',
            seats: ['astra', 'fable', 'grok'],
            brief_text: 'design question',
          })
        );
        const correlation = String(sent.correlation_id);
        expect(correlation).toMatch(/^board-brief-M-TEST-\d{8}T\d{6}Z$/);
        const posts = server.requests.filter(request => request.method === 'POST');
        expect(posts).toHaveLength(3);
        const correlations = posts.map(
          post => (post.body as { correlation_id: string }).correlation_id
        );
        expect(new Set(correlations)).toEqual(new Set([correlation]));
        dispatch.messages.push({
          id: 'reply-astra',
          correlation_id: correlation,
          sender: 'astra',
          recipient: 'grokbot',
          body: 'ASTRA-REPLY-BODY',
          status: 'queued',
          task_type: 'agent_message',
        });
        const collected = parseToolJson(
          await callToolText(client, 'board_replies_collect', { correlation_id: correlation })
        );
        const messages = collected.messages as Array<{ correlation_id: string; body: string }>;
        expect(messages.map(message => message.body)).toEqual(['ASTRA-REPLY-BODY']);
        expect(messages.every(message => message.correlation_id === correlation)).toBe(true);
        expect(JSON.stringify(collected)).not.toContain('NOISE-OTHER-CORRELATION');
      });
    } finally {
      await running.close();
      await server.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_opens_labelled_pr_and_mails_xo', async () => {
    const files = new Map<string, string>([['docs/board/motions/REGISTER.md', BASE_REGISTER]]);
    const github = await startRecordingServer(githubStub(files));
    const dispatch = dispatchStub();
    const mail = await startRecordingServer(dispatch.handler);
    const harness = await createHarness();
    const synthesis = `${secretaryLabel('grokbot')}\n\nSeats disagreed. The secretary records that without ranking them.\n`;
    const addition = `| M-TEST | recorded | ${secretaryLabel('grokbot')} |\n`;
    const register = `${BASE_REGISTER}${addition}`;
    const running = await startFromHarness(harness, {
      COMPANION_GITHUB_API_BASE: github.url,
      DISPATCH_BASE_URL: mail.url,
    });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const result = parseToolJson(
          await callToolText(client, 'board_record_propose', {
            kind: 'synthesis',
            motion_id: 'M-TEST',
            summary: 'Record the synthesis round',
            files: [
              { path: 'docs/board/motions/M-TEST.synthesis.md', content: synthesis },
              { path: 'docs/board/motions/REGISTER.md', content: register },
            ],
          })
        );
        expect(result.pr_url).toBe('https://github.com/thinmansoftware/bdc-xo/pull/7');
        expect(String(result.branch)).toMatch(/^companion\/grokbot\/M-TEST-\d{8}T\d{6}Z$/);
      });
      const mutations = github.requests.filter(request => request.method !== 'GET');
      expect(mutations.some(request => request.path.endsWith('/pulls'))).toBe(true);
      expect(
        github.requests.some(
          request => request.path.includes('/git/refs/heads/main') && request.method !== 'GET'
        )
      ).toBe(false);
      const blobs = github.requests.filter(request => request.path.endsWith('/git/blobs'));
      const blobText = blobs.map(request =>
        String((request.body as { content?: unknown }).content ?? '')
      );
      expect(blobText.some(content => content.startsWith(secretaryLabel('grokbot')))).toBe(true);
      const registerBlob = blobText.find(content =>
        content.includes('| M-1 | RATIFIED | historical |')
      );
      expect(registerBlob).toBe(register);
      expect(registerBlob?.startsWith(BASE_REGISTER)).toBe(true);
      expect(registerBlob?.startsWith(secretaryLabel('grokbot'))).toBe(false);
      const pull = github.requests.find(request => request.path.endsWith('/pulls'));
      const pullBody = String((pull?.body as { body?: unknown } | undefined)?.body ?? '');
      expect(pullBody).toContain(secretaryLabel('grokbot'));
      expect(pullBody).toContain('M-TEST');
      expect(pullBody).toContain('synthesis');
      const ref = github.requests.find(request => request.path.endsWith('/git/refs'));
      expect(String((ref?.body as { ref?: unknown } | undefined)?.ref ?? '')).toMatch(
        /^refs\/heads\/companion\/grokbot\/M-TEST-\d{8}T\d{6}Z$/
      );
      const xo = dispatch.messages.filter(message => message.recipient === 'xo');
      expect(xo).toHaveLength(1);
      expect(xo[0]?.sender).toBe('grokbot');
      expect(xo[0]?.task_type).toBe('agent_message');
      expect(xo[0]?.body).toContain('https://github.com/thinmansoftware/bdc-xo/pull/7');
    } finally {
      await running.close();
      await github.close();
      await mail.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_refuses_local_violations_with_zero_github_requests', async () => {
    const github = await startRecordingServer(githubStub(new Map()));
    const harness = await createHarness();
    const label = secretaryLabel('grokbot');
    const running = await startFromHarness(harness, { COMPANION_GITHUB_API_BASE: github.url });
    const cases: Array<{ files: Array<{ path: string; content: string }> }> = [
      { files: [{ path: 'README.md', content: `${label}\noutside\n` }] },
      { files: [{ path: 'docs/board/motions/M-TEST-RULING.md', content: `${label}\nno\n` }] },
      { files: [{ path: 'docs/board/motions/M-TEST-ruling.md', content: `${label}\nno\n` }] },
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST-Ruling.synthesis.md',
            content: `${label}\nno\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/design-rounds/M-TEST-Ruling.md',
            content: `${label}\nno\n`,
          },
        ],
      },
      { files: [{ path: 'docs/board/motions/M-TEST.votes.md', content: `${label}\nno\n` }] },
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST.synthesis.md',
            content: `${label}\n\n## Ruling\nnotes\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST.synthesis.md',
            content: `${label}\n\nJohn decided the motion should proceed.\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/design-rounds/M-TEST.discussion.md',
            content: `${label}\n\nStatus RATIFIED in this edit.\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/design-rounds/M-TEST.discussion.md',
            content: `${label}\n\nStatus ratified in this edit.\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST.synthesis.md',
            content: `${label}\n\n## ruling\nnotes\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/design-rounds/M-TEST.discussion.md',
            content: `${label}\n\n## Ruling\ninserted into an existing round file\n`,
          },
        ],
      },
      {
        files: [
          {
            path: 'docs/board/design-rounds/M-TEST.discussion.md',
            content: `${label}\n\nJohn decided this design round is closed.\n`,
          },
        ],
      },
    ];
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        for (const item of cases) {
          const before = github.requests.length;
          const refused = parseToolJson(
            await callToolText(client, 'board_record_propose', {
              kind: 'synthesis',
              motion_id: 'M-TEST',
              summary: 'should not reach github',
              files: item.files,
            })
          );
          expect(refused.error === 'path_refused' || refused.error === 'ruling_refused').toBe(true);
          expect(github.requests).toHaveLength(before);
        }
      });
      expect(github.requests).toHaveLength(0);
    } finally {
      await running.close();
      await github.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_refuses_motion_id_path_mismatch', async () => {
    const github = await startRecordingServer(githubStub(new Map()));
    const harness = await createHarness();
    const permitted = `${secretaryLabel('grokbot')}\n\nSeats disagreed. The secretary records that without ranking them.\n`;
    const running = await startFromHarness(harness, { COMPANION_GITHUB_API_BASE: github.url });
    const cases: Array<{ files: Array<{ path: string; content: string }> }> = [
      { files: [{ path: 'docs/board/motions/M-OTHER.synthesis.md', content: permitted }] },
      { files: [{ path: 'docs/board/motions/M-OTHER-draft.md', content: permitted }] },
      { files: [{ path: 'docs/board/motions/M-TESTER.synthesis.md', content: permitted }] },
      { files: [{ path: 'docs/board/design-rounds/M-OTHER.discussion.md', content: permitted }] },
      { files: [{ path: 'docs/board/design-rounds/M-OTHER/notes.md', content: permitted }] },
      { files: [{ path: 'docs/board/design-rounds/round-M-OTHER.md', content: permitted }] },
      {
        files: [
          { path: 'docs/board/motions/M-TEST.synthesis.md', content: permitted },
          { path: 'docs/board/motions/M-OTHER.synthesis.md', content: permitted },
        ],
      },
    ];
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        for (const item of cases) {
          const before = github.requests.length;
          const refused = parseToolJson(
            await callToolText(client, 'board_record_propose', {
              kind: 'synthesis',
              motion_id: 'M-TEST',
              summary: 'path claims a different motion',
              files: item.files,
            })
          );
          expect(refused.error).toBe('path_refused');
          expect(github.requests).toHaveLength(before);
        }
      });
      expect(github.requests).toHaveLength(0);
    } finally {
      await running.close();
      await github.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_refuses_existing_edits_before_mutation', async () => {
    const files = new Map<string, string>([
      [
        'docs/board/motions/M-TEST-existing.md',
        `${secretaryLabel('grokbot')}\n\nOriginal motion.\n`,
      ],
      [
        'docs/board/motions/M-TEST.synthesis.md',
        `${secretaryLabel('grokbot')}\n\nOriginal synthesis.\n`,
      ],
      ['docs/board/motions/REGISTER.md', BASE_REGISTER],
    ]);
    const github = await startRecordingServer(githubStub(files));
    const harness = await createHarness();
    const label = secretaryLabel('grokbot');
    const running = await startFromHarness(harness, { COMPANION_GITHUB_API_BASE: github.url });
    const calls: Array<{ files: Array<{ path: string; content: string }>; error: string }> = [
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST-existing.md',
            content: `${label}\n\nEdited the draft.\n`,
          },
        ],
        error: 'path_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/M-TEST.synthesis.md',
            content: `${label}\n\nEdited the existing synthesis.\n`,
          },
        ],
        error: 'path_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: BASE_REGISTER.replace(
              '| M-1 | RATIFIED | historical |',
              '| M-1 | OPEN | historical |'
            ),
          },
        ],
        error: 'path_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: `${BASE_REGISTER}| M-9 | RATIFIED | new row |\n`,
          },
        ],
        error: 'ruling_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: `${BASE_REGISTER}| M-9 | ratified | ${label} |\n`,
          },
        ],
        error: 'ruling_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: BASE_REGISTER.replace(
              '| M-2 | CARRIED | historical |',
              `| M-INJECT | recorded | ${label} |\n| M-2 | CARRIED | historical |`
            ),
          },
        ],
        error: 'path_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: `${BASE_REGISTER}| M-TEST | recorded | note |\n`,
          },
        ],
        error: 'path_refused',
      },
      {
        files: [
          {
            path: 'docs/board/motions/REGISTER.md',
            content: `${BASE_REGISTER}| M-A | recorded | ${label} |\n| M-B | recorded | ${label} |\n`,
          },
        ],
        error: 'path_refused',
      },
    ];
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        for (const item of calls) {
          const before = github.requests.length;
          const refused = parseToolJson(
            await callToolText(client, 'board_record_propose', {
              kind: 'register_row',
              motion_id: 'M-TEST',
              summary: 'state dependent refusal',
              files: item.files,
            })
          );
          expect(refused.error).toBe(item.error);
          const added = github.requests.slice(before);
          expect(added.length).toBeGreaterThan(0);
          expect(added.every(request => request.method === 'GET')).toBe(true);
          expect(
            added.every(request => request.path.startsWith('/repos/thinmansoftware/bdc-xo/'))
          ).toBe(true);
        }
      });
      expect(github.requests.some(request => request.method !== 'GET')).toBe(false);
    } finally {
      await running.close();
      await github.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_refuses_repo_other_than_bdc_xo', async () => {
    const github = await startRecordingServer(githubStub(new Map()));
    const harness = await createHarness();
    const running = await startFromHarness(harness, {
      COMPANION_GITHUB_API_BASE: github.url,
      COMPANION_BOARD_REPO: 'other-org/other-repo',
    });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const refused = parseToolJson(
          await callToolText(client, 'board_record_propose', {
            kind: 'synthesis',
            motion_id: 'M-TEST',
            summary: 'should not reach github',
            files: [
              {
                path: 'docs/board/motions/M-TEST.synthesis.md',
                content: `${secretaryLabel('grokbot')}\n\nA permitted new synthesis.\n`,
              },
            ],
          })
        );
        expect(refused.error).toBe('github_credential_unavailable');
      });
      expect(github.requests).toHaveLength(0);
    } finally {
      await running.close();
      await github.close();
      await harness.cleanup();
    }
  });

  test('board_record_propose_never_merges', async () => {
    const files = new Map<string, string>();
    const conflict = { count: 0 };
    const github = await startRecordingServer(githubStub(files, { conflictOnPull: conflict }));
    const dispatch = dispatchStub();
    const mail = await startRecordingServer(dispatch.handler);
    const harness = await createHarness();
    const content = `${secretaryLabel('grokbot')}\n\nA permitted new synthesis.\n`;
    const running = await startFromHarness(harness, {
      COMPANION_GITHUB_API_BASE: github.url,
      DISPATCH_BASE_URL: mail.url,
    });
    try {
      await withClient(running.baseUrl, harness.tokens.grokbot, async client => {
        const ok = parseToolJson(
          await callToolText(client, 'board_record_propose', {
            kind: 'synthesis',
            motion_id: 'M-TEST',
            summary: 'open the record',
            files: [{ path: 'docs/board/motions/M-TEST.synthesis.md', content }],
          })
        );
        expect(ok.pr_url).toContain('/pull/7');
        const conflicted = parseToolJson(
          await callToolText(client, 'board_record_propose', {
            kind: 'synthesis',
            motion_id: 'M-TEST',
            summary: 'second attempt',
            files: [{ path: 'docs/board/motions/M-TEST.synthesis.md', content }],
          })
        );
        expect(conflicted.error).toBe('pr_create_conflict');
      });
      expect(github.requests.some(request => isForbiddenGithub(request))).toBe(false);
      const writes = github.requests.filter(request => request.method !== 'GET');
      for (const request of writes) {
        expect(request.path).toMatch(/\/git\/(blobs|trees|commits|refs)$|\/pulls$/);
      }
    } finally {
      await running.close();
      await github.close();
      await mail.close();
      await harness.cleanup();
    }
  });
});
