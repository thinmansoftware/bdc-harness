# M-09 promotion check

The Overseer App posts `m09-promotion-gate` on the covered production bases.
The trusted harness reads PR metadata, compare results and bdc-xo at one pinned
main commit. It never reads the PR tree. Each rule is reported as PASS or FAIL.

Supply exactly one PR body block:

```
M-09 promotion:
motion_id: M-20261103c
approved_sha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The motion must uniquely exist under docs/board/motions at the pinned commit.
Explicit motion_id, governs, repository and status fields bind the decision;
malformed or duplicate fields fail. Status is exactly RATIFIED or CARRIED.

Opened, reopened, synchronize and edited events evaluate current PR metadata.
Re-run the check in GitHub, edit the PR body, or call the trusted exported
reevaluatePromotion({repository, number}). The signed existing review webhook
route handles pull_request and check_run rerequested events. Its review secret
and review identity configuration must be present. Authentication requires the
Overseer App installation: Checks write and Pull requests read on covered
repositories, Contents read on bdc-xo. PAT fallback is refused.

Evaluations serialize per repository/head in the single service process; unrelated
heads do not share that queue. Multiple active replicas still require a shared
serialization mechanism. The signed webhook supplies the head so an in-progress
check replaces a previous success before live approval reads. Check lookup is
paginated. Lookup failures publish failure; if listing is unavailable and no
check ID is known, a failing safety check may be created instead of trusting an
old success. Operators should reconcile duplicates after that outage.

Review intake always finishes before promotion IO. Promotion errors cannot skip
review ingestion; exhausted publication errors return an HTTP error after intake
so the webhook can be redelivered safely. There is no detached, lossy background
queue. API calls have a 20-second timeout and up to three attempts, honoring
Retry-After or exponential backoff. A lost create response is reconciled before
retrying creation. Re-run failed/pending checks after an outage, or redeliver the
webhook. GitHub does not automatically redeliver failed webhook deliveries.

If GitHub refuses every write, no service can change an existing remote check;
the request remains failed for operator redelivery. An operator re-evaluation
should supply {repository, number, head, base} from verified metadata so PR lookup
failure can invalidate that head. Without a known head a live PR lookup is needed
first; failure then returns a retryable error instead of guessing a SHA.

The operator must rebuild Overseer and verify one App-owned check on a real
storefront master PR. XO separately asks John to require this App check in
production protection. This WO changes no protection and performs no deploy.
Passing a check alone does not authorize production action. Linux draft-PR CI
is the full gate; local checks do not establish live acceptance.

Reference: shopops-storefront PR 224 head
645efa9925f8e21e344744bdab50bdc1bb0d2a9e, scripts/promote-gate.mjs and fixtures.
The WO's three-line block and seven rules supersede its product-specific Vercel
checks. release/ce is declared production in merge policy to reconcile the
covered-base constant.
