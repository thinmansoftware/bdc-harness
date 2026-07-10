import { describe, expect, it } from 'bun:test';

import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import { freezeWorkOrderSource } from './work-order-source';

const policy: RunAuthorityPolicy = {
  required: true,
  spec_repository: 'bluedevilcollectibles/bdc-xo',
  spec_revision: 'main',
  spec_paths: ['docs/work-orders/{WO_ID}.md', 'docs/superpowers/specs/{WO_ID}.md'],
};

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('freezeWorkOrderSource', () => {
  it('resolves a branch once and fetches exact bytes at that immutable revision', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/git/ref/heads/main')) {
        return response(200, { object: { sha: 'a'.repeat(40) } });
      }
      if (url.includes('docs/work-orders/WO-TEST-01.md')) {
        return response(200, {
          type: 'file',
          content: Buffer.from('# Exact\r\n', 'utf8').toString('base64'),
        });
      }
      return response(404, { message: 'not found' });
    };

    const frozen = await freezeWorkOrderSource(policy, 'run WO-TEST-01', {
      fetcher,
      githubToken: 'test-token',
    });

    expect(frozen.specRevision).toBe('a'.repeat(40));
    expect(frozen.specBytes).toEqual(Buffer.from('# Exact\r\n', 'utf8'));
    expect(frozen.specSource).toEndWith('docs/work-orders/WO-TEST-01.md');
    expect(calls[1]).toContain(`ref=${'a'.repeat(40)}`);
  });

  it('fails closed when the WO id, revision, or canonical spec is unavailable', async () => {
    await expect(freezeWorkOrderSource(policy, 'no work order here')).rejects.toThrow(
      'scope_authority_missing: woId'
    );

    const noRevision: typeof fetch = async () => response(404, { message: 'not found' });
    await expect(
      freezeWorkOrderSource(policy, 'WO-TEST-01', { fetcher: noRevision })
    ).rejects.toThrow('scope_authority_missing: specRevision');

    const noSpec: typeof fetch = async input =>
      String(input).endsWith('/git/ref/heads/main')
        ? response(200, { object: { sha: 'b'.repeat(40) } })
        : response(404, { message: 'not found' });
    await expect(freezeWorkOrderSource(policy, 'WO-TEST-01', { fetcher: noSpec })).rejects.toThrow(
      'scope_authority_missing: canonical spec'
    );
  });

  it('does not silently use an issue fallback', async () => {
    await expect(
      freezeWorkOrderSource({ ...policy, allow_issue_fallback: true }, 'WO-TEST-01')
    ).rejects.toThrow('issue fallback is not implemented');
  });
});
