# Overseer reconcile: how WO trackers get marked merged and closed

> Amendment A1 (2026-11-03, John's ruling 2026-10-15 "DONE = tested live, not
> merged"): a keyword merge NO LONGER closes a tracker. It marks it
> `status:merged` and leaves it OPEN. Only a `LIVE-PROOF` comment closes it. See
> "Merged is not done" and "LIVE-PROOF" below. Where this runbook says a merge
> "closes" a tracker, read "marks it merged".

The Overseer "reconcile" loop (`packages/overseer/src/reconcile.ts`,
`runReconcileOnce`) closes WO tracker issues in `thinmansoftware/bdc-xo` after the
PR that completes the work merges. This runbook describes the closing rule, the
project base map, the `OVERSEER_PROJECT_BASES` override, the lookback floor, and
the `reconcile_keyword_missing_noted` audit row.

## The rule: closing keyword + project base

A merged PR closes a WO tracker issue only when BOTH are true:

1. The PR carries a GitHub **closing keyword** naming that tracker issue --
   `close/closes/closed`, `fix/fixes/fixed`, or `resolve/resolves/resolved`
   followed by `thinmansoftware/bdc-xo#<N>` (cross-repo), or `#<N>` when the PR is
   itself in `thinmansoftware/bdc-xo` (own-repo).
2. The PR merged into its project's **Cauldron base branch** (see the map below).

GitHub only auto-closes an issue on a closing keyword when the PR merges into the
repository's DEFAULT branch. Most Cauldron projects do their real work on a
non-default base (shopops/lspro-react/... on `staging`, bdc-harness on `dev`),
so GitHub never closes their WO trackers. Reconcile is what closes them -- it
honours the same closing keyword on the project base that GitHub would honour on
the default branch.

A merged PR that merely **names** a WO -- in prose, or on a bare manifest
`WO:` line with no closing keyword -- is NOT completion evidence and closes
nothing. A merge into any branch that is not the project base (a
feature-to-feature merge) also closes nothing.

The close is still subject to the existing guards: `Reconcile-Skip:` markers,
the re-close guard (a human reopen is not undone), the spec-only guard (the spec
PR that created a WO cannot close it), and the open-PR holder guard (a later open
stage keeps the tracker open), plus the pre-tracker guard: a PR that merged
before the tracker issue was created never closes it, even with a keyword edited
in later (log line `overseer.reconcile.pr_merged_before_tracker_created_left_open`;
anchor bdc-xo #4344). A close records an action row with
`class = closes_keyword`, `action = reconcile_close`.

## Project base map

Restated from `thinmansoftware/bdc-xo` `scripts/cauldron/cauldron-projects.json`
and kept in sync in `packages/overseer/src/project-bases.ts`. All projects are
under owner `thinmansoftware`.

| Repo | Cauldron base |
|------|---------------|
| shopops | staging |
| shopops-storefront | staging |
| lspro-react | staging |
| scout-service | staging |
| receiving-shipping-desk | staging |
| whats-that-tee-time | staging |
| bdc-harness | dev |
| bdc-xo | main |
| bdc-ci | main |
| bdc-crm | main |
| model-tier-advisor | main |
| shopops-comic-theme | main |
| comicstoreos-site | main |
| comicstoreos-infra | main |
| comicstoreos-provisioner | main |
| bdc-shopify-app | main |
| shopops-woo-theme | main |
| bdc-woo-app | main |
| bdc-store-factory | main |
| fuelglass | main |
| ollama-librarian | main |
| thinman-freight | master |
| t3code-bdc | bdc/main |

A repo not in the map resolves to `null` -- its merges close nothing.

## Override: OVERSEER_PROJECT_BASES

Set the `OVERSEER_PROJECT_BASES` environment variable to a JSON object mapping
`"owner/repo"` to a branch name to override the built-in map. The override wins
over the constant; malformed JSON is ignored (a warning is logged) and the loop
falls back to the constant. Example:

```
OVERSEER_PROJECT_BASES='{"thinmansoftware/shopops":"release/x"}'
```

With that set, a shopops PR closes its trackers only when merged into
`release/x`; a merge into `staging` no longer closes anything.

## Merged is not done: the status:merged mark

When a PR merges into its project base with a closing keyword naming an open
tracker (and passes every guard), reconcile:

1. adds the label `status:merged` (GitHub creates it on first use; the
   bdc-xo script `scripts/github-org/taskmaster-labels.sh --apply` also creates it),
2. removes `status:building` and `status:review` if present,
3. posts ONE comment (it starts with the hidden marker
   `<!-- overseer:merged-not-done -->`) naming the PR URL, merge SHA and base,
4. records `class = closes_keyword`, `action = reconcile_merged_noted`.

The issue stays OPEN. A rescan finds the row and does nothing. A PR merged before
the tracker issue was created never marks it (pre-tracker guard).

## LIVE-PROOF: how a tracker actually closes

After deploy, the XO or the builder posts a comment on the WO issue with a line:

```
LIVE-PROOF <evidence url or command output>
```

Each reconcile pass reads the open `status:merged` issues in
`thinmansoftware/bdc-xo` and their comments. The issue closes (label `wo:done`,
one evidence comment, row `class = live_proof`, `action = reconcile_close`,
`pr_ref = thinmansoftware/bdc-xo#<N>`) when such a line:

- comes AFTER the Overseer merged comment (the marker above),
- has non-empty evidence after `LIVE-PROOF `,
- is written by an allowed GitHub login.

Allowed logins: env `OVERSEER_LIVE_PROOF_AUTHORS` (comma list, case-insensitive)
on archon-app-1; default `bluedevilcollectibles` (the account the XO posts as).
Add a builder login there to let that builder close its own WOs. A human reopen
after a LIVE-PROOF close is not undone (one live-proof close per issue).

Read the marks and proof closes (readonly):

```
docker exec archon-app-1 bun -e "import {Database} from 'bun:sqlite'; \
  const db=new Database('/.archon/archon.db',{readonly:true}); \
  console.log(db.query(\"select class, action, pr_ref, wo_id, created_at from overseer_reconcile_actions where action in ('reconcile_merged_noted') or class='live_proof' order by created_at desc limit 50\").all())"
```

## The reconcile_keyword_missing_noted row

When a PR on its project base declares a WO on a manifest `WO:` line but carries
NO closing keyword for that WO's tracker, reconcile leaves the tracker OPEN (a
declaration is not completion evidence) and records one deduplicated audit row:
`class = tracker_reconcile`, `action = reconcile_keyword_missing_noted`,
`wo_id = <the declared WO>`. No comment is posted. This surfaces the gap -- the
PR claimed a WO but did not carry a keyword, so neither reconcile nor GitHub
closed it. The row is deduplicated per `(pr_ref, wo_id)` so a rescan does not add
a second row.

Read the keyword-missing rows (readonly) with:

```
docker exec archon-app-1 bun -e "import {Database} from 'bun:sqlite'; \
  const db=new Database('/.archon/archon.db',{readonly:true}); \
  console.log(db.query(\"select pr_ref, wo_id, created_at from overseer_reconcile_actions where action='reconcile_keyword_missing_noted' order by created_at desc limit 50\").all())"
```

## The lookback floor

`resolveSearchSince` sets the merged-PR search `since` to the EARLIER of the
reconcile cursor (date of the newest `reconcile_close` or `reconcile_merged_noted` row) and today minus
`RECONCILE_MIN_LOOKBACK_DAYS` (default 7, env-overridable). This guarantees at
least the last 7 days are rescanned, so a PR that merged shortly BEFORE the
newest close is not skipped. The re-close and already-closed guards make the
overlapping rescan idempotent (no second close). The merged-PR search itself
paginates each query to GitHub's 1000-result cap (10 pages of 100), so a PR
beyond the first 100 results is still seen.
