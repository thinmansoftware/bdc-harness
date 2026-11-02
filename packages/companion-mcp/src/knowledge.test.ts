import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { WIKI_PREFIX } from './constants';
import { DispatchClient } from './dispatch-client';
import { loadCompanionRegistry } from './registry';
import type { RunningCompanionServer } from './server';
import { createHarness, startFromHarness } from './test-harness';
import { executeTool, type ToolDeps } from './tools/execute';
import { oracleSearch } from './tools/oracle';
import { searchTree, wikiRead } from './tools/wiki';
import { TrackedTree } from './tracked-tree';
import type { CompanionSlot } from './types';

const ORACLE_URL = 'https://oracle.bluedevilcollectibles.com/v1/search';
const EXAMPLE = join(
  import.meta.dir,
  '../../../deploy/companion-mcp/companions.config.example.json'
);
const WIKI_SYNC = join(import.meta.dir, '../../../deploy/companion-mcp/wiki-sync.sh');

const RETRIEVAL_FIXTURE = {
  query: 'q',
  top_k: 3,
  results: [
    {
      doc_id: 'd',
      doc_title: 'T',
      doc_source: 'wiki/x',
      chunk_id: 'c',
      chunk_idx: 0,
      text: 'Dispatch is transport',
      score: 0.81,
    },
  ],
};

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== 'GIT_DIR' &&
      key !== 'GIT_WORK_TREE' &&
      key !== 'GIT_INDEX_FILE'
    ) {
      env[key] = value;
    }
  }
  return env;
}

async function git(root: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', root, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnv(),
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '--', '.']);
  await git(root, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    message,
  ]);
}

function knowledgeSlot(): CompanionSlot {
  return {
    companion_id: 'grok-bot',
    enabled: true,
    dispatch_principal_id: 'grok-bot',
    token_sha256_file: '/tmp/grok-bot.sha256',
    token_expires_at: '2099-01-01T00:00:00.000Z',
    token_expires_ms: Date.parse('2099-01-01T00:00:00.000Z'),
    dispatch_credential_file: '/tmp/grok-bot',
    tools: ['wiki_search', 'wiki_read', 'oracle_search'],
    allowed_recipients: ['xo'],
    board_secretary: false,
    board_seat_recipients: ['astra'],
  };
}

function toolText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text' || first.text === undefined) {
    throw new Error('missing tool text');
  }
  return first.text;
}

