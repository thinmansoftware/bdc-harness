## Summary
# Implementation plan (revised)

## WO ID
WO-CSOS-PROVISIONER-GATE2-LAPSED-HOLD-RELEASE-01. Class CODE, target repo `thinmansoftware/comicstoreos-provisioner`.

base_authorized_by_spec: feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406

The child branch is cut from that base (PR 76 head, 5e7772e). The pre-check verdict is needs-build. I confirmed `releaseAbandoned` appears once in `staging-runtime.ts` and `M67PostgresStore` appears 0 times in the integration test.

## Design
- `Gate2Publisher.expireLapsedReservations` has only `sql` and the ledger. It has no M67 store.
- `StagingRuntime` has `this.store` (M67PostgresStore) and the optional `this.publisher`. It calls the sweep at `staging-runtime.ts:206` (`createCheckout`) and `:281` (`abandonCheckout`).
- The hold step therefore lives in `StagingRuntime`. The publisher only supplies a read-only scan of ledger reservations in state `expired` with `owner_namespace = '\''csos-gate2'\''`. The scan returns `{ proofId (owner_principal_ref), slug }`.
- `m67-store.ts` and `src/customer/**` stay untouched.
- Add the scan to the `Gate2Publisher` interface. Implement it in `createGate2Publisher` and delegate it in `createEnvironmentGate2Publisher` (about line 741).
- Add a private `StagingRuntime.sweepLapsed(limit = 100)` that runs in this order:
  1. Ledger step: `publisher.expireLapsedReservations(limit)`, unchanged.
  2. Hold step: call the scan (bounded by `limit`). For each `{proofId, slug}`, call `getCheckoutHold(proofId)`.
     - Skip it if the hold is null, the slug differs, or the state is not one of `held`, `bound`, `expired`. A `converted` hold is never touched.
     - Call `expireHold(proofId, slug, hold.version)` unless the state is already `expired`.
     - Then call `releaseAbandoned(proofId)`. A proof with a tenant row is never deleted by it.
     - Catch `M67RequestError` with status 409 per item (concurrent writer, for example a late payment) and continue. Other errors propagate.
- Scan ordering (fixes a starvation bug in the first draft):
  - Order by most-recent-first, `ORDER BY <expiry/updated timestamp> DESC, id DESC`, using the real column names found in the Rule 5 check.
  - Do not order ascending. Expired rows whose holds are already released (hold null) never leave the `expired` state. An ascending window would fill with them permanently, and new lapses and crash-stranded holds would never be reached.
  - Most-recent-first plus a sweep on every checkout and abandon means a stranded hold is recovered on the next sweep.
  - Do not join `m67_harness` in the scan SQL. The ledger `sql` and the M67 store may point at different databases.
- Both existing `expireLapsedReservations(100)` call sites become `sweepLapsed()`.

## Pre-code verification (Rule 5; do before editing)
1. Read `customer-migrations/001_customer_ledger.sql` (and later migrations). Confirm the `owner_namespace`, `owner_principal_ref`, `slug`, `state` and timestamp column names on `customer_provisioning.checkout_reservations`.
2. Read `reserveCheckoutIntent` and the Gate 2 publisher. Confirm that `owner_principal_ref` is the proof id the hold is keyed by.
3. Confirm where `Gate2Publisher`, `createGate2Publisher` and `createEnvironmentGate2Publisher` are defined.
   - If any is defined under `staging/src/customer/**`, STOP and report. That path is out of scope (Stop 5). Do not edit it.
4. Read the call sites at `:206` and `:281`.
   - `createCheckout`: if it reads the caller'\''s own hold before the sweep, the sweep must not invalidate that read. Place the sweep so that a retry by the same lapsed proof still works, or re-read the hold after the sweep.
   - `abandonCheckout`: if the sweep runs before its own `getCheckoutHold` / `expireHold` / `releaseAbandoned` for the same proof, the sweep may already have released that proof'\''s hold. `abandonCheckout` must then tolerate the null hold exactly as it does today for an absent hold, or the sweep must run after the explicit release.
   - Pick the order that preserves current `abandonCheckout` behavior and note it in the PR description.
