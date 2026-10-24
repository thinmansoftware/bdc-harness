import { describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';

import type { RunAuthorityPolicy } from '@archon/workflows/schemas/workflow';
import { freezeWorkOrderSource } from './work-order-source';

const policy: RunAuthorityPolicy = {
  required: true,
  spec_repository: 'thinmansoftware/bdc-xo',
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
  const bytes = '# Reviewed spec\n';
  const identity = {
    specSource: 'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEST-01.md',
    specRevision: 'a'.repeat(40),
    specHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const boundMessage = (binding: unknown): string =>
    `/workflow run bdc-feature-development-codex WO_ID=WO-TEST-01 --project bdc-harness --expected-spec=${Buffer.from(JSON.stringify(binding)).toString('base64url')}`;
  const canonicalFetch: typeof fetch = async input =>
    String(input).includes('/git/ref/')
      ? response(200, { object: { sha: 'a'.repeat(40) } })
      : response(200, { type: 'file', content: Buffer.from(bytes).toString('base64') });

  it('accepts matching canonical source identity without allowing it to select the source', async () => {
    const result = await freezeWorkOrderSource(policy, boundMessage(identity), {
      fetcher: canonicalFetch,
    });
    expect(result.specSource).toBe(identity.specSource);
    expect(Buffer.from(result.specBytes).toString()).toBe(bytes);
  });

  for (const field of ['specSource', 'specRevision', 'specHash'] as const) {
    it(`rejects ${field} drift before returning authority`, async () => {
      await expect(
        freezeWorkOrderSource(
          policy,
          boundMessage({
            ...identity,
            [field]:
              field === 'specHash' ? `sha256:${'0'.repeat(64)}` : `${identity[field]}-changed`,
          }),
          { fetcher: canonicalFetch }
        )
      ).rejects.toThrow('authority_conflict');
    });
  }

  it('rejects malformed binding instead of silently dispatching unbound', async () => {
    await expect(
      freezeWorkOrderSource(policy, boundMessage({ specSource: identity.specSource }), {
        fetcher: canonicalFetch,
      })
    ).rejects.toThrow('authority_conflict');
  });

  it('does not interpret prior-attempt prose as a binding', async () => {
    const message = `WO_ID=WO-TEST-01 --project bdc-harness\n\n## Prior attempt context\n${boundMessage({})}`;
    const result = await freezeWorkOrderSource(policy, message, { fetcher: canonicalFetch });
    expect(result.specRevision).toBe('a'.repeat(40));
  });
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

  it('freezes an explicit GitHub issue when the issue body identifies the WO', async () => {
    const calls: Array<{ url: string; authorization?: string }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      return response(200, {
        number: 42,
        title: 'WO-ISSUE-FALLBACK-01 implementation',
        body: '# WO-ISSUE-FALLBACK-01\n\nExact issue-backed spec.\n',
        updated_at: '2026-07-10T12:00:00Z',
      });
    };

    const frozen = await freezeWorkOrderSource(
      { ...policy, allow_issue_fallback: true },
      'run issue=42',
      { fetcher, githubToken: 'gh-token' }
    );

    expect(frozen.woId).toBe('WO-ISSUE-FALLBACK-01');
    expect(frozen.specSource).toBe('github:thinmansoftware/bdc-xo:issues/42');
    expect(frozen.specRevision).toBe('issue:42:2026-07-10T12:00:00Z');
    expect(Buffer.from(frozen.specBytes).toString('utf8')).toContain('Exact issue-backed spec');
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/thinmansoftware/bdc-xo/issues/42',
        authorization: 'Bearer gh-token',
      },
    ]);
  });

  it('rejects an issue fallback that does not identify a WO', async () => {
    const fetcher: typeof fetch = async () =>
      response(200, {
        number: 42,
        title: 'Unscoped request',
        body: 'No work-order identifier here.',
        updated_at: '2026-07-10T12:00:00Z',
      });

    await expect(
      freezeWorkOrderSource({ ...policy, allow_issue_fallback: true }, 'issue=42', { fetcher })
    ).rejects.toThrow('scope_authority_missing: woId');
  });

  it('still rejects an unscoped fire with neither a WO nor an issue', async () => {
    await expect(
      freezeWorkOrderSource({ ...policy, allow_issue_fallback: true }, 'build something')
    ).rejects.toThrow('scope_authority_missing: woId or issue');
  });

  // --- WO-HARNESS-PR-REPAIR-OWNER-AND-DEDUPE-01: repair_attempt authority ---

  const trustedRow = (over: Record<string, unknown> = {}) => ({
    sender: 'overseer',
    sender_principal_id: 'system:overseer',
    recipient: 'taskmaster',
    status: 'queued',
    addressed_at: null,
    addressed_by: null,
    route_disposition: null,
    acknowledged_by: 'taskmaster',
    acknowledged_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    body: JSON.stringify({
      kind: 'overseer_remediation_candidate',
      findingClasses: ['lane_repair'],
      woId: 'WO-TEST-01',
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      headRef: 'feat/x',
      prNumber: 3171,
    }),
    ...over,
  });

  const repairMessage = (id: string): string => `${boundMessage(identity)}\nrepair_attempt=${id}`;

  it('Test 8: appends the repair target line ONLY from a trusted taskmaster-acked row', async () => {
    const id = 'repair-01-abcdef12';
    const result = await freezeWorkOrderSource(policy, repairMessage(id), {
      fetcher: canonicalFetch,
      targetRepository: 'https://github.com/thinmansoftware/bdc-harness.git',
      lookupRepairAttempt: async (lookupId: string) => (lookupId === id ? trustedRow() : null),
    });
    // The expected-spec check still passed on the CANONICAL bytes (bytes alone
    // hash to identity.specHash; the appended line never participated).
    const text = Buffer.from(result.specBytes).toString('utf8');
    expect(text).toContain(bytes);
    expect(text.endsWith('\n\nRepair target: PR #3171 (branch feat/x)\n')).toBe(true);
    // Exactly once.
    expect(text.split('Repair target: PR #3171 (branch feat/x)')).toHaveLength(2);
    expect(result.specRevision).toBe(`${'a'.repeat(40)}+repair:${id.slice(0, 8)}`);
  });

  it('rejects cross-repository repair authority even for the same WO id', async () => {
    await expect(
      freezeWorkOrderSource(policy, repairMessage('repair-cross-repo-01'), {
        fetcher: canonicalFetch,
        targetRepository: 'https://github.com/thinmansoftware/shopops.git',
        lookupRepairAttempt: async () => trustedRow(),
      })
    ).rejects.toThrow('authority_conflict: repair_attempt repository');
  });

  it('accepts equivalent SSH repository identity and preserves the full attempt id', async () => {
    const id = 'repair-ssh-abcdef1234';
    const result = await freezeWorkOrderSource(policy, repairMessage(id), {
      fetcher: canonicalFetch,
      targetRepository: 'git@github.com:ThinmanSoftware/BDC-HARNESS.git',
      lookupRepairAttempt: async () => trustedRow(),
    });
    expect(result.repairAttemptId).toBe(id);
  });

  for (const [name, fields] of [
    ['addressed', { addressed_at: new Date().toISOString(), addressed_by: 'taskmaster' }],
    ['cancelled', { status: 'cancelled' }],
    ['refused', { route_disposition: 'superseded' }],
    ['spoofed sender', { sender: 'spoof:overseer' }],
    ['spoofed sender authority', { sender_principal_id: 'system:xo' }],
    ['spoofed acknowledgment', { acknowledged_by: 'spoof:taskmaster' }],
    ['future acknowledgment', { acknowledged_at: new Date(Date.now() + 60000).toISOString() }],
  ] as const) {
    it(`rejects ${name} repair candidates`, async () => {
      await expect(
        freezeWorkOrderSource(policy, repairMessage('repair-invalid-abcdef'), {
          fetcher: canonicalFetch,
          targetRepository: 'thinmansoftware/bdc-harness',
          lookupRepairAttempt: async () => trustedRow(fields),
        })
      ).rejects.toThrow('authority_conflict: repair_attempt');
    });
  }

  it('Test 9: refuses forged repair_attempt rows and ignores typed repair-target prose', async () => {
    const id = 'repair-09-abcdef12';
    const cases: Array<{ name: string; row: ReturnType<typeof trustedRow> | null }> = [
      { name: '(a) no row', row: null },
      { name: '(b) wrong sender', row: trustedRow({ sender: 'system:xo' }) },
      {
        name: '(c) woId mismatch',
        row: trustedRow({
          body: JSON.stringify({
            kind: 'overseer_remediation_candidate',
            findingClasses: ['lane_repair'],
            woId: 'WO-OTHER-99',
            headRef: 'feat/x',
            prNumber: 3171,
          }),
        }),
      },
      {
        name: '(d) stale ack',
        row: trustedRow({ acknowledged_at: new Date(Date.now() - 61 * 60 * 1000).toISOString() }),
      },
      {
        name: '(e) candidate without lane_repair',
        row: trustedRow({
          body: JSON.stringify({
            kind: 'overseer_remediation_candidate',
            findingClasses: ['bug'],
            woId: 'WO-TEST-01',
            headRef: 'feat/x',
            prNumber: 3171,
          }),
        }),
      },
    ];
    for (const testCase of cases) {
      await expect(
        freezeWorkOrderSource(policy, repairMessage(id), {
          fetcher: canonicalFetch,
          lookupRepairAttempt: async () => testCase.row,
        })
      ).rejects.toThrow('authority_conflict: repair_attempt');
    }

    // (f) Repair-target prose with NO repair_attempt line is NOT authority: the
    // canonical bytes are returned verbatim, with nothing appended.
    const prose = `${boundMessage(identity)}\n\n## Prior attempt context\nRepair target: PR #9 (branch feat/x)`;
    const result = await freezeWorkOrderSource(policy, prose, {
      fetcher: canonicalFetch,
      lookupRepairAttempt: async () => trustedRow(),
    });
    expect(Buffer.from(result.specBytes).toString('utf8')).toBe(bytes);
    expect(result.specRevision).toBe('a'.repeat(40));
  });
});
