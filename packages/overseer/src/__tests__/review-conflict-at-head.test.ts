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

// WO-HARNESS-MERGE-GATE-CHECK-SCOPED-SUPERSEDE-01. Copied verbatim from
// pr-review-check-scope.test.ts (not exported there): lspro-react#777's real
// review summaries at head ca6fa304 (2026-11-03 20:33Z and 20:34Z).
const PR777_SLASH_SUMMARY =
  'Independent review by the Overseer App at head `ca6fa304f66296e99185567de3bc5cf05f2a6f68`.\n' +
  '\n' +
  '[major] Required checks / CE Promotion Gate: The supplied required CE Promotion Gate result is skipped, so it does not demonstrate successful promotion validation for this head.\n' +
  '[note] scripts/ci/vercel-api-routing.test.ts: The 3 tests execute 10 meaningful assertions with no zero-assertion tests.';
const PR777_COLON_SUMMARY =
  'Independent review by the Overseer App at head `ca6fa304f66296e99185567de3bc5cf05f2a6f68`.\n' +
  '\n' +
  '[major] Required check: CE Promotion Gate (126186742456): The supplied required gate concluded skipped, so successful promotion validation is missing for this exact head.\n' +
  '[note] scripts/ci/vercel-api-routing.test.ts: Static review found 3 tests with 10 executed value assertions and no assertion-free tests.';
const CODE_SUMMARY =
  '[major] packages/overseer/src/adapters/github-real-deps.ts: the merge gate ignores a legacy receipt.';

const PR777 = { owner: 'thinmansoftware', repo: 'lspro-react', number: 777 };
const H777 = 'ca6fa304f66296e99185567de3bc5cf05f2a6f68';
type Ref = { owner: string; repo: string; number: number };
type Seq = number | string | null;

interface SeqRow {
  id?: string;
  seq: Seq;
  status: 'done';
  result_body?: string | null;
  body: string;
}

// A finished review request whose result_body is the persisted SubmitOutcome
// JSON (review-worker-clock writes JSON.stringify(outcome)).
const doneRequest = (
  ref: Ref,
  headSha: string,
  id: string,
  seq: Seq,
  resultBody: string | null
): SeqRow => ({
  id,
  seq,
  status: 'done',
  result_body: resultBody,
  body: JSON.stringify({ owner: ref.owner, repo: ref.repo, prNumber: ref.number, headSha }),
});
const outcome = (disposition: string, summary: string): string =>
  JSON.stringify({ disposition, summary });

const seqReceipt = (
  ref: Ref,
  headSha: string,
  disposition: string,
  messageId: string,
  seq: Seq
): SeqRow => ({
  seq,
  status: 'done',
  body: JSON.stringify({
    kind: 'pr_review_submit_receipt',
    disposition,
    messageId,
    owner: ref.owner,
    repo: ref.repo,
    prNumber: ref.number,
    headSha,
  }),
});

// lspro-react#777 at ca6fa304: eight check-caused changes_requested, then one
// approval with a higher seq.
const pr777Rows = (): { requests: SeqRow[]; receipts: SeqRow[] } => {
  const requests: SeqRow[] = [];
  const receipts: SeqRow[] = [];
  for (let i = 0; i < 8; i += 1) {
    const id = `req-777-${i}`;
    const summary = i % 2 === 0 ? PR777_SLASH_SUMMARY : PR777_COLON_SUMMARY;
    requests.push(doneRequest(PR777, H777, id, 100 + i * 2, outcome('changes_requested', summary)));
    receipts.push(seqReceipt(PR777, H777, 'changes_requested', id, 101 + i * 2));
  }
  requests.push(
    doneRequest(PR777, H777, 'req-777-ok', 200, outcome('approved', 'No blocking findings.'))
  );
  receipts.push(seqReceipt(PR777, H777, 'approved', 'req-777-ok', 201));
  return { requests, receipts };
};

// bdc-harness#1453 at 68937274: approved, approved, then three code-scoped
// changes_requested.
const pr1453Rows = (): { requests: SeqRow[]; receipts: SeqRow[] } => {
  const requests: SeqRow[] = [];
  const receipts: SeqRow[] = [];
  const dispositions = [
    'approved',
    'approved',
    'changes_requested',
    'changes_requested',
    'changes_requested',
  ];
  dispositions.forEach((disposition, i) => {
    const id = `req-1453-${i}`;
    const summary = disposition === 'approved' ? 'No blocking findings.' : CODE_SUMMARY;
    requests.push(doneRequest(PR, H, id, 300 + i * 2, outcome(disposition, summary)));
    receipts.push(seqReceipt(PR, H, disposition, id, 301 + i * 2));
  });
  return { requests, receipts };
};

