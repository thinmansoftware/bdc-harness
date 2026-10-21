# Taskmaster PR claim verification

The work-SOR reader gathers the complete bounded issue snapshot before selecting
up to ten logical PR-claim lookups. Existing permission fallback may make two
HTTP attempts per lookup; this is not a ten-request transport bound. Existing assignees and building/review labels already
establish a claim and do not consume this lookup budget. Non-WO issue behavior is
unchanged.

WO candidates beyond that budget carry internal
`prClaimVerification: deferred_budget` metadata, with both unclaimed flags omitted.
All source issue facts remain in adoption, but these deferred items cannot generate
fire eligibility calls, nudges, escalations or blocker reports during that tick.
Independent undelivered rulings retain their existing delivery path.

Candidates rotate in stable canonical-reference order across successful reads.
The cursor records only a scheduling position, never positive or negative claim
proof. A failed lookup rejects the read and leaves the cursor and prior committed
projection unchanged. Each selected candidate receives a fresh lookup.

The default cursor is process-local: restarting resets its scheduling position.
Fairness assumes a stable candidate set and successful reads; failures, restarts,
quota holds or source churn can delay verification. A successful tick means the
issue projection was read completely, not that every PR claim was verified.
Deferred work is included in the tick's deferred count. A null adoption owner is
an assignee fact, not proof that no PR exists.

Search scope, index freshness and quota limitations remain. This repair does not
remove Search, change permissions, cache absence, or establish live reliability.
