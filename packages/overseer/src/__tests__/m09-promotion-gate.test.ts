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
      // Behave like GitHub: a null or non-string conclusion is HTTP 422, and a completed check run
      // needs one. The earlier fake accepted null and hid the silent gate (bdc-xo#5533).
      if (
        ('conclusion' in data && typeof data.conclusion !== 'string') ||
        (data.status === 'completed' && typeof data.conclusion !== 'string')
      )
        throw Object.assign(
          Error('Invalid request. For properties/conclusion, nil is not a string.'),
          {
            status: 422,
            response: { status: 422 },
          }
        );
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
    if (route.includes('/commits/{commit_sha}/pulls')) return { data: [] };
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
  expect(f.writes[0]?.data.status).toBe('in_progress');
  expect(f.writes.at(-1)?.data.conclusion).toBe('success');
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
  expect(f.writes.filter(w => w.route.startsWith('PATCH')).length).toBe(3);
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

// Independent review regressions: failures must invalidate an old green check.
test('lookup_and_publication_failures_invalidate_first_and_successful_heads', async () => {
  for (const prior of [false, true]) {
    for (const failure of [
      '/pulls/',
      '/check-runs',
      '/git/ref/',
      '/git/trees/',
      '/contents/',
      '/compare/',
    ]) {
      const f = fake();
      let broken = false;
      const gate = createPromotionGate(
        async (r, d) => {
          if (broken && r.startsWith('GET') && r.includes(failure))
            throw Error('injected lookup failure');
          return f.request(r, d);
        },
        4574893,
        { retryDelay: async () => {} }
      );
      const target = { repository: repo, number: 1, head: sha, base: 'master' };
      if (prior) await gate(target);
      broken = true;
      await gate(target);
      expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
      expect(f.writes.at(-1)?.data.status).toBe('completed');
    }
  }
  const f = fake();
  let rejects = 2;
  await createPromotionGate(
    async (r, d) => {
      if (d.status === 'in_progress' && rejects-- > 0) throw { status: 429 };
      return f.request(r, d);
    },
    4574893,
    { retryDelay: async () => {} }
  )({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(f.writes[0]?.data.status).toBe('in_progress');
  expect(f.writes.at(-1)?.data.conclusion).toBe('success');
});

test('pagination_exhaustion_posts_failure_and_later_pages_update_existing', async () => {
  const f = fake();
  const gate = createPromotionGate(
    async (r, d) => {
      if (r.startsWith('GET') && r.includes('/check-runs'))
        return {
          data: {
            check_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 10, name: 'other' })),
          },
        };
      return f.request(r, d);
    },
    4574893,
    { retryDelay: async () => {} }
  );
  await gate({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  const pages: number[] = [];
  const g = fake();
  await createPromotionGate(async (r, d) => {
    if (r.startsWith('GET') && r.includes('/check-runs')) {
      pages.push(d.page as number);
      return {
        data: {
          check_runs:
            d.page === 1
              ? Array.from({ length: 100 }, () => ({ id: 3, name: 'other' }))
              : [{ id: 99, name: 'm09-promotion-gate', external_id: sha, app: { id: 4574893 } }],
        },
      };
    }
    return g.request(r, d);
  }, 4574893)({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(pages).toEqual([1, 2]);
  expect(g.writes[0]?.data.check_run_id).toBe(99);
});

test('motion_sha_mismatch_missing_and_prose_publish_failure', async () => {
  for (const motion of [
    fixture().motion.replace(sha, 'c'.repeat(40)),
    fixture().motion.replace(`approved_sha: ${sha}`, ''),
    fixture().motion.replace(`approved_sha: ${sha}`, `Historical approval ${sha}`),
  ]) {
    const f = fake();
    await createPromotionGate(
      async (r, d) =>
        r.includes('/contents/')
          ? { data: { encoding: 'base64', content: Buffer.from(motion).toString('base64') } }
          : f.request(r, d),
      4574893
    )({ repository: repo, number: 1, head: sha, base: 'master' });
    expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  }
});

test('signed_webhook_and_rerequest_dispatch_failure_without_blocking_review', async () => {
  const { createHmac } = await import('node:crypto');
  const { processPromotionWebhook } = await import('../m09-promotion-gate-wiring');
  const f = fake();
  const gate = createPromotionGate(
    async (r, d) => (r.includes('/compare/') ? { data: { behind_by: 1 } } : f.request(r, d)),
    4574893
  );
  const secret = 'unit-test-webhook';
  for (const [eventType, payload] of [
    [
      'pull_request',
      {
        action: 'edited',
        repository: { full_name: repo },
        pull_request: { number: 1, head: { sha }, base: { ref: 'master' } },
      },
    ],
    [
      'check_run',
      {
        action: 'rerequested',
        repository: { full_name: repo },
        check_run: {
          name: 'm09-promotion-gate',
          head_sha: sha,
          pull_requests: [{ number: 1, base: { ref: 'master' } }],
        },
      },
    ],
  ] as const) {
    const rawBody = JSON.stringify(payload);
    const signature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    await processPromotionWebhook({ eventType, rawBody, signature }, secret, gate);
    expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  }
  const before = f.writes.length;
  await processPromotionWebhook(
    { eventType: 'pull_request', rawBody: '{}', signature: 'invalid' },
    secret,
    gate
  );
  expect(f.writes.length).toBe(before);
  const { ingestBeforePromotion } = await import('../m09-promotion-gate-wiring');
  const order: string[] = [];
  await expect(
    ingestBeforePromotion(
      async () => {
        order.push('review');
        return 1;
      },
      async () => {
        order.push('promotion');
        throw Error('API');
      }
    )
  ).rejects.toThrow('API');
  expect(order).toEqual(['review', 'promotion']);
});

test('publication_failure_turns_old_success_red_and_can_be_retried', async () => {
  for (const prior of [false, true]) {
    const f = fake();
    let fail = false;
    const gate = createPromotionGate(
      async (r, d) => {
        if (fail && d.conclusion === 'success') throw { status: 503 };
        return f.request(r, d);
      },
      4574893,
      { retryDelay: async () => {} }
    );
    const target = { repository: repo, number: 1, head: sha, base: 'master' };
    if (prior) await gate(target);
    fail = true;
    await expect(gate(target)).rejects.toThrow('m09 publication failed');
    expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
    fail = false;
    await gate(target);
    expect(f.writes.at(-1)?.data.conclusion).toBe('success');
  }
});

test('unrelated_heads_and_review_intake_do_not_wait_for_promotion', async () => {
  const { ingestBeforePromotion } = await import('../m09-promotion-gate-wiring');
  let release!: () => void;
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  const f = fake();
  let stalled = false;
  const gate = createPromotionGate(async (r, d) => {
    if (r.includes('/pulls/') && d.pull_number === 1) {
      stalled = true;
      await wait;
    }
    return f.request(r, d);
  }, 4574893);
  const first = gate({ repository: repo, number: 1, head: sha, base: 'master' });
  let reviewed = false;
  const intake = ingestBeforePromotion(
    async () => {
      reviewed = true;
      return 1;
    },
    async () => {
      await first;
    }
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(stalled).toBe(true);
  expect(reviewed).toBe(true);
  try {
    await gate({ repository: repo, number: 2, head: 'c'.repeat(40), base: 'master' });
  } finally {
    release();
  }
  await intake;
});

test('ambiguous_create_response_reconciles_before_retry_without_duplicate', async () => {
  const f = fake();
  let lose = true;
  const gate = createPromotionGate(
    async (r, d) => {
      const result = await f.request(r, d);
      if (r.startsWith('POST') && lose) {
        lose = false;
        throw Error('response lost');
      }
      return result;
    },
    4574893,
    { retryDelay: async () => {} }
  );
  await gate({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(f.writes.filter(w => w.route.startsWith('POST')).length).toBe(1);
  expect(f.writes.at(-1)?.data.conclusion).toBe('success');
});

test('operator_and_webhook_share_head_lock_and_refresh_approval_inside_it', async () => {
  const f = fake();
  let removed = false;
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(r => {
    release = r;
  });
  const started = new Promise<void>(r => {
    entered = r;
  });
  let pause = true;
  const gate = createPromotionGate(async (r, d) => {
    if (r.includes('/pulls/'))
      return {
        data: { body: removed ? '' : fixture().body, head: { sha }, base: { ref: 'master' } },
      };
    if (r.includes('/compare/') && pause) {
      pause = false;
      entered();
      await paused;
    }
    return f.request(r, d);
  }, 4574893);
  const operator = gate({ repository: repo, number: 1 });
  await started;
  removed = true;
  const webhook = gate({ repository: repo, number: 1, head: sha, base: 'master' });
  await new Promise(r => setTimeout(r, 10));
  release();
  await Promise.all([operator, webhook]);
  expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
});

test('lost_create_and_failed_reconciliation_never_issue_second_post', async () => {
  const f = fake();
  let lost = false;
  let failures = 3;
  const gate = createPromotionGate(
    async (r, d) => {
      if (r.startsWith('GET') && r.includes('/check-runs') && lost && failures-- > 0)
        throw Error('reconciliation unavailable');
      const response = await f.request(r, d);
      if (r.startsWith('POST') && !lost) {
        lost = true;
        throw Error('lost response');
      }
      return response;
    },
    4574893,
    { retryDelay: async () => {} }
  );
  try {
    await gate({ repository: repo, number: 1, head: sha, base: 'master' });
  } catch {}
  await gate({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(f.writes.filter(w => w.route.startsWith('POST')).length).toBe(1);
  expect(f.writes.at(-1)?.data.status).toBe('completed');
});

test('published_missing_block_output_names_required_reason', async () => {
  const f = fake();
  await createPromotionGate(
    async (r, d) =>
      r.includes('/pulls/')
        ? { data: { body: '', head: { sha }, base: { ref: 'master' } } }
        : f.request(r, d),
    4574893
  )({ repository: repo, number: 1, head: sha, base: 'master' });
  expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  expect(f.writes.at(-1)?.data.output.summary).toContain('no promotion block');
});

test('three_definitive_create_rejections_allow_recovery_on_redelivery', async () => {
  const f = fake();
  let recovered = false;
  let attempts = 0;
  let listings = 0;
  const gate = createPromotionGate(
    async (route, data) => {
      if (route.startsWith('GET') && route.includes('/check-runs')) listings++;
      if (route.startsWith('POST')) {
        attempts++;
        if (!recovered) throw { status: 429, response: { status: 429 } };
      }
      return f.request(route, data);
    },
    4574893,
    { retryDelay: async () => {} }
  );
  const target = { repository: repo, number: 1, head: sha, base: 'master' };
  await expect(gate(target)).rejects.toThrow();
  expect(attempts).toBe(3);
  expect(listings).toBe(1);
  recovered = true;
  await gate(target);
  expect(f.writes.filter(w => w.route.startsWith('POST')).length).toBe(1);
  expect(f.writes.at(-1)?.data.conclusion).toBe('success');
});

test('shared_head_release_ce_failure_cannot_be_overwritten_by_main_success', async () => {
  const f = fake();
  const repository = 'thinmansoftware/lspro-react';
  const prs = [
    { number: 1, state: 'open', body: fixture().body, head: { sha }, base: { ref: 'release/ce' } },
    { number: 2, state: 'open', body: fixture().body, head: { sha }, base: { ref: 'main' } },
  ];
  const gate = createPromotionGate(async (r, d) => {
    if (r.includes('/commits/{commit_sha}/pulls')) return { data: prs };
    if (r.includes('/pulls/')) return { data: prs[Number(d.pull_number) - 1] };
    if (r.includes('/contents/'))
      return {
        data: {
          encoding: 'base64',
          content: Buffer.from(fixture().motion.replace(repo, repository)).toString('base64'),
        },
      };
    if (r.includes('/compare/'))
      return { data: { behind_by: String(d.basehead).startsWith('release/ce') ? 1 : 0 } };
    return f.request(r, d);
  }, 4574893);
  await gate({ repository, number: 1, head: sha, base: 'release/ce' });
  expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  await gate({ repository, number: 2, head: sha, base: 'main' });
  expect(f.writes.at(-1)?.data.conclusion).toBe('failure');
  prs[0].body = '';
  await gate({ repository, number: 2, head: sha, base: 'main' });
  expect(f.writes.at(-1)?.data.output.summary).toContain('no promotion block');
});

test('in_progress publication never sends a null conclusion (bdc-xo#5533)', async () => {
  const f = fake();
  await createPromotionGate(f.request, 4574893)({ repository: repo, number: 1 });
  expect(f.writes.length).toBeGreaterThan(0);
  for (const w of f.writes) {
    if (w.data.status === 'in_progress') expect('conclusion' in w.data).toBe(false);
    else expect(typeof w.data.conclusion).toBe('string');
  }
  expect(f.writes[0]?.data.status).toBe('in_progress');
  expect(f.writes.at(-1)?.data.conclusion).toBe('success');
});

test('bdc_shopify_app_main_is_a_covered_production_base', () => {
  expect(COVERED_PRODUCTION_BASES['thinmansoftware/bdc-shopify-app']).toEqual(['main']);
});
