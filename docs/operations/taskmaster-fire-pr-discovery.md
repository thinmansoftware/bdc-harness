# Taskmaster fire eligibility PR discovery

Date: 2026-10-18. Source proposal for bdc-xo#3258 Defect14; no runtime activation.

The existing fire-eligibility guard freezes the committed canonical spec, verifies
cauldron compatibility and its target repository, and resolves the registered
project before examining PR custody. Those authority gates remain unchanged.

The guard replaces unpaginated Search with all-state REST pulls, sorted by
creation ascending, 100 rows per page. It preserves the existing case-sensitive
exact WO boundary regex and title/body behavior. Matching open or merged PRs
refuse eligibility; closed unmerged PRs do not satisfy the guard. Exclusion
heading semantics are unchanged in this caller.

Every page must be an array of at most 100 rows. Every row must carry a positive
safe PR number, string title, present string-or-null body, known open/closed state
and null or parseable merge timestamp. Open-and-merged contradictions and
conflicting duplicate identities are UNKNOWN. Identical duplicates are allowed.
All pages must be validated before either final result; no early positive claim
hides a later failed page. HTTP, JSON and shape failures throw instead of granting
noOpenOrMergedPr evidence.

The ceiling is 100 pages / 10,000 rows. A full final page is incomplete and throws;
a short final page proves traversal complete. Normal histories beyond 1,000 PRs
are supported. This can cost up to 100 sequential core API calls per repository history read, in addition to existing spec reads. The existing service transport meters
core, preserves authentication and the rate-limit floor; no new meter,
controller or credential fallback is added.

One tick reads each repository's all-state history once per repository per tick
(WO-HARNESS-TASKMASTER-ELIGIBILITY-LISTING-SHARE-01, bdc-xo#5509). The
Taskmaster tick creates one memo, `listingMemo`, and every eligibility check of
that tick shares it: the first check for a repository performs the traversal
above and the rest reuse the validated rows (the exact work-order matching is
still done per check). A traversal that throws or is incomplete is not stored,
so the next check retries, and the memo is dropped when the tick ends. Before
this, each unclaimed thread walked the whole history by itself, which made a
tick (including the one that runs immediately at container start) cost about
2,340 calls an hour in the measurement of 2026-11-11. Check it with the
`github_call_sites` log lines (docs/operations/github-call-sites.md): the
taskmaster total for the hour after a container start. Removing Search here does not prove
lower total traffic or an acceptable live call rate.

The deterministic integration test seeds an exhausted Search resource in the
existing SQLite meter, then executes the default service path with authenticated
REST pagination and verifies two core calls with no Search request. This is local
source evidence with fake HTTP, not a live fire or production acceptance.

Remaining Defect14 work includes Taskmaster expectation and work-SOR claim probes,
Overseer reconcile Search, bounded reset-aware admission waiting/cancellation and
the 60-minute normal-traffic window with zero Search 403 responses plus an authorized
actual recorded workflow run. No merge or deployment is authorized by this patch.
