import { describe, expect, mock, test } from 'bun:test';
import {
  freezeCanonicalBoardMotion,
  parseCanonicalBoardApproval,
  type FrozenCanonicalBoardMotion,
} from './canonical-board-source';

const TARGET_SHA = '0123456789abcdef0123456789abcdef01234567';

function motionWithApproval(extra = ''): string {
  return `# Motion

\`\`\`board-approval-v1
{
  "motion_id": "M-20260712-27",
  "action": "approve_production",
  "environment": "production",
  "target_sha": "${TARGET_SHA}",
  "approvals": [
    {
      "principal_id": "xo-model",
      "seat_id": "xo",
      "role": "acting_xo",
      "approved": true
    },
    {
      "principal_id": "john-ranson",
      "seat_id": "john",
      "role": "second_seat",
      "approved": true
    }
  ],
  "john_authorization": {
    "principal_id": "john-ranson",
    "environment": "production",
    "target_sha": "${TARGET_SHA}",
    "authorized": true
  }${extra}
}
\`\`\`
`;
}

function frozen(text: string): FrozenCanonicalBoardMotion {
  return {
    repository: 'thinmansoftware/bdc-xo',
    path: 'docs/board/motions/M-20260712-27-dispatch-board-motion-and-execution-claim.md',
    commit_sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    blob_sha: 'blob-sha',
    bytes: Buffer.from(text, 'utf8'),
  };
}

describe('canonical board source', () => {
  test('freezes canonical motion at bdc-xo main commit and blob sha', async () => {
    const fetcher = mock(async (url: string) => {
      if (url.includes('/git/ref/heads/main')) {
        return Response.json({ object: { sha: 'commit-sha' } });
      }
      if (url.includes('/contents/docs/board/motions/')) {
        return Response.json({
          type: 'file',
          sha: 'blob-sha',
          content: Buffer.from('motion bytes', 'utf8').toString('base64'),
        });
      }
      return new Response('', { status: 404 });
    });

    const result = await freezeCanonicalBoardMotion(
      'docs/board/motions/M-20260712-27-dispatch-board-motion-and-execution-claim.md',
      { fetcher }
    );

    expect(result.commit_sha).toBe('commit-sha');
    expect(result.blob_sha).toBe('blob-sha');
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('motion bytes');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('freeze fails closed for missing auth, unavailable ref, and noncanonical path', async () => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    const previousGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    await expect(
      freezeCanonicalBoardMotion(
        'docs/board/motions/M-20260712-27-dispatch-board-motion-and-execution-claim.md'
      )
    ).rejects.toThrow('GitHub authentication');
    if (previousGithubToken) process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousGhToken) process.env.GH_TOKEN = previousGhToken;

    await expect(
      freezeCanonicalBoardMotion('README.md', { fetcher: mock(async () => Response.json({})) })
    ).rejects.toThrow('noncanonical motion path');

    await expect(
      freezeCanonicalBoardMotion(
        'docs/board/motions/M-20260712-27-dispatch-board-motion-and-execution-claim.md',
        { fetcher: mock(async () => new Response('', { status: 404 })) }
      )
    ).rejects.toThrow('canonical ref');
  });

  test('parses strict approval success with motion blob sha', () => {
    const result = parseCanonicalBoardApproval(frozen(motionWithApproval()));
    expect(result).toEqual({
      motion_id: 'M-20260712-27',
      environment: 'production',
      target_sha: TARGET_SHA,
      motion_blob_sha: 'blob-sha',
      acting_xo_principal_id: 'xo-model',
      second_seat_principal_id: 'john-ranson',
      john_principal_id: 'john-ranson',
    });
  });

  test('approval fails closed for unknown fields, duplicate principal, and mismatched John authorization', () => {
    expect(() =>
      parseCanonicalBoardApproval(frozen(motionWithApproval(', "unknown": true')))
    ).toThrow('canonical_approval_rejected');

    const duplicatePrincipal = motionWithApproval().replace('"john-ranson"', '"xo-model"');
    expect(() => parseCanonicalBoardApproval(frozen(duplicatePrincipal))).toThrow(
      'canonical_approval_rejected'
    );

    const mismatchedTarget = motionWithApproval().replace(
      `"target_sha": "${TARGET_SHA}",\n    "authorized"`,
      '"target_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n    "authorized"'
    );
    expect(() => parseCanonicalBoardApproval(frozen(mismatchedTarget))).toThrow(
      'canonical_approval_rejected'
    );
  });

  test('approval fails closed when no-staging exception lacks rollback evidence', () => {
    const text = motionWithApproval().replace(
      `"target_sha": "${TARGET_SHA}",`,
      `"target_sha": "${TARGET_SHA}",\n  "no_staging_exception": true,`
    );
    expect(() => parseCanonicalBoardApproval(frozen(text))).toThrow('canonical_approval_rejected');
  });
});