5. Confirm `M67RequestError` is exported and exposes a status (409) usable in a catch.
6. Read `tests/staging-runtime-lifecycle.test.ts` near line 308 and the PG17 harness setup in the integration test.
   - Determine whether the `m67_harness` schema, `create_signup` and `slug_holds` are available. The spec says the real create_signup is available, but `ensureSchema` here loads only customer migrations.
   - If they are not loaded, the test setup applies the existing `staging/supabase/migrations/` files in order, read-only: `20260810003322_m67_harness_private_schema.sql`, `20260824132000_m67_create_signup_conflict_fix.sql` and any prerequisites.
   - Do not modify `staging/supabase/**`.
   - If the migrations cannot be applied on plain PG17 (for example, missing Supabase roles or extensions) without out-of-scope edits, STOP and report BLOCKED. Do not substitute a mock. A mock that enforces slug uniqueness would not satisfy Stop 4 or the Overseer finding.

## Files to modify
1. `staging/src/server/staging-runtime.ts`
   - Interface method, publisher scan, env-publisher delegate, `StagingRuntime.sweepLapsed`, and the two rewired call sites.
   - Use a scan SQL alias and text that does not collide with the Scenario G stale-version proxy matcher (`checkout_reservations r`). Re-run Scenario G to confirm.
   - Result: `releaseAbandoned` count goes from 1 to 2 or more.
2. `staging/tests/gate2-confirmed-charge.integration.ts`
   - Replace the mocked `harnessStore` with a real `M67PostgresStore` pointed at the harness DB. Cover Scenario F and the rest of the file as needed.
   - The real create_signup enforces the slug primary key.
   - Test 1: P1 checks out S and never pays. The clock passes `expires_at`. P2 calls `createCheckout` for S. Assert P1'\''s reservation is `expired`, P1'\''s `runs` and `slug_holds` rows are gone, and P2'\''s hold, reservation and binding exist.
   - Test 2: a paid proof P3 has a tenant row and a `converted` hold, with its reservation past `session_expires_at`. Run the sweep. Assert the `runs`, `tenants` and `slug_holds` rows are unchanged and a new proof cannot book S3.
   - Test 3: fault injection stops after the ledger step, so the reservation is `expired` and the hold is present. A second sweep releases the hold and S becomes bookable.
   - Test 5 (added): scan window not starved.
     - Seed more `expired` csos-gate2 reservations than a small `limit` (for example 3 with limit 2), each with no hold.
     - Add one newer lapsed unpaid reservation that still has its hold.
     - Assert the scan or sweep with that small limit returns and releases the newer one.
     - Drive it through the publisher scan method, since `sweepLapsed`'\''s limit is private.
3. `staging/tests/gate2-confirmed-charge.test.ts`
   - Update the publisher spy in `creationRig` for the new scan method.
   - Update the existing "runtime releases lapsed reservations" test for the new call order.
   - Test 4 (unit order): `expireReservation` before `expireHold` before `releaseAbandoned` for one lapsed unpaid reservation, and no hold calls for a `converted` hold.

## Files to create
None.

## Files explicitly out of scope
- `staging/src/customer/**`
- `staging/src/server/m67-store.ts` (method bodies)
- `staging/supabase/**` (no migration, no change to create_signup or slug_holds; reading is allowed)
- `staging/package.json` and `staging/package-lock.json`
- Stranded `creating` reservations and early release before `session_expires_at` (WO-CSOS-LEDGER-RESERVATION-REAPER-01, issue 4357)
- Any production use or deploy. This is test-only staging.

## Verification commands
Run from the repo root unless noted:
```
cd staging && npx tsx --test tests/gate2-confirmed-charge.test.ts        # Stop 1: exit 0, '\''# fail 0'\'', '\''# pass N'\''
grep -c releaseAbandoned staging/src/server/staging-runtime.ts           # Stop 3: >= 2
grep -c M67PostgresStore staging/tests/gate2-confirmed-charge.integration.ts   # Stop 4: >= 1
git diff --name-only origin/feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406..HEAD -- staging/src/customer staging/supabase staging/src/server/m67-store.ts staging/package.json staging/package-lock.json   # Stop 5: no output
git diff --name-only origin/feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406..HEAD | xargs LC_ALL=C grep -n '\''[^ -~]'\''   # Stop 6 (ASCII): no output
npx tsc --noEmit -p staging                                              # typecheck for the interface change (or the repo'\''s typecheck script)
npm --prefix staging run test:customer-transport:integration             # needs PG17; if unavailable locally, rely on CI
gh pr checks <child PR> --repo thinmansoftware/comicstoreos-provisioner --json name,bucket,link --jq '\''.[]|select(.name=="customer-transport")|"\(.name) \(.bucket) \(.link)"'\''   # Stop 2
```
- The manifest Tests line must use counts from the CI `customer-transport` job log at the child PR head, not a local run.
- Do not run PowerShell or operator-side scripts in the builder.