async function withKeyFile(
  contents: string | undefined,
  fn: (keyFile: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'oracle-key-'));
  try {
    const keyFile = join(dir, 'oracle.key');
    if (contents !== undefined) {
      await writeFile(keyFile, contents, 'utf8');
    }
    await fn(keyFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('knowledge group', () => {
  test('oracle_search posts the retrieval contract', async () => {
    const key = 'fixture-oracle-key';
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(RETRIEVAL_FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await withKeyFile(key, async keyFile => {
      const found = await oracleSearch(ORACLE_URL, keyFile, 'q', 3, fetchImpl);
      expect(found.results).toEqual([
        {
          doc_title: 'T',
          doc_source: 'wiki/x',
          chunk_idx: 0,
          score: 0.81,
          text: 'Dispatch is transport',
        },
      ]);
      expect(Object.keys(found.results[0] ?? {})).toEqual([
        'doc_title',
        'doc_source',
        'chunk_idx',
        'score',
        'text',
      ]);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(ORACLE_URL);
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.redirect).toBe('error');
    expect(seen[0]?.init.body).toBe('{"query":"q","top_k":3}');
    expect(new Headers(seen[0]?.init.headers).get('x-api-key')).toBe(key);
  });

  test('oracle_search refuses a missing or empty key before fetch', async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response('no', { status: 500 });
    }) as typeof fetch;
    const missing = join(tmpdir(), 'companion-mcp-missing-oracle-key');
    await expect(oracleSearch(ORACLE_URL, missing, 'q', 3, fetchImpl)).rejects.toMatchObject({
      outcome: 'refused',
      code: 'refused',
    });
    await withKeyFile('', async keyFile => {
      await expect(oracleSearch(ORACLE_URL, keyFile, 'q', 3, fetchImpl)).rejects.toMatchObject({
        outcome: 'refused',
        code: 'refused',
      });
    });
    await withKeyFile(' \n\t', async keyFile => {
      await expect(oracleSearch(ORACLE_URL, keyFile, 'q', 3, fetchImpl)).rejects.toMatchObject({
        outcome: 'refused',
        code: 'refused',
      });
    });
    expect(calls).toBe(0);
  });

  test('oracle_search does not send the key to a foreign https search URL', async () => {
    const key = 'fixture-oracle-key';
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls += 1;
      return new Response('no', { status: 500 });
    }) as typeof fetch;
    const foreign = [
      'https://attacker.example/v1/search',
      'https://oracle.bluedevilcollectibles.com.attacker.example/v1/search',
      'https://evil.oracle.bluedevilcollectibles.com/v1/search',
      'https://oracle.bluedevilcollectibles.com:8443/v1/search',
    ];
    await withKeyFile(key, async keyFile => {
      for (const url of foreign) {
        await expect(oracleSearch(url, keyFile, 'q', 3, fetchImpl)).rejects.toThrow(
          'oracle_url_refused'
        );
      }
    });
    expect(calls).toBe(0);
  });

  test('oracle_search does not leak the key from an error body', async () => {
    const key = 'oracle-key-LEAKCHECK-9f3a';
    const dir = await mkdtemp(join(tmpdir(), 'oracle-leak-'));
    const keyFile = join(dir, 'oracle.key');
    const auditLog = join(dir, 'audit.log');
    await writeFile(keyFile, `${key}\n`, 'utf8');
    const logs: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      logs.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return originalWrite(chunk);
    }) as typeof process.stderr.write;
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      logs.push(args.map(item => String(item)).join(' '));
      originalError(...args);
    };
    try {
      const fetchImpl = (async (): Promise<Response> => {
        return new Response(`down ${key}`, { status: 500 });
      }) as typeof fetch;
      const deps: ToolDeps = {
        wikiRoot: dir,
        tree: new TrackedTree(dir),
        oracleUrl: ORACLE_URL,
        oracleKeyFile: keyFile,
        fetchImpl,
        dispatch: new DispatchClient('http://127.0.0.1:9'),
        auditLog,
        env: {},
      };
      const result = await executeTool(knowledgeSlot(), 'oracle_search', { query: 'q' }, deps);
      const text = toolText(result);
      expect(result.isError).toBe(true);
      expect(text).toContain('oracle_unavailable');
      expect(text).not.toContain(key);
      const audit = await readFile(auditLog, 'utf8');
      expect(audit).toContain('oracle_unavailable');
      expect(audit).not.toContain(key);
      expect(logs.join('\n')).not.toContain(key);
    } finally {
      process.stderr.write = originalWrite;
      console.error = originalError;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('oracle_search returns an empty result list', async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ query: 'q', top_k: 5, results: [] }), { status: 200 });
    }) as typeof fetch;
    await withKeyFile('empty-results-key', async keyFile => {
      const found = await oracleSearch(ORACLE_URL, keyFile, 'q', undefined, fetchImpl);
      expect(found).toEqual({ results: [] });
    });
  });

  test('oracle_search clamps top_k, caps text, and refuses an oversized body', async () => {
    const key = 'cap-oracle-key';
    const seen: string[] = [];
    let phase: 'cap' | 'huge' = 'cap';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seen.push(String(init?.body ?? ''));
      if (phase === 'huge') {
        const padding = 'a'.repeat(300 * 1024);
        return new Response(
          JSON.stringify({
            query: 'q',
            top_k: 8,
            results: [
              {
                doc_id: 'd',
                doc_title: 'T',
                doc_source: 'wiki/x',
                chunk_id: 'c',
                chunk_idx: 0,
                text: padding,
                score: 0.2,
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          query: 'q',
          top_k: 8,
          results: [
            {
              doc_id: 'd',
              doc_title: `Title ${key}`,
              doc_source: `wiki/${key}`,
              chunk_id: 'c',
              chunk_idx: 1,
              text: `${key}${'Z'.repeat(5000)}`,
              score: 0.4,
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    await withKeyFile(key, async keyFile => {
      const found = await oracleSearch(ORACLE_URL, keyFile, 'q', 50, fetchImpl);
      expect(seen[0]).toBe('{"query":"q","top_k":8}');
      expect(found.results).toHaveLength(1);
      const hit = found.results[0];
      expect(hit?.text.length).toBeLessThanOrEqual(2000);
      expect(hit?.text).not.toContain(key);
      expect(hit?.doc_title).not.toContain(key);
      expect(hit?.doc_source).not.toContain(key);
      phase = 'huge';
      await expect(oracleSearch(ORACLE_URL, keyFile, 'q', 50, fetchImpl)).rejects.toMatchObject({
        outcome: 'error',
        code: 'oracle_unavailable',
      });
    });
  });

  test('startup refuses every oracle URL that is not retrieval search', async () => {
    const refused = [
      'https://n8n.bluedevilcollectibles.com/webhook/chatbot-query',
      'http://oracle.bluedevilcollectibles.com/v1/search',
      'https://oracle.bluedevilcollectibles.com/v1/rag',
      'https://attacker.example/v1/search',
    ];
    for (const url of refused) {
      const harness = await createHarness();
      let running: RunningCompanionServer | undefined;
      let message = '';
      try {
        running = await startFromHarness(harness, { ORACLE_URL: url });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        if (running !== undefined) {
          await running.close();
        }
        await harness.cleanup();
      }
      expect(running).toBeUndefined();
      expect(message).toBe('oracle_url_refused');
    }
    const harness = await createHarness();
    const running = await startFromHarness(harness, { ORACLE_URL });
    try {
      const health = await fetch(`${running.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await running.close();
      await harness.cleanup();
    }
  });

  test('grok-bot is granted only the knowledge tools', async () => {
    const registry = loadCompanionRegistry(EXAMPLE);
    const slot = registry.slots.find(entry => entry.companion_id === 'grok-bot');
    expect(slot?.tools).toEqual(['wiki_search', 'wiki_read', 'oracle_search']);
    if (slot === undefined) {
      throw new Error('missing grok-bot slot');
    }
    const dir = await mkdtemp(join(tmpdir(), 'grok-bot-grant-'));
    try {
      const deps: ToolDeps = {
        wikiRoot: dir,
        tree: new TrackedTree(dir),
        oracleUrl: ORACLE_URL,
        dispatch: new DispatchClient('http://127.0.0.1:9'),
        auditLog: join(dir, 'audit.log'),
        env: {},
      };
      const refused = await executeTool(
        slot,
        'mailbox_send',
        { recipient: 'xo', text: 'hello' },
        deps
      );
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toBe('{"error":"tool_not_allowed"}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('wiki_search ranks case-insensitive multi-term hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-rank-'));
    const root = join(dir, 'wiki');
    try {
      const pageA = join(root, 'xo-wiki/wiki/doctrine/a');
      const pageB = join(root, 'xo-wiki/wiki/doctrine/b');
      await mkdir(pageA, { recursive: true });
      await mkdir(pageB, { recursive: true });
      await writeFile(
        join(pageA, '_index.md'),
        [
          'Dispatch is transport; GitHub issues are the work SOR',
          'Dispatch is transport; GitHub issues are the work SOR',
          '',
        ].join('\n'),
        'utf8'
      );
      await writeFile(join(pageB, '_index.md'), 'dispatch\n', 'utf8');
      await git(root, ['init', '-b', 'main']);
      await commitAll(root, 'doctrine');
      const tree = new TrackedTree(root, 60_000);
      const hits = await searchTree(root, tree, WIKI_PREFIX, 'dispatch github issues', 20);
      expect(hits.map(hit => hit.path)).toEqual(['xo-wiki/wiki/doctrine/a/_index.md']);
      expect(JSON.stringify(hits).toLowerCase()).toContain('dispatch');
      expect(JSON.stringify(hits)).not.toContain('doctrine/b');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('wiki_read refuses escapes and untracked paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-read-'));
    const root = join(dir, 'wiki');
    const outside = 'OUTSIDE-SECRET-CONTENT';
    const hidden = 'UNTRACKED-SECRET-CONTENT';
    try {
      await mkdir(join(root, 'xo-wiki/wiki'), { recursive: true });
      await writeFile(join(root, 'xo-wiki/wiki/a.md'), 'tracked page\n', 'utf8');
      await writeFile(join(dir, 'secrets.txt'), `${outside}\n`, 'utf8');
      await git(root, ['init', '-b', 'main']);
      await commitAll(root, 'tracked');
      await writeFile(join(root, 'xo-wiki/wiki/hidden.md'), `${hidden}\n`, 'utf8');
      const tree = new TrackedTree(root, 60_000);
      await tree.refresh();
      await expect(wikiRead(root, tree, '../secrets.txt')).rejects.toMatchObject({
        code: 'path_refused',
      });
      await expect(wikiRead(root, tree, 'xo-wiki/wiki/hidden.md')).rejects.toMatchObject({
        code: 'not_tracked',
      });
      try {
        await wikiRead(root, tree, '../secrets.txt');
      } catch (error) {
        expect(String(error)).not.toContain(outside);
        expect(JSON.stringify(error)).not.toContain(outside);
      }
      try {
        await wikiRead(root, tree, 'xo-wiki/wiki/hidden.md');
      } catch (error) {
        expect(String(error)).not.toContain(hidden);
        expect(JSON.stringify(error)).not.toContain(hidden);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('wiki_search refreshes the tracked tree after a head change and a 60s gap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wiki-head-'));
    const root = join(dir, 'wiki');
    let now = 0;
    try {
      await mkdir(join(root, 'xo-wiki/wiki'), { recursive: true });
      await writeFile(join(root, 'xo-wiki/wiki/old.md'), 'old-marker\n', 'utf8');
      await git(root, ['init', '-b', 'main']);
      await commitAll(root, 'old');
      const tree = new TrackedTree(root, 10 * 60 * 1000, () => now);
      const before = await searchTree(root, tree, WIKI_PREFIX, 'new-marker', 20);
      expect(before).toEqual([]);
      await writeFile(join(root, 'xo-wiki/wiki/new.md'), 'new-marker\n', 'utf8');
      await commitAll(root, 'new');
      now = 30_000;
      const early = await searchTree(root, tree, WIKI_PREFIX, 'new-marker', 20);
      expect(early).toEqual([]);
      now = 61_000;
      const later = await searchTree(root, tree, WIKI_PREFIX, 'new-marker', 20);
      expect(later.map(hit => hit.path)).toEqual(['xo-wiki/wiki/new.md']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // POSIX-only: spawns wiki-sync.sh directly and joins PATH with ':'. Skip on win32 only.
  const SKIP_ON_WINDOWS = process.platform === 'win32';

  test.skipIf(SKIP_ON_WINDOWS)('wiki-sync is idempotent and does not leak the token', async () => {
    const token = 'bdc-wiki-sync-token-7f3c9a';
    const dir = await mkdtemp(join(tmpdir(), 'wiki-sync-'));
    const origin = join(dir, 'origin.git');
    const checkout = join(dir, 'checkout');
    const tokenFile = join(dir, 'token');
    const argvLog = join(dir, 'git-argv');
    const binDir = join(dir, 'bin');
    const realGit = Bun.which('git');
    if (realGit === null) {
      throw new Error('git missing');
    }
    try {
      await writeFile(tokenFile, `${token}\n`, 'utf8');
      await writeFile(argvLog, '', 'utf8');
      await mkdir(binDir, { recursive: true });
      await mkdir(origin, { recursive: true });
      const stub = [
        '#!/bin/sh',
        'printf "%s\\n" "$0" >> "$GIT_ARGV_LOG"',
        'for arg in "$@"; do',
        '  printf "%s\\n" "$arg" >> "$GIT_ARGV_LOG"',
        'done',
        'printf "\\n" >> "$GIT_ARGV_LOG"',
        'export PATH="$ORIGINAL_PATH"',
        'exec "$REAL_GIT" "$@"',
        '',
      ].join('\n');
      await writeFile(join(binDir, 'git'), stub, { mode: 0o755 });
      await git(origin, ['init', '--bare', '-b', 'main']);
      await mkdir(join(checkout, 'xo-wiki/wiki'), { recursive: true });
      await writeFile(join(checkout, 'xo-wiki/wiki/page.md'), 'one\n', 'utf8');
      await git(checkout, ['init', '-b', 'main']);
      await commitAll(checkout, 'one');
      await git(checkout, ['remote', 'add', 'origin', origin]);
      await git(checkout, ['push', '-u', 'origin', 'main']);
      await writeFile(join(checkout, 'xo-wiki/wiki/page.md'), 'two\n', 'utf8');
      await commitAll(checkout, 'two');
      await git(checkout, ['push', 'origin', 'main']);
      await git(checkout, ['reset', '--hard', 'HEAD~1']);
      const env = gitEnv();
      env.PATH = `${binDir}:${env.PATH ?? ''}`;
      env.ORIGINAL_PATH = gitEnv().PATH ?? '';
      env.REAL_GIT = realGit;
      env.GIT_ARGV_LOG = argvLog;
      async function runSync(args: string[]): Promise<{ code: number; output: string }> {
        const proc = Bun.spawn([WIKI_SYNC, ...args], {
          stdout: 'pipe',
          stderr: 'pipe',
          env,
        });
        const [code, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { code, output: `${stdout}${stderr}` };
      }
      const usage = await runSync([]);
      expect(usage.code).toBe(2);
      expect(usage.output).toContain('usage: wiki-sync.sh');
      expect(usage.output).not.toContain(token);
      const first = await runSync([checkout, tokenFile]);
      expect(first.code).toBe(0);
      expect(first.output).not.toContain(token);
      const originHead = (await git(origin, ['rev-parse', 'HEAD'])).trim();
      const headAfterFirst = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
      expect(headAfterFirst).toBe(originHead);
      const second = await runSync([checkout, tokenFile]);
      expect(second.code).toBe(0);
      expect(second.output).not.toContain(token);
      const headAfterSecond = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
      expect(headAfterSecond).toBe(headAfterFirst);
      expect(headAfterSecond).toBe((await git(checkout, ['rev-parse', 'origin/main'])).trim());
      const argv = await readFile(argvLog, 'utf8');
      expect(argv).not.toContain(token);
      expect(argv).toContain('fetch');
      expect(argv).toContain('reset');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
