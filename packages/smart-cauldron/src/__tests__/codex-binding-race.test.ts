import {
  matchesCodexOnlyBinding,
  workflowDigest,
} from '../../../workflows/src/reliability/codex-only-binding.js';
import { describe, expect, test } from 'bun:test';
import { preflightCodexOnly, fireTier } from '../fire.js';

describe('Codex-only preflight/dispatch race', () => {
  for (const mutation of ['registration', 'workflow']) {
    test(`${mutation} change refuses before POST`, async () => {
      const original = globalThis.fetch;
      let changed = false;
      let posts = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts++;
          return Response.json({ dispatched: false });
        }
        if (String(input).endsWith('/api/codebases'))
          return Response.json([
            {
              id: changed && mutation === 'registration' ? 'changed' : 'target',
              name: 'harness',
              default_cwd: '/work/harness',
            },
          ]);
        return Response.json({
          filename: 'bdc-feature-development-codex-only.yaml',
          source: 'bundled',
          workflow: {
            name: 'bdc-feature-development-codex-only',
            description: changed && mutation === 'workflow' ? 'changed' : 'original',
            provider: 'codex',
            nodes: [{ id: 'implement', prompt: 'test' }],
          },
        });
      }) as typeof fetch;
      try {
        const validatedBinding = await preflightCodexOnly('harness', 'http://test', 'token');
        changed = true;
        const result = await fireTier({
          project: 'harness',
          woId: 'WO-TEST',
          workflowName: 'bdc-feature-development-codex-only',
          message: 'WO_ID=WO-TEST --project harness',
          apiBaseUrl: 'http://test',
          token: 'token',
          validatedBinding,
        });
        expect(result.ok).toBe(false);
        expect(result.infraError).toContain('codex_only_binding_changed');
        expect(posts).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    });
  }
});

describe('loaded dispatch definition binding', () => {
  const workflow = { name: 'bdc-feature-development-codex-only', provider: 'codex' };
  const binding = {
    project: 'harness',
    codebaseId: 'target',
    cwd: '/work/harness',
    workflowDigest: workflowDigest(workflow),
  };
  test('unchanged loaded definition matches', () =>
    expect(
      matchesCodexOnlyBinding(binding, { codebaseId: 'target', cwd: '/work/harness', workflow })
    ).toBe(true));
  test('changed loaded registration refuses', () =>
    expect(
      matchesCodexOnlyBinding(binding, { codebaseId: 'other', cwd: '/work/harness', workflow })
    ).toBe(false));
  test('changed loaded provider refuses', () =>
    expect(
      matchesCodexOnlyBinding(binding, {
        codebaseId: 'target',
        cwd: '/work/harness',
        workflow: { ...workflow, provider: 'cursor' },
      })
    ).toBe(false));
});
test('uses one injected transport for preflight, revalidation, POST and discovery', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('global transport forbidden');
  }) as typeof fetch;
  const calls: string[] = [];
  const transport = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/api/codebases'))
      return Response.json([{ id: 'target', name: 'harness', default_cwd: '/work/harness' }]);
    if (url.includes('/api/workflows/runs?'))
      return Response.json({
        runs: [
          {
            id: 'run',
            workflow_name: 'bdc-feature-development-codex-only',
            parent_conversation_id: 'parent',
            codebase_id: 'target',
          },
        ],
      });
    if (init?.method === 'POST')
      return Response.json({ dispatched: true, conversationId: 'conversation', id: 'parent' });
    return Response.json({
      filename: 'bdc-feature-development-codex-only.yaml',
      source: 'bundled',
      workflow: {
        name: 'bdc-feature-development-codex-only',
        description: 'test',
        provider: 'codex',
        nodes: [{ id: 'work', prompt: 'test' }],
      },
    });
  }) as typeof fetch;
  try {
    const binding = await preflightCodexOnly('harness', 'http://test', 'token', transport);
    const result = await fireTier({
      project: 'harness',
      woId: 'WO-TEST',
      workflowName: 'bdc-feature-development-codex-only',
      message: 'WO_ID=WO-TEST --project harness',
      apiBaseUrl: 'http://test',
      token: 'token',
      validatedBinding: binding,
      fetchImpl: transport,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      'GET http://test/api/codebases',
      'GET http://test/api/workflows/bdc-feature-development-codex-only?cwd=%2Fwork%2Fharness',
      'GET http://test/api/codebases',
      'GET http://test/api/workflows/bdc-feature-development-codex-only?cwd=%2Fwork%2Fharness',
      'POST http://test/api/conversations',
      'GET http://test/api/workflows/runs?codebaseId=target&limit=50',
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