## Commit message
```
fix(gate2): release the unpaid M67 slug hold when a checkout reservation lapses

The lapse sweep freed only the ledger claim, so m67_harness.slug_holds
(primary key on slug) still blocked a second proof from booking the name
with a 409. Add a crash-safe hold step after the ledger step that runs
expireHold then releaseAbandoned for unpaid lapsed reservations, never
for converted or tenant-backed holds. Scenario F now runs against the
real M67PostgresStore.

WO: WO-CSOS-PROVISIONER-GATE2-LAPSED-HOLD-RELEASE-01
```
All source must stay ASCII-only (Rule 13).

## Push policy
`thinmansoftware/comicstoreos-provisioner` is not a Rule 20 staging-gate repo.
- Use a feature branch cut from `feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406`.
- Open a child PR that targets that branch, which feeds PR 76. Do not target `dev`.
- Do not merge. Opening the PR is the builder'\''s terminal act.
- No force-push, no hook bypass, no production action.

## Staging gate required
No. The repo is not lspro-react, shopops-storefront or shopops. The `customer-transport` CI job (PG17 integration) at the child PR head is the CI gate (Stop 2). Production use stays blocked until WO-CSOS-LEDGER-RESERVATION-REAPER-01 (issue 4357) is merged and proven.

## Validation
Workflow-time verify-* nodes were removed 2026-05-16 (Patch 1) - agent self-verifies in implement loop;
real validation gates run at PR time (codex-review + claude-review + Gitleaks + e2e-smoke + Captain CI).
See implement output below for what the builder verified locally.

## Base branch override
Base branch override applied: PR targets `feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406` per spec-declared `Base branch:` field (not the default staging gate).

## Implement output
'Table-level select; good. Now edit the runtime.Now the unit test edits.The lapse sweep now also releases the unpaid M67 slug hold, in `staging/src/server/staging-runtime.ts`. I could not run the real-store integration test here. The commit is `a8c155d` and is pushed on `archon/task-web-worker-1793694688844-bm39t1`. I did not open the child PR.

**What changed**
- **Order:** the sweep runs the ledger step first, as before. Then a separate scan reads `expired` `csos-gate2` reservations. For each one it checks the proof'\''s hold, calls `expireHold` (skipped if already expired) and then `releaseAbandoned`.
- **Never touched:** a `converted` hold, a slug mismatch, or a proof with a tenant row.
- **Crash recovery:** the scan is separate, so the next sweep finishes a release left half-done by a crash between the steps.
- **Call sites:** `createCheckout` and `abandonCheckout` both use the new sweep. `abandonCheckout` keeps its explicit release first, so its behaviour is unchanged.
- **Scan ordering:** the scan returns newest first, so old already-released rows cannot fill the limit and starve new lapses.
- **Errors:** a 409 (a concurrent writer such as a late payment) or a 400 (a ledger row whose owner ref is not a proof id) skips that one row. Anything else propagates.
- **Cost:** each checkout or abandon call can now run up to 100 `getCheckoutHold` lookups, because old expired rows stay in the scan window. That is acceptable for staging but worth knowing.

**Tests**
- **Unit test:** `tests/gate2-confirmed-charge.test.ts` has a new unit-order test (Test 4). It checks `expireReservation` runs before `expireHold` and `expireHold` before `releaseAbandoned`. It also checks an already-expired hold is released without a second expire, and that converted holds and slug mismatches trigger no hold calls.
- **Integration test:** `tests/gate2-confirmed-charge.integration.ts` now runs Scenario F against the real `M67PostgresStore`. It applies the repo'\''s four `staging/supabase` migrations read-only and first creates the `anon`, `authenticated` and `postgres` roles the migrations assume.
- **TLS workaround:** the store pins `ssl: "require"` and the CI Postgres has no TLS, so the test swaps in plain connection pools. Every store method itself is unchanged.
- **New integration scenarios:** Tests 2, 3 and 5. Test 2 uses a proof with a converted hold and a tenant row, and checks its rows are unchanged. Test 3 injects a crash between the two steps, then checks the second sweep recovers. Test 5 checks that the newest lapsed reservation comes first in the scan.

