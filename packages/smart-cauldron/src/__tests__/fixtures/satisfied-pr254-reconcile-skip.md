## Summary

Reconciliation for the storefront production motion (bdc-xo#6436, packet comment 7117521547, blocker B1), on the acting XO's word (fence 336). This brings production `master`'s three direct commits into `staging`, so that a later `staging` -> `master` promotion has `behind_by = 0` (the repo's promote-gate rule 7, `docs/runbooks/m09-promotion-gate-rules.md`). It is not a production change, and nothing is pushed to `master`.

```text
            05fde517 (staging)  ---+
                                   +--- 4e847fef  merge commit (this PR's head)
 2ea8bffc (master, production) ---+
```

**The merge commit's tree is byte-identical to `staging` 05fde517** (`git diff --stat origin/staging 4e847fef` is empty). What it adds is ancestry, not content.

| master commit | What it is | Already on staging as | Result |
|---|---|---|---|
| `98e7d864` (#227) | home page copy, plus the unit-test workflow | #225 (copy), #220 (workflow) | auto-merged; `app/page.tsx` and the workflow equal staging |
| `5ff0fa08` (#230) | home page copy | #229 | auto-merged; equals staging |
| `2ea8bffc` (#232) | checkout charges the server price | #226 (`201337af`) | **same patch-id** (`3cea1879...`); conflicted only because #233 and #236 later built on #226 |

### How each conflict was resolved, and why

All three were resolved to the staging side (`git checkout --ours`).

1. `app/api/storefront/checkout/route.ts`: staging's file is #226 (the identical patch to #232) plus #233 (order items kept, current cart prices recovered) and #236 (server-side item record). Every behavior master's version has is still there on staging, in a stricter form: `Invalid item quantity` (now `Number.isSafeInteger`, with duplicate lines merged first so a duplicate cannot hide a bad quantity), the per-item catalog re-fetch with `reason: 'unavailable'` fail-closed, the ratio and FOC-wall rule gated on `SHOPOPS_API_URL`, `Prices have changed. Please refresh your cart.` with `price_changed`, `Invalid cart total`, and the priced items. Taking master's side would remove #233 and #236 from staging.
2. `__tests__/checkout-server-price.test.ts` (both sides added it): the two copies have the same test names. Staging's copy is written against staging's route, while master's copy is written against master's older route.
3. `__tests__/portal/no-seed-data-leak.test.ts`: both sides assert the same fail-closed line, `return { ok: false, error: 'api_unavailable' };`. Staging's version also asserts that it comes before `loadSeed`, so it is the stricter test. Master's version would only weaken the check.

## Evidence

- **Before:** `git rev-list --count origin/staging..origin/master` = **3**, and a trial merge conflicted in the three files above.
- **After:** `git rev-list --count 4e847fef..origin/master` = **0**; `git diff --stat origin/staging 4e847fef` = (empty); parents `05fde517` and `2ea8bffc`.
- Tests: the tree equals staging 05fde517, whose Linux CI run 45283715108 (`storefront-unit-tests`) reported `437 pass 0 fail`. This PR's own required checks (`storefront-unit-tests`, Gitleaks) run on this head.

## Merge Danger

**Door:** two-way. No file content changes on staging.

**This PR must NOT be squash-merged.** The repo allows squash only (`allow_merge_commit: false`, `allow_rebase_merge: false`). A squash of this PR is an empty commit with one parent: it drops the `master` parent, staging stays 3 behind, and the reconciliation is lost. It can land in one of two ways, and choosing one is a decision for the XO and John:
- (a) after App approval of this exact head, fast-forward `staging` to `4e847fef` (`git push origin 4e847fef3fe6f64c946152d3b15ec98d4250eb47:staging`). This pushes no new commit, only exactly the reviewed one, but it needs whoever can push past the staging branch protection; or
- (b) turn on merge commits for this repository long enough for this one PR to land as a merge commit.

The same squash-only setting is probably why `master` and `staging` drifted apart, and it will happen again after every squashed `staging` -> `master` promotion. That is recorded for the board on bdc-xo#6436.

**Blast Radius:** none. The staging deployment would be the same tree as today.

`merge-hold` stays until the XO lifts it.

Reconcile-Skip: WO-STOREFRONT-HOSTED-CART-API-CHECKOUT-01, WO-STOREFRONT-FACTORY-SHOP-OWN-BRAND-01, WO-STOREFRONT-PROMO-TICKER-REMOVE-01

🤖 Generated with [Claude Code](https://claude.com/claude-code)

