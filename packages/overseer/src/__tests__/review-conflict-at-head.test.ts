/**
 * reviewConflictFromMessages: the exact-head review conflict read from dispatch
 * rows (WO-HARNESS-MERGE-GATE-REFUSE-CONFLICTING-VERDICTS-01). Row shapes are the
 * live ones seen for bdc-harness#1453 on 2026-11-03.
 */
import { describe, expect, test } from 'bun:test';
import { loadReviewConflictAtHead, reviewConflictFromMessages } from '../adapters/github-real-deps';

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

const noLegacy = async (): Promise<{ body: string; status: 'done' }[]> => [];

// Subject-keyed reads: requests and receipts for head H, none conflicting.
const cleanList = async (filters: { recipient: string }) =>
  filters.recipient === 'overseer-reviewer'
    ? [request(H, 'done')]
    : filters.recipient === 'operator'
      ? []
      : [{ ...receipt(H, 'approved'), status: 'done' as const }];

describe('legacy receipts without subject_key (WO-HARNESS-MERGE-GATE-LEGACY-RECEIPT-READ-01)', () => {
  test('Test 1: legacy_changes_requested_blocks', async () => {
    const prefixes: string[] = [];
    const legacy = async (filters: { recipient: string; correlationPrefix: string }) => {
      prefixes.push(filters.correlationPrefix);
      return filters.recipient === 'operator'
        ? [{ ...receipt(H, 'changes_requested'), status: 'done' as const }]
        : [];
    };
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, cleanList, legacy)).toBe(
      'changes_requested'
    );
    // Scoped to this exact head, from both receipt recipients.
    expect(prefixes).toEqual([
      `pr-review:${PR.owner}/${PR.repo}#${PR.number}@${H}`,
      `pr-review:${PR.owner}/${PR.repo}#${PR.number}@${H}`,
    ]);
  });

  test('Test 2: legacy_other_head_ignored', async () => {
    const legacy = async () => [{ ...receipt(G, 'changes_requested'), status: 'done' as const }];
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, cleanList, legacy)).toBeNull();
  });

  test('Test 3: capped_legacy_read_fails_closed', async () => {
    const full = Array.from({ length: 500 }, () => ({
      ...receipt(H, 'approved'),
      status: 'done' as const,
    }));
    const legacy = async (filters: { recipient: string }) =>
      filters.recipient === 'operator' ? full : [];
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, cleanList, legacy)).toBe(
      'lookup_failed'
    );
  });

  test('a failing legacy read fails closed', async () => {
    const legacy = async (): Promise<never> => {
      throw new Error('db down');
    };
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, cleanList, legacy)).toBe(
      'lookup_failed'
    );
  });

  test('no legacy rows and a clean subject-keyed history is not a conflict', async () => {
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, cleanList, noLegacy)).toBeNull();
  });
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

  test('a read at its page cap fails closed unless a conflict is already visible', () => {
    const clean = [receipt(H, 'approved')];
    expect(
      reviewConflictFromMessages({ ...PR, headSha: H }, clean, [request(H, 'done')], {
        truncated: true,
      })
    ).toBe('lookup_failed');
    expect(
      reviewConflictFromMessages(
        { ...PR, headSha: H },
        [...clean, receipt(H, 'changes_requested')],
        [],
        { truncated: true }
      )
    ).toBe('changes_requested');
  });

  test('a review that finishes between the reads is still caught (requests read first)', async () => {
    // Before the first read the review is running with no receipt; right after
    // the first read it writes changes_requested and its request becomes done.
    let reads = 0;
    let finished = false;
    const order: string[] = [];
    const list = async (filters: { recipient: string }) => {
      order.push(filters.recipient);
      const rows =
        filters.recipient === 'overseer-reviewer'
          ? [request(H, finished ? 'done' : 'claimed')]
          : finished && filters.recipient !== 'operator'
            ? [receipt(H, 'changes_requested')]
            : [];
      reads += 1;
      if (reads === 1) finished = true;
      return rows;
    };
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, list, noLegacy)).not.toBeNull();
    expect(order[0]).toBe('overseer-reviewer');
  });

  test('a failing read fails closed', async () => {
    const list = async (): Promise<never> => {
      throw new Error('db down');
    };
    expect(await loadReviewConflictAtHead({ ...PR, headSha: H }, list, noLegacy)).toBe(
      'lookup_failed'
    );
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