describe('check-scoped changes_requested superseded by a later approval (WO-HARNESS-MERGE-GATE-CHECK-SCOPED-SUPERSEDE-01)', () => {
  test('Test 1: pr777_check_caused_then_approved_passes', () => {
    const { requests, receipts } = pr777Rows();
    expect(reviewConflictFromMessages({ ...PR777, headSha: H777 }, receipts, requests)).toBeNull();
    // Postgres returns seq as a bigint string; the order still holds.
    const asStrings = (rows: SeqRow[]): SeqRow[] =>
      rows.map(row => ({ ...row, seq: String(row.seq) }));
    expect(
      reviewConflictFromMessages(
        { ...PR777, headSha: H777 },
        asStrings(receipts),
        asStrings(requests)
      )
    ).toBeNull();
  });

  test('Test 2: pr1453_approve_then_changes_requested_refuses', () => {
    const { requests, receipts } = pr1453Rows();
    expect(reviewConflictFromMessages({ ...PR, headSha: H }, receipts, requests)).toBe(
      'changes_requested'
    );
  });

  test('Test 3: code_finding_then_approve_refuses', () => {
    const requests = [
      doneRequest(PR, H, 'req-code', 10, outcome('changes_requested', CODE_SUMMARY)),
      doneRequest(PR, H, 'req-ok', 12, outcome('approved', 'No blocking findings.')),
    ];
    const receipts = [
      seqReceipt(PR, H, 'changes_requested', 'req-code', 11),
      seqReceipt(PR, H, 'approved', 'req-ok', 13),
    ];
    expect(reviewConflictFromMessages({ ...PR, headSha: H }, receipts, requests)).toBe(
      'changes_requested'
    );
    // Mixed: a check-scoped one is superseded, but the code-scoped one remains.
    const mixedRequests = [
      ...requests,
      doneRequest(PR, H, 'req-check', 8, outcome('changes_requested', PR777_SLASH_SUMMARY)),
    ];
    const mixedReceipts = [...receipts, seqReceipt(PR, H, 'changes_requested', 'req-check', 9)];
    expect(reviewConflictFromMessages({ ...PR, headSha: H }, mixedReceipts, mixedRequests)).toBe(
      'changes_requested'
    );
  });

  test('Test 4: check_caused_after_approval_refuses', () => {
    const requests = [
      doneRequest(PR777, H777, 'req-ok', 10, outcome('approved', 'No blocking findings.')),
      doneRequest(PR777, H777, 'req-check', 12, outcome('changes_requested', PR777_SLASH_SUMMARY)),
    ];
    const receipts = [
      seqReceipt(PR777, H777, 'approved', 'req-ok', 11),
      seqReceipt(PR777, H777, 'changes_requested', 'req-check', 13),
    ];
    expect(reviewConflictFromMessages({ ...PR777, headSha: H777 }, receipts, requests)).toBe(
      'changes_requested'
    );
    // Without seq the order is not provable, whatever the array order: conflict.
    const noSeq = receipts.map(row => ({ ...row, seq: null })).reverse();
    expect(reviewConflictFromMessages({ ...PR777, headSha: H777 }, noSeq, requests)).toBe(
      'changes_requested'
    );
  });

  test('Test 5: unreadable_summary_fails_closed', () => {
    const approval = seqReceipt(PR777, H777, 'approved', 'req-ok', 21);
    for (const resultBody of [null, 'not json', JSON.stringify({ disposition: 'x' })]) {
      const requests = [doneRequest(PR777, H777, 'req-cr', 10, resultBody)];
      const receipts = [seqReceipt(PR777, H777, 'changes_requested', 'req-cr', 11), approval];
      expect(reviewConflictFromMessages({ ...PR777, headSha: H777 }, receipts, requests)).toBe(
        'changes_requested'
      );
    }
    // A messageId with no matching request row also fails closed.
    expect(
      reviewConflictFromMessages(
        { ...PR777, headSha: H777 },
        [seqReceipt(PR777, H777, 'changes_requested', 'req-missing', 11), approval],
        []
      )
    ).toBe('changes_requested');
  });

  test('Test 6: loader_passes_result_body_and_seq', async () => {
    const listFor =
      (rows: { requests: SeqRow[]; receipts: SeqRow[] }) =>
      async (filters: { recipient: string }): Promise<SeqRow[]> =>
        filters.recipient === 'overseer-reviewer'
          ? rows.requests
          : filters.recipient === 'operator'
            ? []
            : rows.receipts;
    expect(
      await loadReviewConflictAtHead({ ...PR777, headSha: H777 }, listFor(pr777Rows()), noLegacy)
    ).toBeNull();
    expect(
      await loadReviewConflictAtHead({ ...PR, headSha: H }, listFor(pr1453Rows()), noLegacy)
    ).toBe('changes_requested');
  });
});
