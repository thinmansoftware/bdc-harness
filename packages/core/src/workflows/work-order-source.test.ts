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

  describe('rework directive (WO-HARNESS-OVERSEER-REWORK-LOOP-01)', () => {
    const reworkRef = {
      prNumber: 936,
      branch: 'feat/wo-harness-overseer-rework-loop-01-thread-abc123',
      headSha: 'c'.repeat(40),
      reviewMessageId: 'review-msg-1',
    };
    const reworkToken = Buffer.from(JSON.stringify(reworkRef)).toString('base64url');
    const reworkMessage = (): string =>
      `WO_ID=WO-TEST-01 --project bdc-harness --rework=${reworkToken}`;
    const verifiedReviewRow = {
      id: 'review-msg-1',
      task_type: 'run_review' as const,
      recipient: 'overseer-reviewer',
      subject_key: 'gh:thinmansoftware/bdc-harness#936',
      body: JSON.stringify({ headSha: reworkRef.headSha }),
      result_body: JSON.stringify({
        disposition: 'changes_requested',
        summary: '[major] pr-rework.ts: missing coverage.',
      }),
      correlation_id: 'corr-1',
      idempotency_key: 'idem-1',
      sender: 'overseer',
      sender_principal_id: null,
      status: 'done' as const,
      created_at: '2026-09-24T00:00:00.000Z',
      claimed_at: null,
      completed_at: null,
      not_before: null,
      lease_owner: null,
      lease_expires_at: null,
      fencing_token: 0,
      recipient_alias: null,
      motion_id: null,
      motion_revision_sha: null,
      resolved_recipient: null,
      resolved_xo_lease_id: null,
      resolved_xo_fencing_token: null,
      resolved_at: null,
      priority: 'normal' as const,
      task_outcome: null,
      acknowledged_at: null,
      acknowledged_by: null,
      addressed_at: null,
      addressed_by: null,
      escalated_tg_at: null,
      escalated_sms_at: null,
      route_disposition: null,
      supersedes_id: null,
      repeat_reason: null,
    };

    // Test 13: a verified rework directive appends a deterministic block to
    // the canonical spec bytes, forcing the lane's gate-already-satisfied node
    // (Stop 5) to see REWORK_DIRECTIVE and reads back the Overseer's findings.
    it('appends the rework directive to the canonical spec bytes when the review message verifies', async () => {
      const frozen = await freezeWorkOrderSource(policy, reworkMessage(), {
        fetcher: canonicalFetch,
        loadReviewMessage: async id => {
          expect(id).toBe('review-msg-1');
          return verifiedReviewRow;
        },
      });
      const text = Buffer.from(frozen.specBytes).toString('utf8');
      expect(text.startsWith(bytes)).toBe(true);
      expect(text).toContain('REWORK_DIRECTIVE: overseer-changes-requested');
      expect(text).toContain(`Repair target: PR #936 (branch ${reworkRef.branch})`);
      expect(text).toContain(`Rework head: ${reworkRef.headSha}`);
      expect(text).toContain('Review message: review-msg-1');
      expect(text).toContain('[major] pr-rework.ts: missing coverage.');
    });

    // Test 14: a mismatched review row (wrong head, wrong disposition, wrong
    // subject, wrong task_type/recipient, or missing) is rejected rather than
    // silently trusted -- the directive's authority comes from the verified
    // review row, not from the caller-supplied ref alone.
    it('rejects a rework directive whose review message does not verify', async () => {
      const cases: Array<[string, unknown]> = [
        ['missing review row', null],
        [
          'wrong head sha',
          { ...verifiedReviewRow, body: JSON.stringify({ headSha: 'd'.repeat(40) }) },
        ],
        [
          'non-changes_requested disposition',
          {
            ...verifiedReviewRow,
            result_body: JSON.stringify({ disposition: 'approved', summary: 'ok' }),
          },
        ],
        [
          'wrong subject key (different PR)',
          { ...verifiedReviewRow, subject_key: 'gh:thinmansoftware/bdc-harness#914' },
        ],
        ['wrong task_type', { ...verifiedReviewRow, task_type: 'agent_message' }],
        ['wrong recipient', { ...verifiedReviewRow, recipient: 'operator' }],
        ['unparseable result_body', { ...verifiedReviewRow, result_body: 'not json' }],
      ];
      for (const [, row] of cases) {
        await expect(
          freezeWorkOrderSource(policy, reworkMessage(), {
            fetcher: canonicalFetch,
            loadReviewMessage: async () => row as never,
          })
        ).rejects.toThrow('authority_conflict');
      }
    });

    it('rejects a malformed --rework token instead of silently dispatching unbound', async () => {
      await expect(
        freezeWorkOrderSource(
          policy,
          'WO_ID=WO-TEST-01 --project bdc-harness --rework=not-a-real-token',
          { fetcher: canonicalFetch }
        )
      ).rejects.toThrow('authority_conflict');
    });

    // Test 15: with no --rework flag present, behavior is byte-identical to
    // every pre-existing test above -- the directive path must never fire on
    // an ordinary fire, and freezeWorkOrderSource's existing contract (Tests
    // 1-12 in this file) must not regress.
    it('leaves the frozen spec byte-identical to the no-directive case when no --rework flag is present', async () => {
      const withoutDirective = await freezeWorkOrderSource(
        policy,
        'WO_ID=WO-TEST-01 --project bdc-harness',
        {
          fetcher: canonicalFetch,
        }
      );
      expect(Buffer.from(withoutDirective.specBytes).toString('utf8')).toBe(bytes);
      expect(withoutDirective.specSource).toBe(identity.specSource);
    });
  });
});
