import { test, expect } from 'bun:test';
import { evaluatePromotion, COVERED_PRODUCTION_BASES } from '../m09-promotion-gate';
import { createPromotionGate, reevaluatePromotion } from '../m09-promotion-gate-wiring';
import { DEFAULT_MERGE_REPO_POLICY } from '../merge-repo-policy';
const sha = 'a'.repeat(40),
  pin = 'b'.repeat(40);
const repo = 'thinmansoftware/shopops-storefront';
// Adapted from PR 224 pass, wrong-governs, unrelated-repository,
// draft-motion, prose-sha-only, suffixed-motion and behind-master fixtures.
function fixture() {
  return {
    repository: repo,
    head: sha,
    body: `M-09 promotion:\nmotion_id: M-20261103c\napproved_sha: ${sha}`,
    pinnedSha: pin,
    truncated: false,
    paths: ['docs/board/motions/M-20261103c-promotion.md'],
    motion: `motion_id: M-20261103c\ngoverns: M-09\nrepository: ${repo}\nstatus: CARRIED\napproved_sha: ${sha}`,
    behindBy: 0,
  };
}
test('valid_promotion_passes', () => {
  const r = evaluatePromotion(fixture());
  expect(r.conclusion).toBe('success');
  expect(r.rules.every(r => r.pass)).toBe(true);
});
test('missing_block_fails_closed', () => {
  const r = evaluatePromotion({ ...fixture(), body: '' });
  expect(r.conclusion).toBe('failure');
  expect(r.reason).toBe('no promotion block');
});
test('wrong_repository_fails', () => {
  expect(
    evaluatePromotion({
      ...fixture(),
      motion: fixture().motion.replace(repo, 'thinmansoftware/other'),
    }).rules[3].pass
  ).toBe(false);
});
test('not_governing_m09_fails', () => {
  expect(
    evaluatePromotion({ ...fixture(), motion: fixture().motion.replace('M-09', 'M-10') }).rules[2]
      .pass
  ).toBe(false);
});
test('non_ratified_status_fails', () => {
  for (const status of ['TABLED', 'DRAFT', 'prose CARRIED'])
    expect(
      evaluatePromotion({ ...fixture(), motion: fixture().motion.replace('CARRIED', status) })
        .rules[4].pass
    ).toBe(false);
});
test('sha_mismatch_and_short_sha_fail', () => {
  for (const approved of ['c'.repeat(40), 'aaaaaaa'])
    expect(
      evaluatePromotion({ ...fixture(), body: fixture().body.replace(sha, approved) }).rules[5].pass
    ).toBe(false);
});
test('behind_base_fails', () => {
  expect(evaluatePromotion({ ...fixture(), behindBy: 1 }).rules[6].pass).toBe(false);
});
test('truncated_listing_and_suffixed_ids', () => {
  expect(evaluatePromotion({ ...fixture(), truncated: true }).rules[1].pass).toBe(false);
  expect(evaluatePromotion(fixture()).conclusion).toBe('success');
  expect(
    evaluatePromotion({ ...fixture(), body: fixture().body.replace('M-20261103c', 'M-2026110') })
      .rules[0].pass
  ).toBe(false);
});
function fake() {
  const calls: { route: string; data: any }[] = [];
  const reads: string[] = [],
    writes: { route: string; data: any }[] = [];
  let check: any;
  const request = async (route: string, data: any) => {
    calls.push({ route, data });
    if (route.startsWith('POST') || route.startsWith('PATCH')) {
      writes.push({ route, data });
      check = {
        id: 1,
        name: data.name ?? 'm09-promotion-gate',
        external_id: sha,
        app: { id: 4574893 },
      };
      return { data: check };
    }
    reads.push(route.replace('{repo}', data.repo).replace('{tree_sha}', data.tree_sha ?? ''));
    if (route.includes('/pulls/'))
      return { data: { number: 1, body: fixture().body, head: { sha }, base: { ref: 'master' } } };
    if (route.includes('/compare/')) return { data: { behind_by: 0 } };
    if (route.includes('/git/ref/')) return { data: { object: { sha: pin } } };
    if (route.includes('/git/trees/'))
      return {
        data: {
          truncated: false,
          tree: [{ path: fixture().paths[0], type: 'blob', mode: '100644' }],
        },
      };
    if (route.includes('/contents/')) {
      expect(data.ref).toBe(pin);
      return {
        data: { content: Buffer.from(fixture().motion).toString('base64'), encoding: 'base64' },
      };
    }
    if (route.includes('/check-runs'))
      return { data: { total_count: check ? 1 : 0, check_runs: check ? [check] : [] } };
    throw Error('unexpected read');
  };
  return { calls, reads, writes, request };
}
test('pr_cannot_influence_the_gate', async () => {
  const priorToken = process.env.GH_TOKEN;
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('GITHUB_APP'))
  );
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    process.env.GH_TOKEN = 'unit-test-placeholder';
    expect(() => reevaluatePromotion({ repository: repo, number: 1 })).toThrow(
      'm09 requires Overseer App installation identity'
    );
  } finally {
    Object.assign(process.env, saved);
    if (priorToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorToken;
  }

  const f = fake();
  await createPromotionGate(f.request, 4574893)({ repository: repo, number: 1 });
  expect(f.reads.filter(r => r.includes('/contents/')).every(r => r.includes('/bdc-xo/'))).toBe(
    true
  );
  expect(f.reads.some(r => r.includes('/git/trees/') && !r.includes(pin))).toBe(false);
  expect(f.writes[0]?.data.conclusion).toBe('success');
  for (const call of f.calls.filter(c => c.route.startsWith('GET'))) {
    expect(call.route).toMatch(/\/(pulls|compare|git\/ref|git\/trees|contents|commits)\//);
    if (call.route.includes('/git/trees/')) {
      expect(call.data.repo).toBe('bdc-xo');
      expect(call.data.tree_sha).toBe(pin);
    }
    if (call.route.includes('/contents/')) {
      expect(call.data.repo).toBe('bdc-xo');
      expect(call.data.ref).toBe(pin);
    }
  }
});
test('one_check_run_per_head_and_non_production_base_ignored', async () => {
  const f = fake();
  const gate = createPromotionGate(f.request, 4574893);
  await Promise.all([gate({ repository: repo, number: 1 }), gate({ repository: repo, number: 1 })]);
  expect(f.writes.filter(w => w.route.startsWith('POST')).length).toBe(1);
  expect(f.writes.filter(w => w.route.startsWith('PATCH')).length).toBe(1);
  const other = fake();
  await createPromotionGate(
    async (r, d) =>
      r.includes('/pulls/') ? { data: { base: { ref: 'staging' } } } : other.request(r, d),
    4574893
  )({ repository: repo, number: 1 });
  expect(other.writes.length).toBe(0);
});
test('production_bases_match_merge_policy', () => {
  for (const [repo, bases] of Object.entries(DEFAULT_MERGE_REPO_POLICY))
    for (const [base, rule] of Object.entries(bases))
      if (!rule.unattended) expect(COVERED_PRODUCTION_BASES[repo]?.includes(base)).toBe(true);
  for (const [repo, bases] of Object.entries(COVERED_PRODUCTION_BASES))
    for (const base of bases)
      expect(DEFAULT_MERGE_REPO_POLICY[repo]?.[base]?.unattended).toBe(false);
});