**Checks I ran**
| Check | Result |
|---|---|
| `npx tsx --test tests/gate2-confirmed-charge.test.ts` (Stop 1) | pass 13, fail 0 |
| `tsc --noEmit` | clean |
| `grep -c releaseAbandoned staging/src/server/staging-runtime.ts` (Stop 3) | 2 |
| `grep -c M67PostgresStore staging/tests/gate2-confirmed-charge.integration.ts` (Stop 4) | 5 |
| Scope diff (Stop 5) | empty |
| ASCII scan (Stop 6) | empty |

I did not run the real-store integration test because the CI-gated fixture needs GitHub Actions and Docker, which are not available here. As a substitute I ran the migrations and the store'\''s SQL (`create_signup` slug conflict, `expireHold`, `releaseAbandoned`, the paid conversion) on an in-memory Postgres. The migrations applied and the conflict, release and re-book behaved as expected.

**Still open**
- **Stop 2:** the `customer-transport` job at the child PR head is still to be checked. The manifest'\''s test counts must come from that CI log, not from my runs.
- **Production:** it remains blocked until WO-CSOS-LEDGER-RESERVATION-REAPER-01 (issue 4357) is merged and proven.

COMPLETE
BUILD_COMPLETE'

## Validator
'I'\''ll start by checking the working tree and the diff.Next I'\''ll read the integration test diff, since it has to run against the real store.The earlier `cd staging` persisted, so I'\''ll switch back to the repo root.The scan orders by `updated_at`, so I need to confirm that column exists on `checkout_reservations`. I also want to see how `runs` and `slug_holds` are keyed and what `ensureSchema` loads.`request_key` is `gate2:checkout:<proofId>` and is unique, so I need to see what `reserveCheckoutIntent` does with a prior row that has expired.The ASCII command errored because `xargs` can'\''t take `LC_ALL=C` as a prefix, so I'\''ll rerun it through `env`. Only the `psql` client is installed here, so the integration test can'\''t run locally.**Verdict: satisfied.** The code and unit evidence are met. The real-store integration test could not be run here, so it rests on CI at the child PR head.

TESTS_OBSERVED: 13/13 (cd staging && npx tsx --test tests/gate2-confirmed-charge.test.ts)

This matches the mechanical TESTS_PASSED=13 and TESTS_TOTAL=13, so there is no discrepancy. I also ran `npx tsc --noEmit` in `staging` and it is clean.

**Stop conditions**
| Stop | Result |
|---|---|
| 1. Unit tests | Pass: exit 0, `# pass 13`, `# fail 0`. |
| 2. `customer-transport` CI at the child PR head | Open. No child PR exists yet, and the PG17 integration test cannot run here: only the `psql` client is installed, with no server or Docker. |
| 3. `grep -c releaseAbandoned staging/src/server/staging-runtime.ts` | 2, as required. |
| 4. `grep -c M67PostgresStore staging/tests/gate2-confirmed-charge.integration.ts` | 5, as required. |
| 5. Scope diff on `staging/src/customer`, `staging/supabase`, `m67-store.ts` and the package files | No output. |
| 6. ASCII scan (rerun through `env`, since the first attempt hit a shell quirk) | No matches. |
| `git diff --check` | Clean. |

**Spec deliverables**
- **Sweep order:** `sweepLapsed` runs the ledger step, then a separate hold step. The hold step calls `getCheckoutHold`, skips a null hold, a slug mismatch or a `converted` hold, calls `expireHold` unless the hold is already expired, then `releaseAbandoned`.
- **Call sites:** both `createCheckout` and `abandonCheckout` use it. In `abandonCheckout` the explicit release still runs first, so its behavior is unchanged.
- **Scan:** `listExpiredReservations` is read-only and has no join to the `m67_harness` schema. It orders newest first, so old already-released rows cannot fill the limit.
- **Files:** only the three listed files changed. `m67-store.ts` and `src/customer/**` are untouched.

