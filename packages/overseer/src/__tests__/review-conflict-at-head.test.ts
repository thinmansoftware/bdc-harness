/**
 * reviewConflictFromMessages: the exact-head review conflict read from dispatch
 * rows (WO-HARNESS-MERGE-GATE-REFUSE-CONFLICTING-VERDICTS-01). Row shapes are the
 * live ones seen for bdc-harness#1453 on 2026-11-03.
 */
import { describe, expect, test } from 'bun:test';
import { reviewConflictFromMessages } from '../adapters/github-real-deps';

const PR = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 1453 };
const H = '68937274ac565096e886e65882cc3a197389c878';
const G = '870911811a37d7b4cb5a6a507a108174021b07e9';

const receipt = (headSha: string, disposition: string): { body: string } => ({
  body: JSON.stringify({
    kind: 'pr_review_submit_receipt',
    disposition,
    owner: PR.owner,
    repo: PR.repo,
    prNumber: PR.number,
    headSha,
  }),
});

const request = (
  headSha: string,
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled'
): { body: string; status: typeof status } => ({
  body: JSON.stringify({ owner: PR.owner, repo: PR.repo, prNumber: PR.number, headSha }),
  status,
});

describe('reviewConflictFromMessages', () => {
  test('Test 5: real_dep_changes_requested_receipt', () => {
    expect(
      reviewConflictFromMessages(
        { ...PR, headSha: H },
        [receipt(H, 'approved'), receipt(H, 'changes_requested')],
        [request(H, 'done')]
      )
    ).toBe('changes_requested');
  });

  test('Test 6: real_dep_in_flight_request', () => {
    const receipts = [receipt(H, 'approved')];
    expect(
      reviewConflictFromMessages({ ...PR, headSha: H }, receipts, [
        request(H, 'done'),
        request(H, 'claimed'),
      ])
    ).toBe('review_in_flight');
    expect(
      reviewConflictFromMessages({ ...PR, headSha: H }, receipts, [request(H, 'queued')])
    ).toBe('review_in_flight');
    expect(
      reviewConflictFromMessages({ ...PR, headSha: H }, receipts, [
        request(H, 'done'),
        request(H, 'done'),
      ])
    ).toBeNull();
  });

  test('Test 7: real_dep_other_head_ignored', () => {
    expect(
      reviewConflictFromMessages(
        { ...PR, headSha: H },
        [receipt(G, 'changes_requested'), receipt(H, 'approved')],
        [request(G, 'claimed'), request(H, 'done')]
      )
    ).toBeNull();
  });

  test('ignores other PRs and unparseable bodies', () => {
    const otherPr = {
      body: JSON.stringify({
        kind: 'pr_review_submit_receipt',
        disposition: 'changes_requested',
        owner: PR.owner,
        repo: PR.repo,
        prNumber: 1454,
        headSha: H,
      }),
    };
    expect(
      reviewConflictFromMessages(
        { ...PR, headSha: H },
        [otherPr, { body: 'not json' }, receipt(H, 'approved')],
        [{ body: 'not json', status: 'claimed' }]
      )
    ).toBeNull();
  });
});