**Section 7 scenarios**
- **Test 1 (second proof books the released slug):** the integration Scenario F on the real `M67PostgresStore` would fail. It asserts P1'\''s `runs` and `slug_holds` rows are gone and P2'\''s hold is `bound`. If the hold were left in place, P2 would get a slug primary-key 409.
- **Test 2 (paid hold never released):** the new integration block would fail. It uses a proof with a tenant row and a `converted` hold. It asserts `m67Rows` is `deepEqual` before and after, and that P4 still gets a 409 for the slug. The unit test also asserts no hold calls for a `converted` hold.
- **Test 3 (crash between steps):** the new integration block would fail. It injects a throw in `listExpiredReservations`, asserts the reservation is `expired` while the run and hold remain, then asserts a second sweep clears both and P6 rebooks.
- **Test 4 (call order):** the new unit test asserts `["expireReservation","expireHold","releaseAbandoned"]`. It also covers an already-expired hold, a `converted` hold and a slug mismatch.
- **Added Test 5 (scan not starved):** it asserts `listExpiredReservations(1)` returns the newest lapse (P7) when at least 3 older expired rows exist. It then asserts the sweep releases P7'\''s hold.

**Residual items, not blocking**
1. **Integration test unrun:** I could not execute it, so the migration application, the role creation and the plain-pool swap in the test are unproven until the `customer-transport` job passes at the child PR head. The manifest'\''s Tests line must use counts from that CI log, not from a local run.
2. **Test setup reaches into the store'\''s private fields:** `realM67Store` replaces the pools through a cast, because the store pins `ssl: "require"` and the CI Postgres has no TLS. The store methods themselves run unchanged. The test would break if those fields were renamed.
3. **Cost per call:** each checkout or abandon can now make up to 100 `getCheckoutHold` lookups. The builder flagged this and it is acceptable for staging.
4. **Same-proof retry:** I checked whether a retry could have the sweep release the proof'\''s own live hold, and it cannot. `request_key` is `gate2:checkout:<proofId>` and unique, so a retry gets the prior expired reservation back and never a second live one.
5. **Production:** it remains blocked on WO-CSOS-LEDGER-RESERVATION-REAPER-01 (issue 4357).

Before the manifest goes in, the builder still has to open the child PR into `feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406`, and CI must pass at that head. The Stop 2 command is the `gh pr checks` call from the spec. The commit `a8c155d` is on `archon/task-web-worker-1793694688844-bm39t1`.'

Closes thinmansoftware/bdc-xo#4373

<!-- bdc-manifest-start -->
WO: WO-CSOS-PROVISIONER-GATE2-LAPSED-HOLD-RELEASE-01
Builder: Smart Cauldron (bdc-feature-development)
Files created: none
Files modified: staging/src/server/staging-runtime.ts,staging/tests/gate2-confirmed-charge.integration.ts,staging/tests/gate2-confirmed-charge.test.ts
Tests: 13/13 (cd staging && npx tsx --test tests/gate2-confirmed-charge.test.ts) [source: wo-spec]
PRs: https://github.com/thinmansoftware/comicstoreos-provisioner/pull/77
Merge ancestors: 5e7772ef5222083b4d341a18369336cef9dacbf2...797d800e6b7564f63ac5a747cbec477bf1018269 (behind_by=0)
Grep assertions: grep -c releaseAbandoned staging/src/server/staging-runtime.ts => 2; grep -c M67PostgresStore staging/tests/gate2-confirmed-charge.integration.ts => 5
Runtime verification: plan-review=PLAN_REVIEW_PASS=true PLAN_REVIEW_RISK=MEDIUM === APPROVED_PLAN_BEGIN === # Implementation plan (revised) ## WO ID WO-CSOS-PROVISIONER-GATE2-LAPSED-HOLD-RELEASE-01. Class CODE, target repo `thinmansoftware/comicstoreos-provisioner`. base_authorized_by_spec: feat/wo-csos-provisioner-gate2-reservation-lapse-release-01-thread-40ad3406 The child branch is cut from that base (PR 76 head, 5e7772e). The pre-check verdict is needs-build. I confirmed `releaseAbandoned` appears once in `staging-runtim; block-reclassify={"status":"PROCEED"}; open-pr-if-needed=ORIGIN_PRECONDITION_OK: origin/feat/wo-csos-provisioner-gate2-lapsed-hold-release-01-thread-797d800e == 797d800e6b7564f63ac5a747cbec477bf1018269 (attempt 1) acting_login=thinman-builder-2[bot] https://github.com/thinmansoftware/comicstoreos-provisioner/pull/77 [git remote -v] [git config --get-regexp ^remote\..*\.gh-resolved$] [git config --get-regexp ^branch\.feat/wo-csos-provisioner-gate2-lapsed-hold-release-01-thread-797d800e\.(remote|merge|pushremote|gh-merge-base)$]
VALIDATION: PASS
<!-- bdc-manifest-end -->

